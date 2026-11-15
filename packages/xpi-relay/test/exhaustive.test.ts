import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	type Effect,
	MAX_REPAIRS,
	type RelayEvent,
	type RelayView,
	relayGraph,
	transition,
} from "../src/definition.ts";

const MAX_ROUNDS = [0, 2];
const WHEN_STUCK = ["lift", "handback"] as const;

/** Every combination of the overlays the machine reads, in both phases, including ones the extension never builds. */
function views(): RelayView[] {
	const all: RelayView[] = [];
	for (const phase of ["lead", "worker"] as const)
		for (const limit of [undefined, "lifted", "asked"] as const)
			for (const pending of [undefined, "handover", "handback"] as const)
				for (const blocked of [false, true])
					for (const userAsked of [false, true])
						for (const paused of [false, true])
							for (let mixups = 0; mixups <= MAX_REPAIRS; mixups++)
								for (let stalls = 0; stalls <= MAX_REPAIRS; stalls++)
									all.push({
										phase,
										round: 3,
										...(limit ? { limit } : {}),
										pending,
										blocked,
										userAsked,
										paused,
										mixups,
										stalls,
									});
	return all;
}

/** Every event with every payload; `attempt` is below, at and above `maxRounds` for each of `MAX_ROUNDS`. */
function events(): RelayEvent[] {
	const all: RelayEvent[] = [];
	for (const byUser of [false, true]) {
		all.push({ type: "handover", byUser });
		for (const status of ["done", "blocked"] as const) all.push({ type: "handback", status, byUser });
	}
	for (const afterRelayError of [false, true])
		for (const handoverLanded of [undefined, true, false])
			for (const workerIdle of [undefined, true, false])
				all.push({ type: "run_end", afterRelayError, handoverLanded, workerIdle });
	for (const passed of [false, true])
		for (let attempt = 0; attempt <= 3; attempt++) all.push({ type: "acceptance", passed, attempt });
	all.push({ type: "model_away" }, { type: "model_back" });
	for (const tool of ["handover", "handback"] as const) all.push({ type: "wrong_role", tool });
	for (const to of ["lifted", "asked"] as const)
		for (const compactions of [4, 6]) all.push({ type: "limit_reached", compactions, to });
	return all;
}

describe("the relay graph, exhaustively", () => {
	it("covers every declared event with the enumeration", () => {
		const covered = new Set(events().map((event) => event.type));
		expect([...covered].sort()).toEqual([...relayGraph.events].sort());
	});

	const EFFECTS: readonly Effect["type"][] = [
		"result",
		"append_entry",
		"run_acceptance",
		"compact_record",
		"continue_with",
		"notify",
		"steer",
	];
	const ENTRIES = [
		"relay.handover",
		"relay.handback",
		"relay.mixup",
		"relay.stall",
		"relay.pause",
		"relay.resume",
		"relay.transition",
		"relay.verify",
		"relay.void",
		"relay.limit",
	];
	const isCount = (value: unknown) => Number.isInteger(value) && (value as number) >= 0;

	it("returns a valid next view and known effects for every combination, without changing its input", () => {
		let combinations = 0;
		const digest = createHash("sha256");
		// The part of the enumeration that existed before the context limit (no limit field, `whenStuck` "lift", no
		// `limit_reached` event), in its old order: its digest must not have changed.
		const legacy = createHash("sha256");
		for (const maxRounds of MAX_ROUNDS) {
			for (const whenStuck of WHEN_STUCK) {
				for (const view of views()) {
					for (const event of events()) {
						const label = JSON.stringify({ view, event, maxRounds, whenStuck });
						const frozen = structuredClone(view);
						const { next, effects } = transition(Object.freeze({ ...view }), event, { maxRounds, whenStuck });
						expect(view, label).toEqual(frozen);
						expect(["lead", "worker"], label).toContain(next.phase);
						expect(isCount(next.round) && isCount(next.mixups) && isCount(next.stalls), label).toBe(true);
						expect([undefined, "handover", "handback"], label).toContain(next.pending);
						expect([undefined, "lifted", "asked"], label).toContain(next.limit);
						expect(
							[next.blocked, next.paused, next.userAsked].every((flag) => typeof flag === "boolean"),
							label,
						).toBe(true);
						for (const effect of effects) {
							expect(EFFECTS, label).toContain(effect.type);
							if (effect.type === "append_entry") expect(ENTRIES, label).toContain(effect.entry);
							if (effect.type === "result") expect(effect.text.length, label).toBeGreaterThan(0);
						}
						// Only a tool call is answered with a result.
						if (event.type === "limit_reached") {
							// The row records the new state of the phase, and a phase change never keeps it.
							expect(next.limit, label).toBe(
								event.to === "asked" && view.phase === "worker" ? "asked" : "lifted",
							);
							expect(
								effects.some((effect) => effect.type === "append_entry" && effect.entry === "relay.limit"),
								label,
							).toBe(true);
						}
						if (!["handover", "handback", "wrong_role"].includes(event.type)) {
							expect(
								effects.some((effect) => effect.type === "result"),
								label,
							).toBe(false);
						}
						digest.update(JSON.stringify([next, effects]));
						if (!view.limit && whenStuck === "lift" && event.type !== "limit_reached") {
							legacy.update(JSON.stringify([next, effects]));
						}
						combinations++;
					}
				}
			}
		}
		// A digest of every output of the enumeration: it pins behaviour now that the reference copy of the old machine is
		// gone. A change of a text or a decision changes it; PR C (the handover result drops its marker line and gains a signal) updated it
		// on purpose. The old machine produced the same outputs (31104 combinations compared before it was deleted).
		expect(legacy.digest("hex")).toBe("dded78713973bfde0149cd5fcb96b597a3902fbd0b2fbded0305a070fac698a3");
		// The whole enumeration, with the stuck guard's row (`limit_reached`), the `limit` field of the view and
		// `whenStuck`: PR E (the worker's context limit) changed it on purpose.
		expect(digest.digest("hex")).toBe("4beecd0f49ca6f39a093e2c995cbd0801e156f0ac7c5c845df6ade0fe6bc0bd4");
		expect(combinations).toBe(MAX_ROUNDS.length * WHEN_STUCK.length * views().length * events().length);
	}, 120_000);
});
