import { describe, expect, it } from "vitest";
import { MAX_REPAIRS, type RelayEvent, type RelayView, relayGraph, transition } from "../src/definition.ts";
import * as reference from "./reference-machine.ts";

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

	it("answers every combination of overlays and events like the reference machine", () => {
		let combinations = 0;
		for (const maxRounds of MAX_ROUNDS) {
			for (const view of views()) {
				for (const event of events()) {
					const config = { maxRounds };
					expect(transition(view, event, config), JSON.stringify({ view, event, config })).toEqual(
						reference.transition(view, event, config),
					);
					combinations++;
				}
			}
		}
		expect(combinations).toBe(MAX_ROUNDS.length * views().length * events().length);
		console.log(`compared ${combinations} combinations`);
	});
});
