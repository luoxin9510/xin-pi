import { describe, expect, it } from "vitest";
import {
	type Effect,
	effectiveState,
	initialView,
	MAX_REPAIRS,
	type RelayEvent,
	type RelayView,
	transition,
} from "../src/extensions/relay/machine.ts";

/** The transition table of docs/relay.md: every (view, event) pair has an expectation here. */

const config = { maxRounds: 2 };
const lead = (extra: Partial<RelayView> = {}): RelayView => ({ ...initialView({ phase: "lead", round: 1 }), ...extra });
const worker = (extra: Partial<RelayView> = {}): RelayView => ({
	...initialView({ phase: "worker", round: 2 }),
	...extra,
});
const paused = worker({ paused: true });

const VIEWS: Record<string, RelayView> = {
	lead: lead(),
	"lead, one mixup": lead({ mixups: 1 }),
	"lead, stalls 1": lead({ stalls: 1 }),
	"lead, stalls 2": lead({ stalls: MAX_REPAIRS }),
	"lead, pending handover": lead({ pending: "handover" }),
	worker: worker(),
	"worker, one mixup": worker({ mixups: 1 }),
	"worker, stalls 1": worker({ stalls: 1 }),
	"worker, stalls 2": worker({ stalls: MAX_REPAIRS }),
	"worker, pending handback": worker({ pending: "handback" }),
	"worker, pending blocked handback": worker({ pending: "handback", blocked: true }),
	"worker, user asked": worker({ userAsked: true }),
	paused,
};

const EVENTS: Record<string, RelayEvent> = {
	"handover (tool)": { type: "handover", byUser: false },
	"handover (user)": { type: "handover", byUser: true },
	"handback done (tool)": { type: "handback", status: "done", byUser: false },
	"handback blocked (tool)": { type: "handback", status: "blocked", byUser: false },
	"handback (user)": { type: "handback", status: "blocked", byUser: true },
	run_end: { type: "run_end", afterRelayError: false },
	"run_end after relay error": { type: "run_end", afterRelayError: true },
	"acceptance passed": { type: "acceptance", passed: true, attempt: 0 },
	"acceptance failed, first": { type: "acceptance", passed: false, attempt: 0 },
	"acceptance failed, last": { type: "acceptance", passed: false, attempt: config.maxRounds },
	model_away: { type: "model_away" },
	model_back: { type: "model_back" },
	"wrong_role handover": { type: "wrong_role", tool: "handover" },
	"wrong_role handback": { type: "wrong_role", tool: "handback" },
};

const kinds = (effects: readonly Effect[]) =>
	effects.map((effect) => (effect.type === "append_entry" ? `entry:${effect.entry}` : effect.type));
const result = (effects: readonly Effect[]) => effects.find((effect) => effect.type === "result");

