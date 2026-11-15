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

/** Every combination of the overlays the machine reads, in both phases, including ones the extension never builds. */
function views(): RelayView[] {
	const all: RelayView[] = [];
	for (const phase of ["lead", "worker"] as const)
		for (const pending of [undefined, "handover", "handback"] as const)
			for (const blocked of [false, true])
				for (const userAsked of [false, true])
					for (const paused of [false, true])
						for (let mixups = 0; mixups <= MAX_REPAIRS; mixups++)
							for (let stalls = 0; stalls <= MAX_REPAIRS; stalls++)
								all.push({ phase, round: 3, pending, blocked, userAsked, paused, mixups, stalls });
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
	];
	const isCount = (value: unknown) => Number.isInteger(value) && (value as number) >= 0;

	it("returns a valid next view and known effects for every combination, without changing its input", () => {
		let combinations = 0;
		const digest = createHash("sha256");
		for (const maxRounds of MAX_ROUNDS) {
			for (const view of views()) {
				for (const event of events()) {
					const label = JSON.stringify({ view, event, maxRounds });
					const frozen = structuredClone(view);
					const { next, effects } = transition(Object.freeze({ ...view }), event, { maxRounds });
					expect(view, label).toEqual(frozen);
					expect(["lead", "worker"], label).toContain(next.phase);
					expect(isCount(next.round) && isCount(next.mixups) && isCount(next.stalls), label).toBe(true);
					expect([undefined, "handover", "handback"], label).toContain(next.pending);
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
					if (!["handover", "handback", "wrong_role"].includes(event.type)) {
						expect(
							effects.some((effect) => effect.type === "result"),
							label,
						).toBe(false);
					}
					digest.update(JSON.stringify([next, effects]));
					combinations++;
				}
			}
		}
		// A digest of every output of the enumeration: it pins behaviour now that the reference copy of the old machine is
		// gone. A change of a text or a decision changes it; PR C (the handover result drops its marker line) updates it
		// on purpose. The old machine produced the same outputs (31104 combinations compared before it was deleted).
		expect(digest.digest("hex")).toBe("32fa6292ea78d9eec3f548f51838ec1e5d751f484f1979436d0f6a6a9409b790");
		expect(combinations).toBe(MAX_ROUNDS.length * views().length * events().length);
	});
});
