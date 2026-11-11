// AT-5: the recap's list on attach, without the summary model. Ported from the "away log" part of pi-roost's
// summaries.test.ts (the rest moved to job-events.test.ts or was cut with the summary model, decision 6).
import { describe, expect, it } from "vitest";
import { awayIsEmpty, emptyAway, recapList } from "../src/lib/recap.ts";

describe("away log", () => {
	it("lists turns, tools and the last question", () => {
		const a = emptyAway();
		expect(awayIsEmpty(a)).toBe(true);
		a.turns = 2;
		a.failures = 1;
		a.tools = { bash: 3, edit: 1 };
		a.questions = ["which branch?", "tabs or spaces?"];
		expect(recapList(a)).toBe("2 turns finished (1 failed) · tools: bash ×3, edit · asked: tabs or spaces?");
	});

	it("one turn, many tools, a long question", () => {
		const a = emptyAway();
		a.turns = 1;
		a.tools = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`t${i}`, 8 - i]));
		a.questions = [`${"why ".repeat(60)}?`];
		const text = recapList(a);
		expect(text).toMatch(/^1 turn finished · tools: t0 ×8, t1 ×7, t2 ×6, t3 ×5, t4 ×4, t5 ×3, … · asked: why/);
		expect(text.split("asked: ")[1]!.length).toBeLessThanOrEqual(120);
		expect(awayIsEmpty({ ...emptyAway(), questions: ["q"] })).toBe(false);
	});
});
