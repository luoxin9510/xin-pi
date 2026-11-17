import { describe, expect, it } from "vitest";
import {
	applyStep,
	cleanSteps,
	HANDOVER_ENTRY,
	MAX_STEPS,
	type RelayEntry,
	ROUND_ENTRY,
	readSteps,
	renderSteps,
	STEP_CHARS,
	STEP_ENTRY,
	stepsWidget,
	VOID_ENTRY,
} from "../src/index.ts";

let id = 0;
const custom = (customType: string, data: unknown): RelayEntry => ({
	id: `e${id++}`,
	timestamp: new Date().toISOString(),
	type: "custom",
	customType,
	data,
});
const message = (role: "user" | "assistant", text: string): RelayEntry =>
	({
		id: `e${id++}`,
		timestamp: new Date().toISOString(),
		type: "message",
		message: { role, content: role === "user" ? text : [{ type: "text", text }] },
	}) as unknown as RelayEntry;
const handover = (round: number, steps?: string[]) =>
	custom(HANDOVER_ENTRY, { round, plan: "p", acceptance: [], ...(steps ? { steps } : {}) });
const tick = (round: number, data: Record<string, unknown>) => custom(STEP_ENTRY, { round, ...data });

describe("the step list of a round", () => {
	it("cleans the lead's lines and refuses a wrong shape", () => {
		expect(cleanSteps(undefined)).toBeUndefined();
		expect(cleanSteps([])).toBeUndefined();
		expect(cleanSteps([" add a  test ", "", "fix it\nnow"])).toEqual(["add a test", "fix it now"]);
		// a list marker or number the model put in front goes; a long line is cut: a step is a label
		expect(cleanSteps(["1. add a test", "- [ ] fix it", "(3) run 2 suites", "* 4) docs"])).toEqual([
			"add a test",
			"fix it",
			"run 2 suites",
			"docs",
		]);
		const long = cleanSteps(["x".repeat(500)])![0]!;
		expect(long).toHaveLength(STEP_CHARS);
		expect(long.endsWith("...")).toBe(true);
		expect(() => cleanSteps("one")).toThrow("steps must be a list of strings");
		expect(() => cleanSteps([1])).toThrow("steps must be a list of strings");
		expect(() => cleanSteps(Array(MAX_STEPS + 1).fill("x"))).toThrow(`at most ${MAX_STEPS}`);
	});

	it("reads the latest handover's list with the worker's ticks, skips and additions", () => {
		const branch = [
			handover(1, ["a", "b", "c"]),
			tick(1, { n: 1, status: "done" }),
			tick(1, { n: 2, status: "skipped", note: "not needed" }),
			tick(1, { add: "d" }),
			tick(2, { n: 3, status: "done" }), // another round's: ignored
			tick(1, { n: 9, status: "done" }), // no such step: ignored
		];
		expect(readSteps(branch)).toEqual({
			round: 1,
			handedBack: false,
			closed: false,
			steps: [
				{ text: "a", status: "done", by: "lead" },
				{ text: "b", status: "skipped", note: "not needed", by: "lead" },
				{ text: "c", status: "todo", by: "lead" },
				{ text: "d", status: "todo", by: "worker" },
			],
		});
		expect(renderSteps(readSteps(branch)!.steps)).toEqual([
			"1. [x] a",
			"2. [-] b (skipped: not needed)",
			"3. [ ] c",
			"4. [ ] d (added by the worker)",
		]);
	});

	it("has no list for a handover without steps, also after a round that had one", () => {
		expect(readSteps([handover(1)])).toBeUndefined();
		expect(readSteps([handover(1, ["a"]), handover(2)])).toBeUndefined();
		expect(readSteps([handover(1, ["a"]), handover(2, ["z"])])?.steps[0]?.text).toBe("z");
		// a handover that was voided did not happen
		expect(readSteps([handover(1, ["a"]), custom(VOID_ENTRY, { round: 1 })])).toBeUndefined();
	});

	it("applies one call: a tick by number, a skip with its note, an addition; and says what is open", () => {
		const list = readSteps([handover(1, ["a", "b"])])!;
		expect(applyStep(list, { n: 1, status: "done" })).toEqual({
			data: { n: 1, status: "done" },
			text: "Step 1 done. Open: 2.",
		});
		expect(applyStep(list, { n: 2, status: "skipped", note: " covered  by 1 " })).toEqual({
			data: { n: 2, status: "skipped", note: "covered by 1" },
			text: "Step 2 skipped. Open: 1.",
		});
		// a note with "done" is dropped
		expect(applyStep(list, { n: 1, status: "done", note: "x" }).data).toEqual({ n: 1, status: "done" });
		expect(applyStep(list, { add: " fix the type error " })).toEqual({
			data: { add: "fix the type error" },
			text: "Added step 3. Open: 1, 2, 3.",
		});
		const one = readSteps([handover(1, ["a"])])!;
		expect(applyStep(one, { n: 1, status: "done" }).text).toBe("Step 1 done. No step is open.");
	});

	it("refuses a call it cannot apply, with words the worker can act on", () => {
		const list = readSteps([handover(1, ["a", "b"])])!;
		expect(() => applyStep(undefined, { n: 1, status: "done" })).toThrow("This round has no step list");
		expect(() => applyStep(list, {})).toThrow("n must be a step number from 1 to 2, or give add.");
		expect(() => applyStep(list, { n: 3, status: "done" })).toThrow("from 1 to 2");
		expect(() => applyStep(list, { n: 1.5, status: "done" })).toThrow("from 1 to 2");
		expect(() => applyStep(list, { n: 1 })).toThrow('status must be "done" or "skipped".');
		expect(() => applyStep(list, { n: 1, add: "x" })).toThrow("not both");
		expect(() => applyStep(list, { add: " - " })).toThrow("add is empty");
		const full = readSteps([handover(1, Array(MAX_STEPS).fill("x"))])!;
		expect(() => applyStep(full, { add: "one more" })).toThrow("The list is full");
	});

	it("shows the user who has the work, the count and the steps, the current one marked", () => {
		const branch = [handover(2, ["a", "b", "c"]), tick(2, { n: 1, status: "done" }), tick(2, { add: "d" })];
		expect(stepsWidget(branch, "haiku")).toEqual([
			"relay round 2 · worker (haiku) · 1/4",
			"  ✓ 1 a",
			"  ▸ 2 b",
			"    3 c",
			"    4 d (added by the worker)",
		]);
		expect(stepsWidget([handover(1)], "haiku")).toBeUndefined();
	});

	it("keeps the list after the hand back until the user writes again", () => {
		const branch = [
			handover(1, ["a", "b"]),
			tick(1, { n: 1, status: "done" }),
			tick(1, { n: 2, status: "skipped" }),
			custom(ROUND_ENTRY, { round: 1, line: "Round 1" }),
			message("assistant", "reviewed"),
		];
		expect(stepsWidget(branch, "haiku")).toEqual([
			"relay round 1 · handed back to the lead · 2/2",
			"  ✓ 1 a",
			"  – 2 b (skipped)",
		]);
		expect(stepsWidget([...branch, message("user", "thanks")], "haiku")).toBeUndefined();
	});

	it("folds the closed steps in front of the current one when the list is long", () => {
		const steps = Array.from({ length: 10 }, (_, i) => `s${i + 1}`);
		const branch = [handover(1, steps), ...[1, 2, 3, 4].map((n) => tick(1, { n, status: "done" }))];
		const lines = stepsWidget(branch, "haiku")!;
		expect(lines.slice(0, 3)).toEqual(["relay round 1 · worker (haiku) · 4/10", "  ✓ 1-4 closed", "  ▸ 5 s5"]);
		expect(lines).toHaveLength(8);
	});

	it("never shows more than the title and eight rows: the far end of a long list is counted, not shown", () => {
		const steps = Array.from({ length: 15 }, (_, i) => `s${i + 1}`);
		const fresh = stepsWidget([handover(1, steps)], "haiku")!;
		expect(fresh).toHaveLength(9);
		expect(fresh.slice(0, 2)).toEqual(["relay round 1 · worker (haiku) · 0/15", "  ▸ 1 s1"]);
		expect(fresh.at(-1)).toBe("    +8 more");
		const later = stepsWidget(
			[handover(1, steps), ...[1, 2, 3].map((n) => tick(1, { n, status: "done" }))],
			"haiku",
		)!;
		expect(later).toHaveLength(9);
		expect(later.slice(1, 3)).toEqual(["  ✓ 1-3 closed", "  ▸ 4 s4"]);
		expect(later.at(-1)).toBe("    +6 more");
	});
});
