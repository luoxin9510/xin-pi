import { describe, expect, it } from "vitest";
import { formatError, newErrors, parseCheckOutput } from "../src/extensions/checks/parse.ts";
import type { RunResult } from "../src/extensions/checks/runner.ts";

const CWD = "/work/proj";

function run(output: string, code: number | null = 1, command = "check"): RunResult {
	return { command, output, code, timedOut: false, aborted: false };
}

describe("parseCheckOutput", () => {
	it("parses tsc lines and makes absolute paths relative", () => {
		const errors = parseCheckOutput(
			run(
				"src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.\n/work/proj/src/b.ts(1,1): error TS1005: ';' expected.\n",
			),
			CWD,
		);
		expect(errors).toEqual([
			{
				command: "check",
				file: "src/a.ts",
				line: 3,
				col: 7,
				message: "TS2322: Type 'string' is not assignable to type 'number'.",
			},
			{ command: "check", file: "src/b.ts", line: 1, col: 1, message: "TS1005: ';' expected." },
		]);
	});

	it("parses GitHub annotations: errors count, warnings do not", () => {
		const errors = parseCheckOutput(
			run(
				"::error title=lint/x,file=/work/proj/src/c.ts,line=4,col=2::Unused variable\n::warning file=src/d.ts,line=1,col=1::meh\n",
			),
			CWD,
		);
		expect(errors).toEqual([{ command: "check", file: "src/c.ts", line: 4, col: 2, message: "Unused variable" }]);
	});

	it("parses path:line:col and mypy lines", () => {
		const errors = parseCheckOutput(
			run("src/e.py:10:5: F401 `os` imported but unused\nlib/f.py:7: error: Incompatible types\n"),
			CWD,
		);
		expect(errors).toEqual([
			{ command: "check", file: "src/e.py", line: 10, col: 5, message: "F401 `os` imported but unused" },
			{ command: "check", file: "lib/f.py", line: 7, col: 0, message: "Incompatible types" },
		]);
	});

	it("ignores junk lines when something else matched, even with a non-zero exit", () => {
		const errors = parseCheckOutput(run("Found 1 error.\nsrc/a.ts(1,1): error TS1: bad\nwatching...\n"), CWD);
		expect(errors).toHaveLength(1);
	});

	it("reports nothing for a clean run, and for warnings alone", () => {
		expect(parseCheckOutput(run("all good\n", 0), CWD)).toEqual([]);
		expect(parseCheckOutput(run("::warning file=a.ts,line=1,col=1::w\n", 1), CWD)).toEqual([]);
	});

	it("turns an unparsable non-zero run into one error with the last 20 lines", () => {
		const output = `${Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n")}\n`;
		const errors = parseCheckOutput(run(output, 2), CWD);
		expect(errors).toHaveLength(1);
		expect(errors[0].file).toBe("");
		expect(errors[0].message.split("\n")).toEqual([
			"exit 2",
			...Array.from({ length: 20 }, (_, i) => `line ${i + 11}`),
		]);
	});

	it("skips warnings and notes in the generic formats", () => {
		const output = [
			"a.py:1:1: warning: unused",
			"b.c:2:3: Note: declared here",
			"c.ts:4:5: Unexpected thing [Warning/no-x]",
			"d.py:6: error: real",
			"e.py:7: note: see this",
		].join("\n");
		const errors = parseCheckOutput(run(output), CWD);
		expect(errors.map((e) => e.file)).toEqual(["d.py"]);
		// Recognised lines, so no fallback error either.
		expect(parseCheckOutput(run("a.py:1:1: warning: unused\n"), CWD)).toEqual([]);
	});

	it("treats a process killed by an unexpected signal as an unparsable failure", () => {
		const errors = parseCheckOutput(run("partial\n", null), CWD);
		expect(errors).toHaveLength(1);
		expect(errors[0].message.split("\n")[0]).toBe("signal");
	});

	it("does not invent an error for an unparsable zero exit", () => {
		expect(parseCheckOutput(run("noise\n", 0), CWD)).toEqual([]);
	});
});

describe("newErrors", () => {
	const err = (file: string, message: string, line = 1, command = "c") => ({ command, file, line, col: 1, message });

	it("ignores position: an old error that moved is not new", () => {
		expect(newErrors([err("a.ts", "m", 3)], [err("a.ts", "m", 40)])).toEqual([]);
	});

	it("is new when the file, message or command differs", () => {
		expect(newErrors([err("a.ts", "m")], [err("b.ts", "m")])).toHaveLength(1);
		expect(newErrors([err("a.ts", "m")], [err("a.ts", "n")])).toHaveLength(1);
		expect(newErrors([err("a.ts", "m")], [err("a.ts", "m", 1, "other")])).toHaveLength(1);
	});

	it("counts duplicates: two where there was one is one new error", () => {
		expect(newErrors([err("a.ts", "m", 1)], [err("a.ts", "m", 1), err("a.ts", "m", 9)])).toEqual([
			err("a.ts", "m", 9),
		]);
		expect(newErrors([], [])).toEqual([]);
	});

	it("keeps an unparsed failure the same error while its exit code is the same", () => {
		const a = parseCheckOutput(run("boom 1\n", 2), CWD);
		const b = parseCheckOutput(run("boom 2\n", 2), CWD);
		const c = parseCheckOutput(run("boom 2\n", 3), CWD);
		expect(newErrors(a, b)).toEqual([]);
		expect(newErrors(a, c)).toHaveLength(1);
	});
});

describe("formatError", () => {
	it("writes path:line:col message (command)", () => {
		expect(formatError({ command: "tsc", file: "a.ts", line: 2, col: 3, message: "bad" })).toBe("a.ts:2:3 bad (tsc)");
	});
});