describe("relay machine", () => {
	it("decides every (view, event) pair without changing its input, and stays a valid view", () => {
		for (const [viewName, view] of Object.entries(VIEWS)) {
			for (const [eventName, event] of Object.entries(EVENTS)) {
				const before = JSON.stringify(view);
				const { next, effects } = transition(view, event, config);
				expect(JSON.stringify(view), `${viewName} / ${eventName} changed its input`).toBe(before);
				expect(["lead", "worker"], `${viewName} / ${eventName}`).toContain(next.phase);
				expect(next.mixups).toBeGreaterThanOrEqual(0);
				expect(next.stalls).toBeGreaterThanOrEqual(0);
				// A refusal is an error result with no entry, and changes nothing.
				const refused =
					result(effects)?.isError === true && !effects.some((effect) => effect.type === "append_entry");
				if (refused) expect(next, `${viewName} / ${eventName}`).toEqual(view);
			}
		}
	});

	describe("hand tools", () => {
		it("lead | handover: pending worker, round + 1; the result is the marker and ends the turn", () => {
			const { next, effects } = transition(lead(), EVENTS["handover (tool)"], config);
			expect(next.pending).toBe("handover");
			expect(effectiveState(next)).toEqual({ phase: "worker", round: 2 });
			expect(kinds(effects)).toEqual(["entry:relay.handover", "result"]);
			expect(result(effects)).toEqual({ type: "result", text: '<relay-handover round="2"/>', terminate: true });
		});

		it("lead | handover by the user: the same row without a tool result", () => {
			const { next, effects } = transition(lead({ mixups: 1, stalls: 1 }), EVENTS["handover (user)"], config);
			expect(next).toMatchObject({ pending: "handover", mixups: 0, stalls: 0 });
			expect(kinds(effects)).toEqual(["entry:relay.handover"]);
		});

		it("a handover resets mixups and stalls", () => {
			const { next } = transition(lead({ mixups: 1, stalls: 2 }), EVENTS["handover (tool)"], config);
			expect([next.mixups, next.stalls]).toEqual([0, 0]);
		});

		it("worker | handback: pending hand back; 'Handed back.' ends the turn", () => {
			const { next, effects } = transition(worker(), EVENTS["handback done (tool)"], config);
			expect(next).toMatchObject({ pending: "handback", blocked: false });
			expect(effectiveState(next)).toEqual({ phase: "lead", round: 2 });
			expect(kinds(effects)).toEqual(["entry:relay.handback", "result"]);
			expect(result(effects)).toEqual({ type: "result", text: "Handed back.", terminate: true });
			expect(transition(worker(), EVENTS["handback blocked (tool)"], config).next.blocked).toBe(true);
		});

		it("any view with a pending hand-off | handover / handback: unchanged, 'already', not an error", () => {
			for (const view of [
				VIEWS["lead, pending handover"],
				VIEWS["worker, pending handback"],
				VIEWS["worker, pending blocked handback"],
			]) {
				for (const name of ["handover (tool)", "handover (user)", "handback done (tool)", "handback (user)"]) {
					const { next, effects } = transition(view, EVENTS[name], config);
					expect(next).toEqual(view);
					expect(kinds(effects)).toEqual(["result"]);
					expect(result(effects)).toMatchObject({ text: expect.stringMatching(/^Already handed (over|back)\.$/) });
					expect(result(effects)?.isError).toBeUndefined();
					expect(result(effects)?.terminate).toBeUndefined();
				}
			}
		});

		it("words 'already' from what is pending, whichever tool is called, in every role", () => {
			const cases = [
				[VIEWS["lead, pending handover"], "Already handed over."],
				[VIEWS["worker, pending handback"], "Already handed back."],
				[VIEWS["worker, pending blocked handback"], "Already handed back."],
			] as const;
			for (const [view, text] of cases) {
				for (const name of ["handover (tool)", "handback done (tool)", "handover (user)", "handback (user)"]) {
					expect(result(transition(view, EVENTS[name], config).effects)).toMatchObject({ text });
				}
			}
		});

		it("refuses a handover in the worker's phase and a hand back in the lead's, and in a pause", () => {
			expect(result(transition(worker(), EVENTS["handover (user)"], config).effects)).toMatchObject({
				isError: true,
			});
			expect(result(transition(lead(), EVENTS["handback done (tool)"], config).effects)).toMatchObject({
				isError: true,
			});
			expect(result(transition(lead(), EVENTS["handback (user)"], config).effects)).toMatchObject({ isError: true });
			for (const name of ["handover (tool)", "handback done (tool)"]) {
				expect(result(transition(paused, EVENTS[name], config).effects)).toMatchObject({ isError: true });
			}
		});

		it("/handback sets the user flag and steers the worker; it writes no hand back", () => {
			const { next, effects } = transition(worker(), EVENTS["handback (user)"], config);
			expect(next).toMatchObject({ userAsked: true });
			expect(next.pending).toBeUndefined();
			expect(kinds(effects)).toEqual(["steer"]);
		});
	});

	describe("wrong role", () => {
		it("worker | handover, no mixup yet: mixups 1, an error result with the correction", () => {
			const { next, effects } = transition(worker(), EVENTS["wrong_role handover"], config);
			expect(next.mixups).toBe(1);
			expect(next.pending).toBeUndefined();
			expect(kinds(effects)).toEqual(["entry:relay.mixup", "result", "notify"]);
			expect(result(effects)).toMatchObject({ isError: true });
		});

		it("worker | handover, one mixup: a blocked hand back for the model, and the turn ends", () => {
			const { next, effects } = transition(VIEWS["worker, one mixup"], EVENTS["wrong_role handover"], config);
			expect(next).toMatchObject({ pending: "handback", blocked: true, mixups: 2 });
			expect(kinds(effects)).toEqual(["entry:relay.mixup", "entry:relay.handback", "result", "notify"]);
			expect(effects[1]).toMatchObject({
				data: { status: "blocked", report: "The worker mixed up its role twice" },
			});
			expect(result(effects)).toMatchObject({ terminate: true });
			expect(result(effects)?.isError).toBeUndefined();
		});

		it("lead | handback: mixups + 1, an error result; there is no automatic hand back for the lead", () => {
			for (const name of ["lead", "lead, one mixup", "lead, stalls 2"]) {
				const view = VIEWS[name];
				const { next, effects } = transition(view, EVENTS["wrong_role handback"], config);
				expect(next).toEqual({ ...view, mixups: view.mixups + 1 });
				expect(kinds(effects)).toEqual(["entry:relay.mixup", "result", "notify"]);
				expect(result(effects)).toMatchObject({ isError: true });
			}
		});

		it("refuses the pairs that name no row: the wrong tool for the view, a pending hand-off, a pause", () => {
			for (const [view, event] of [
				[lead(), "wrong_role handover"],
				[worker(), "wrong_role handback"],
				[VIEWS["lead, pending handover"], "wrong_role handback"],
				[VIEWS["worker, pending handback"], "wrong_role handover"],
				[paused, "wrong_role handover"],
			] as const) {
				const { next, effects } = transition(view, EVENTS[event], config);
				expect(next).toEqual(view);
				expect(result(effects)).toMatchObject({ isError: true });
			}
		});
	});

	describe("run end", () => {
		it("worker | run_end with a pending hand back: acceptance", () => {
			const { next, effects } = transition(VIEWS["worker, pending handback"], EVENTS.run_end, config);
			expect(kinds(effects)).toEqual(["run_acceptance"]);
			expect(next).toEqual(VIEWS["worker, pending handback"]);
		});

		it("worker | run_end with a pending blocked hand back, or after /handback: no acceptance, the lead gets the record", () => {
			for (const name of ["worker, pending blocked handback", "worker, user asked"]) {
				const { next, effects } = transition(VIEWS[name], EVENTS.run_end, config);
				expect(kinds(effects)).toEqual(["compact_record", "entry:relay.transition"]);
				expect(effects[1]).toMatchObject({ data: { from: "worker", to: "lead", round: 2 } });
				expect(next).toMatchObject({ phase: "lead", mixups: 0, stalls: 0, blocked: false, userAsked: false });
				expect(next.pending).toBeUndefined();
			}
		});

		it("worker | run_end (otherwise): acceptance", () => {
			for (const name of ["worker", "worker, one mixup"]) {
				expect(kinds(transition(VIEWS[name], EVENTS.run_end, config).effects)).toEqual(["run_acceptance"]);
			}
		});

		it("the pending hand back row wins over the relay error rows", () => {
			const view = worker({ pending: "handback", stalls: MAX_REPAIRS });
			expect(kinds(transition(view, EVENTS["run_end after relay error"], config).effects)).toEqual([
				"run_acceptance",
			]);
		});

		it("worker | run_end after a relay error, stalls < 2: stalls + 1, continue with a role reminder", () => {
			for (const name of ["worker", "worker, stalls 1"]) {
				const view = VIEWS[name];
				const { next, effects } = transition(view, EVENTS["run_end after relay error"], config);
				expect(next.stalls).toBe(view.stalls + 1);
				expect(kinds(effects)).toEqual(["entry:relay.stall", "notify", "continue_with"]);
				expect(effects.at(-1)).toEqual({ type: "continue_with", kind: "role_reminder" });
			}
		});

		it("worker | run_end after a relay error, stalls = 2: a blocked hand back and the record", () => {
			const { next, effects } = transition(VIEWS["worker, stalls 2"], EVENTS["run_end after relay error"], config);
			expect(kinds(effects)).toEqual(["entry:relay.handback", "notify", "compact_record", "entry:relay.transition"]);
			expect(effects[0]).toMatchObject({
				data: { status: "blocked", report: "The worker stopped after relay errors" },
			});
			expect(next.phase).toBe("lead");
		});

		it("lead | run_end after a relay error, stalls < 2: stalls + 1, continue with a role reminder", () => {
			for (const name of ["lead", "lead, stalls 1"]) {
				const view = VIEWS[name];
				const { next, effects } = transition(view, EVENTS["run_end after relay error"], config);
				expect(next.stalls).toBe(view.stalls + 1);
				expect(kinds(effects)).toEqual(["entry:relay.stall", "notify", "continue_with"]);
			}
		});

		it("lead | run_end after a relay error, stalls = 2: unchanged, the run ends", () => {
			const { next, effects } = transition(VIEWS["lead, stalls 2"], EVENTS["run_end after relay error"], config);
			expect(next).toEqual(VIEWS["lead, stalls 2"]);
			expect(effects).toEqual([]);
		});

		it("lead | run_end (otherwise): nothing", () => {
			for (const name of ["lead", "lead, one mixup"]) {
				expect(transition(VIEWS[name], EVENTS.run_end, config)).toEqual({ next: VIEWS[name], effects: [] });
			}
		});

		it("lead | run_end with a pending handover: the worker answers next (the handover ended the lead's turn)", () => {
			for (const name of ["run_end", "run_end after relay error"]) {
				const { next, effects } = transition(VIEWS["lead, pending handover"], EVENTS[name], config);
				expect(next).toEqual(VIEWS["lead, pending handover"]);
				expect(effects).toEqual([{ type: "continue_with", kind: "worker_starts" }]);
			}
		});

		it("lead | run_end with a pending handover whose call was cut off: voided, the worker does not start", () => {
			const view = VIEWS["lead, pending handover"];
			const { next, effects } = transition(
				view,
				{ type: "run_end", afterRelayError: false, handoverLanded: false },
				config,
			);
			expect(next.pending).toBeUndefined();
			expect(kinds(effects)).toEqual(["entry:relay.void", "notify"]);
		});

		it("worker | run_end with a blocked hand back whose pending state is gone: still no acceptance", () => {
			const { effects } = transition(worker({ blocked: true }), EVENTS.run_end, config);
			expect(kinds(effects)).toEqual(["compact_record", "entry:relay.transition"]);
		});

		it("paused | run_end: nothing", () => {
			for (const name of ["run_end", "run_end after relay error"]) {
				expect(transition(paused, EVENTS[name], config)).toEqual({ next: paused, effects: [] });
			}
		});
	});

	describe("acceptance", () => {
		it("worker | failed, attempt < maxRounds: unchanged, continue with the failure output", () => {
			for (const attempt of [0, 1]) {
				const { next, effects } = transition(worker(), { type: "acceptance", passed: false, attempt }, config);
				expect(next).toEqual(worker());
				expect(kinds(effects)).toEqual(["entry:relay.verify", "notify", "continue_with"]);
				expect(effects.at(-1)).toEqual({ type: "continue_with", kind: "acceptance_failure" });
			}
		});

		it("worker | passed, failed at maxRounds, or skipped: the lead, mixups 0, stalls 0, compact to the record", () => {
			for (const event of ["acceptance passed", "acceptance failed, last"]) {
				const { next, effects } = transition(
					worker({ mixups: 1, stalls: 1, pending: "handback" }),
					EVENTS[event],
					config,
				);
				expect(next).toMatchObject({ phase: "lead", round: 2, mixups: 0, stalls: 0 });
				expect(next.pending).toBeUndefined();
				expect(kinds(effects)).toEqual(["compact_record", "entry:relay.transition"]);
			}
		});

		it("is refused in every other view", () => {
			for (const name of ["lead", "lead, pending handover", "paused"]) {
				for (const event of ["acceptance passed", "acceptance failed, first", "acceptance failed, last"]) {
					expect(transition(VIEWS[name], EVENTS[event], config)).toEqual({ next: VIEWS[name], effects: [] });
				}
			}
		});
	});

	describe("model switch", () => {
		it("worker | model_away: paused, a pause entry and a notification", () => {
			const { next, effects } = transition(worker(), EVENTS.model_away, config);
			expect(next.paused).toBe(true);
			expect(kinds(effects)).toEqual(["entry:relay.pause", "notify"]);
			expect(effects[1]).toMatchObject({ text: "relay paused (worker phase, round 2)" });
		});

		it("paused | model_back: the worker, a resume entry and 'relay resumed (worker phase, round N)'", () => {
			const { next, effects } = transition(paused, EVENTS.model_back, config);
			expect(next).toMatchObject({ phase: "worker", paused: false });
			expect(kinds(effects)).toEqual(["entry:relay.resume", "notify"]);
			expect(effects[1]).toMatchObject({ text: "relay resumed (worker phase, round 2)" });
		});

		it("lead | model_away / model_back: unchanged, no effects; the same for a pause that is already on", () => {
			for (const name of ["lead", "lead, pending handover"]) {
				for (const event of ["model_away", "model_back"]) {
					expect(transition(VIEWS[name], EVENTS[event], config)).toEqual({ next: VIEWS[name], effects: [] });
				}
			}
			expect(transition(paused, EVENTS.model_away, config)).toEqual({ next: paused, effects: [] });
			expect(transition(worker(), EVENTS.model_back, config)).toEqual({ next: worker(), effects: [] });
		});
	});
});
