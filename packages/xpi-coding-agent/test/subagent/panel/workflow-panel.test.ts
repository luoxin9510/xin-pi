// The panel and workflows (spec 02): a script row names its workflow and shows its last log line, its agents are
// grouped under their phase titles, and `s` on a script row asks to save it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { beginCodemodeScript } from "../../../src/extensions/codemode/scripts.ts";
import { type ScriptRecord, scripts } from "../../../src/extensions/subagent/background.ts";
import { Panel } from "../../../src/extensions/subagent/panel.ts";
import { registry } from "../../../src/extensions/subagent/registry.ts";

const theme: any = {
	fg: (_c: string, s: string) => s,
	bg: (_c: string, s: string) => `[sel]${s}`,
	bold: (s: string) => s,
};
const DOWN = "\x1b[B";

function agent(sessionId: string, id: string) {
	registry.begin({ thinking: "off", cwd: "/tmp", trusted: true, sessionId } as any, {
		id,
		type: "Explore",
		description: id,
		model: "m",
		thinking: "off",
	});
}

function setup(sessionId: string, callId: string) {
	const off = scripts.connect({
		sessionId: () => sessionId,
		enabled: () => true,
		deliver: () => {},
		parent: () => ({ sessionFile: undefined, sessionId }),
	});
	const run = beginCodemodeScript(callId, sessionId, undefined);
	const saved: ScriptRecord[] = [];
	const panel = new Panel(
		sessionId,
		theme,
		() => {},
		() => {},
		{ lingerMs: 30_000, viewable: true, save: (s) => saved.push(s) },
	);
	const done = () => {
		panel.dispose();
		run.end({});
		off();
	};
	return { panel, saved, done, record: scripts.list(sessionId)[0]! };
}

test("a workflow's row names it and shows the last log line; agents are grouped under their phases", () => {
	const { panel, record, done } = setup("wp1", "workflow:greet:k1-1");
	for (const [id, phase] of [
		["wp1-a", "find"],
		["wp1-b", "fix"],
		["wp1-c", "find"],
		["wp1-d", undefined],
	] as const) {
		agent("wp1", id);
		scripts.addAgent("workflow:greet:k1-1/1", id, phase);
	}
	scripts.note(record, { log: "halfway there" });
	const lines = panel.render(200);
	const rowOf = (text: string) => lines.findIndex((l) => l.includes(text));
	assert.match(lines[rowOf("workflow greet")]!, /workflow greet \(S\d+\).*halfway there/);
	const order = ["    find", "wp1-a", "wp1-c", "    fix", "wp1-b", "wp1-d"].map((text) =>
		lines.findIndex((l) => (text.startsWith(" ") ? l === text : l.includes(text))),
	);
	assert.ok(
		order.every((n) => n > 0),
		JSON.stringify(lines),
	);
	assert.deepEqual(
		[...order].sort((a, b) => a - b),
		order,
		JSON.stringify(lines),
	);
	assert.equal(lines.filter((l) => l.trim() === "find").length, 1, "one title per phase");
	done();
});

test("`s` on a script row hands it to save; on an agent row it is pi's key", () => {
	const { panel, saved, record, done } = setup("wp2", "call-wp2");
	agent("wp2", "wp2-a");
	scripts.addAgent("call-wp2/1", "wp2-a");
	assert.equal(panel.handleKey("s", true), false, "not focused: the key belongs to pi");
	panel.handleKey(DOWN, true);
	assert.match(panel.render(200).at(-1)!, /s save as workflow/);
	assert.equal(panel.handleKey("s", true), true);
	assert.deepEqual(saved, [record]);
	assert.equal(panel.hasFocus(), false, "the dialogs take the keyboard");
	panel.handleKey(DOWN, true);
	panel.handleKey(DOWN, true); // the agent row
	assert.doesNotMatch(panel.render(200).at(-1)!, /save as workflow/);
	assert.equal(panel.handleKey("s", true), false);
	assert.equal(saved.length, 1);
	done();
});
