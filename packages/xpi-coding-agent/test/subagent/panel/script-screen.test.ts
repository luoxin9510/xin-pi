// Script rows with a description, the tool calls a script makes, and the script screen, against the real registries (no
// pi, no model). Scripts begin on the real codemode controller; nested calls are fed as the `tool_execution_*` events
// pi sends with `parentToolCallId`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { beginCodemodeScript, codemodeScripts } from "../../../src/extensions/codemode/scripts.ts";
import { OUTPUT_LINES, scripts } from "../../../src/extensions/subagent/background.ts";
import { Panel } from "../../../src/extensions/subagent/panel.ts";
import { ScriptScreen } from "../../../src/extensions/subagent/script-screen.ts";

const theme: any = {
	fg: (_c: string, s: string) => s,
	bg: (_c: string, s: string) => `[sel]${s}`,
	bold: (s: string) => s,
};
const KEY = { down: "\x1b[B", up: "\x1b[A", enter: "\r", esc: "\x1b", x: "x", pageUp: "\x1b[5~" };
const ROWS = 24;
const tui: any = { terminal: { rows: ROWS }, requestRender() {} };
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });

function setup(sessionId: string) {
	const delivered: string[] = [];
	const off = scripts.connect({
		sessionId: () => sessionId,
		enabled: () => true,
		deliver: (c) => delivered.push(c),
		parent: () => ({ sessionFile: undefined, sessionId }),
	});
	const opened: string[] = [];
	const panel = new Panel(
		sessionId,
		theme,
		() => {},
		() => {},
		{ lingerMs: 30_000, viewable: true, openScript: (s) => opened.push(s.id) },
	);
	const begin = (callId: string, start: { description?: string; code?: string } = {}) => {
		const run = beginCodemodeScript(callId, sessionId, undefined, start);
		return { run, script: scripts.get(run.info.id)! };
	};
	const start = (callId: string, n: number, name: string, args: Record<string, unknown>) =>
		scripts.nested({
			type: "tool_execution_start",
			toolCallId: `${callId}/${n}`,
			toolName: name,
			args,
			parentToolCallId: callId,
		});
	const update = (callId: string, n: number, name: string, partial: string) =>
		scripts.nested({
			type: "tool_execution_update",
			toolCallId: `${callId}/${n}`,
			toolName: name,
			args: {},
			partialResult: text(partial),
			parentToolCallId: callId,
		});
	const end = (callId: string, n: number, name: string, result: string, isError = false) =>
		scripts.nested({
			type: "tool_execution_end",
			toolCallId: `${callId}/${n}`,
			toolName: name,
			result: text(result),
			isError,
			parentToolCallId: callId,
		});
	const rowOf = (id: string) => panel.render(160).find((l) => l.includes(`(${id})`) || l.includes(`script ${id}`))!;
	return { panel, begin, start, update, end, delivered, opened, rowOf, off };
}

test("a row names the script by description, else its first bash command, else `script S1`; agents and cost only with agents", () => {
	const { panel, begin, start, rowOf, off } = setup("ss1");
	const a = begin("a1", { description: "build and test" });
	start("a1", 1, "bash", { command: "npm test" });
	assert.match(rowOf(a.script.id), /^ {2}● foreground · build and test \(S\d+\) · \d+s · bash npm test$/);

	const b = begin("b1");
	assert.match(rowOf(b.script.id), /^ {2}● foreground · script S\d+ · \d+s$/, "no call yet: the fallback name");
	start("b1", 1, "read", { file_path: "/tmp/x" });
	start("b1", 2, "bash", { command: "make all\nsecond line" });
	assert.match(rowOf(b.script.id), /^ {2}● foreground · make all \(S\d+\) · \d+s · bash make all$/);
	assert.ok(!rowOf(b.script.id).includes("agents running"));
	assert.ok(!rowOf(b.script.id).includes("$0.0000"));
	panel.dispose();
	off();
});

test("calls are recorded in order from nested events: status, duration, label, output tail capped, text only", () => {
	const { begin, start, update, end, off } = setup("ss2");
	const { script } = begin("c1");
	start("c1", 1, "bash", { command: "npm test" });
	const many = Array.from({ length: OUTPUT_LINES + 50 }, (_, i) => `line ${i + 1}`).join("\n");
	update("c1", 1, "bash", many);
	assert.equal(script.calls[0]!.status, "running");
	const lines = script.calls[0]!.output.split("\n");
	assert.equal(lines.length, OUTPUT_LINES);
	assert.equal(lines.at(-1), `line ${OUTPUT_LINES + 50}`);
	assert.equal(lines[0], "line 51");
	end("c1", 1, "bash", "all done");
	start("c1", 2, "read", { file_path: "/tmp/f" });
	end("c1", 2, "read", "boom", true);
	scripts.nested({
		type: "tool_execution_start",
		toolCallId: "c1/1/1",
		toolName: "deep",
		args: {},
		parentToolCallId: "c1/1",
	}); // a call of a call is not the script's own
	scripts.nested({
		type: "tool_execution_start",
		toolCallId: "other/1",
		toolName: "bash",
		args: {},
		parentToolCallId: "other",
	}); // another call id is nobody's
	assert.deepEqual(
		script.calls.map((c) => [c.id, c.name, c.label, c.status]),
		[
			["c1/1", "bash", "npm test", "done"],
			["c1/2", "read", "/tmp/f", "error"],
		],
	);
	assert.equal(script.calls[0]!.output, "all done");
	assert.ok(script.calls[0]!.endedAt! >= script.calls[0]!.startedAt);
	scripts.nested({
		type: "tool_execution_update",
		toolCallId: "c1/2",
		toolName: "read",
		args: {},
		partialResult: { content: [{ type: "image", data: "x", mimeType: "image/png" }], details: {} },
		parentToolCallId: "c1",
	});
	off();
});

test("the end message names the description; without one it is unchanged", () => {
	const { begin, delivered, off } = setup("ss3");
	const a = begin("d1", { description: "build and test" });
	codemodeScripts.background(a.script.id);
	a.run.end({ result: text("ok") });
	assert.match(delivered[0]!, /^Background script S\d+ \(build and test\) completed\.\nReturn value:\nok/);
	const b = begin("d2");
	codemodeScripts.background(b.script.id);
	b.run.end({ result: text("ok") });
	assert.match(delivered[1]!, /^Background script S\d+ completed\./);
	off();
});

test("an ended script keeps its result, and calls still running end as errors", () => {
	const { begin, start, off } = setup("ss4");
	const { run, script } = begin("e1");
	start("e1", 1, "bash", { command: "sleep 99" });
	run.end({ error: new Error("boom") });
	assert.equal(script.state, "failed");
	assert.equal(script.result, "boom");
	assert.equal(script.calls[0]!.status, "error");
	off();
});

test("Enter on a script row opens its screen", () => {
	const { panel, begin, opened, off } = setup("ss5");
	const { script } = begin("f1");
	panel.handleKey(KEY.down, true); // focus the panel
	panel.handleKey(KEY.enter, true);
	assert.deepEqual(opened, [script.id]);
	panel.dispose();
	off();
});

test("the screen renders header, calls, log, code, live output and result; scrolls; Esc goes back; x stops the script", async () => {
	const { begin, start, update, end, off } = setup("ss6");
	const { run, script } = begin("g1", {
		description: "build and test",
		code: "const r = await tools.bash({command:'npm test'});\nreturn r;",
	});
	scripts.note(script, { log: "starting" });
	start("g1", 1, "bash", { command: "npm run build" });
	end("g1", 1, "bash", "built");
	start("g1", 2, "bash", { command: "npm test" });
	update("g1", 2, "bash", "PASS a\nPASS b");
	let left = 0;
	const screen = new ScriptScreen(tui, theme, script.id, () => left++);
	let out = screen.render(100).join("\n");
	assert.match(out, /build and test \(S\d+\)/);
	assert.match(out, /● running|● foreground/);
	assert.match(out, /✓ bash npm run build/);
	assert.match(out, /● bash npm test/);
	assert.match(out, /Log[\s\S]*starting/);
	assert.match(out, /Code[\s\S]*tools\.bash/);
	assert.match(out, /Output of bash npm test[\s\S]*PASS a\n? *PASS b/);
	assert.match(out, /x stop the script/);

	// output grows live
	update("g1", 2, "bash", "PASS a\nPASS b\nPASS c");
	assert.match(screen.render(100).join("\n"), /PASS c/);

	// scrolling up moves away from the live end; the screen is always at most the terminal's height
	for (let i = 0; i < 6; i++) update("g1", 2, "bash", Array.from({ length: 80 }, (_, n) => `row ${n}`).join("\n"));
	const bottom = screen.render(100);
	assert.ok(bottom.length <= ROWS);
	screen.handleInput(KEY.pageUp);
	const scrolled = screen.render(100);
	assert.notDeepEqual(scrolled, bottom);
	assert.match(scrolled.at(-1)!, /lines above the end/);

	// x stops the running script through the registry: it ends stopped
	screen.handleInput(KEY.x);
	await new Promise((r) => setTimeout(r, 30));
	assert.ok(run.signal.aborted, "x aborts the script");
	run.end({});
	screen.handleInput("\x1b[F"); // end: back to the live end
	out = screen.render(100).join("\n");
	assert.match(out, /■ stopped/);
	assert.match(out, /Stopped/);
	assert.ok(!out.includes("x stop the script"));

	screen.handleInput(KEY.esc);
	assert.equal(left, 1, "Esc goes back");
	screen.dispose();
	off();
});

test("the screen shows the result of a completed script and the error of a failed one", () => {
	const { begin, start, end, off } = setup("ss7");
	const ok = begin("h1");
	start("h1", 1, "bash", { command: "echo hi" });
	end("h1", 1, "bash", "hi");
	ok.run.end({ result: text("2 tests passed") });
	const done = new ScriptScreen(tui, theme, ok.script.id, () => {});
	let out = done.render(100).join("\n");
	assert.match(out, /✓ completed/);
	assert.match(out, /Result\n *2 tests passed/);
	const bad = begin("h2");
	bad.run.end({ error: new Error("it broke") });
	const failed = new ScriptScreen(tui, theme, bad.script.id, () => {});
	out = failed.render(100).join("\n");
	assert.match(out, /✗ failed/);
	assert.match(out, /Error\n *it broke/);
	done.dispose();
	failed.dispose();
	off();
});
