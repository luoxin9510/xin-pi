// The panel's rows and focus rules against the real registry, no pi and no model: what the widget would draw, and what
// the key hook would consume. The real terminal is covered in test/tui/.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Panel } from "../../../src/extensions/subagent/panel.ts";
import { registry } from "../../../src/extensions/subagent/registry.ts";

const theme: any = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => `[sel]${s}` };
const parent = (sessionId: string) => ({ thinking: "off", cwd: "/tmp", trusted: true, sessionId });
const start = (sessionId: string, id: string, description: string) => {
	registry.begin(parent(sessionId), { id, type: "Explore", description, model: "m", thinking: "off" });
};
const KEY = { down: "\x1b[B", up: "\x1b[A", esc: "\x1b", enter: "\r" };

function setup(sessionId: string, options: { lingerMs?: number; viewable?: boolean } = {}) {
	const opened: string[] = [];
	let renders = 0;
	const panel = new Panel(
		sessionId,
		theme,
		() => renders++,
		(r) => opened.push(r.id),
		{ lingerMs: 30_000, viewable: true, ...options },
	);
	return { panel, opened, renders: () => renders };
}

test("hidden when empty; a running row shows type, description, status, turns, last tool and cost", () => {
	const { panel } = setup("p1");
	assert.deepEqual(panel.render(100), []);
	start("p1", "a1", "find it");
	registry.progress("a1", { turns: 3, lastTool: "grep" });
	const text = panel.render(100).join("\n");
	for (const part of ["Explore(find it)", "running", "3 turns", "grep", "$0.0000"])
		assert.ok(text.includes(part), `${part} in:\n${text}`);
	panel.dispose();
});

test("failed and stopped rows are marked; finished rows drop after the linger, and the panel hides again", async () => {
	const { panel, renders } = setup("p2", { lingerMs: 150 });
	start("p2", "b1", "one");
	start("p2", "b2", "two");
	start("p2", "b3", "three");
	registry.finish("b1", "failed");
	registry.finish("b2", "stopped");
	const text = panel.render(100).join("\n");
	assert.match(text, /✗ failed · Explore\(one\)/);
	assert.match(text, /■ stopped · Explore\(two\)/);
	assert.match(text, /● running · Explore\(three\)/);
	const before = renders();
	await new Promise((r) => setTimeout(r, 300));
	const later = panel.render(100).join("\n");
	assert.ok(!later.includes("one") && !later.includes("two"), later);
	assert.ok(later.includes("three"), "running rows stay");
	assert.ok(renders() > before, "the panel asked for a redraw when the rows expired");
	registry.finish("b3", "completed");
	await new Promise((r) => setTimeout(r, 300));
	assert.deepEqual(panel.render(100), []);
	panel.dispose();
});

test("focus: only ↓ on an empty editor enters; its keys are consumed only while focused; Esc and ↑ above the first row leave", () => {
	const { panel, opened } = setup("p3");
	assert.equal(panel.handleKey(KEY.down, true), false, "no rows, nothing to focus");
	start("p3", "c1", "one");
	start("p3", "c2", "two");
	assert.equal(panel.handleKey(KEY.down, false), false, "editor has text");
	assert.equal(panel.handleKey("x", true), false, "other keys are not ours");
	assert.equal(panel.hasFocus(), false);

	assert.equal(panel.handleKey(KEY.down, true), true);
	assert.equal(panel.hasFocus(), true);
	assert.ok(
		panel.render(100).some((l) => l.startsWith("[sel]▸")),
		"the selected row is highlighted",
	);
	assert.equal(panel.handleKey("x", true), true, "x stops the selected row and is consumed");

	panel.handleKey(KEY.down, true);
	panel.handleKey(KEY.down, true); // stays on the last row
	assert.ok(panel.render(100).some((l) => l.startsWith("[sel]▸") && l.includes("Explore(two)")));
	panel.handleKey(KEY.enter, true);
	assert.deepEqual(opened, ["c2"], "Enter opens the selected row");

	panel.handleKey(KEY.up, true);
	assert.equal(panel.hasFocus(), true, "↑ from the second row only moves");
	panel.handleKey(KEY.up, true);
	assert.equal(panel.hasFocus(), false, "↑ above the first row leaves");
	assert.equal(panel.handleKey(KEY.up, true), false);

	panel.handleKey(KEY.down, true);
	assert.equal(panel.handleKey(KEY.esc, true), true);
	assert.equal(panel.hasFocus(), false, "Esc leaves");
	panel.dispose();
});

test("kitty key releases do nothing: one ↓ press selects the first row, a release neither moves nor leaves", () => {
	// Terminals with the kitty keyboard protocol send a release after each press; pi's input listeners get both.
	const release = { down: "\x1b[1;1:3B", up: "\x1b[1;1:3A", enter: "\x1b[13;1:3u" };
	const { panel, opened } = setup("p-kitty");
	start("p-kitty", "k1", "one");
	start("p-kitty", "k2", "two");
	assert.equal(panel.handleKey(release.down, true), false, "a release alone does not focus");
	assert.equal(panel.hasFocus(), false);

	panel.handleKey(KEY.down, true);
	assert.equal(panel.handleKey(release.down, true), true, "the release of the focusing ↓ is consumed");
	assert.equal(panel.hasFocus(), true);
	assert.ok(
		panel.render(100).some((l) => l.startsWith("[sel]▸") && l.includes("Explore(one)")),
		"still on the first row",
	);

	panel.handleKey(KEY.down, true);
	panel.handleKey(release.down, true);
	assert.ok(
		panel.render(100).some((l) => l.startsWith("[sel]▸") && l.includes("Explore(two)")),
		"one press, one row",
	);
	panel.handleKey(KEY.up, true);
	panel.handleKey(release.up, true);
	assert.equal(panel.hasFocus(), true, "the release of ↑ does not leave from the first row");
	panel.handleKey(release.enter, true);
	assert.deepEqual(opened, [], "a release does not open");
	panel.dispose();
});

test("keys the panel does not use pass through while focused (ctrl+c, ctrl+d, text) and give the focus back", () => {
	for (const key of ["\x03", "\x04", "a"]) {
		const session = `p4-${key.charCodeAt(0)}`;
		const { panel } = setup(session);
		start(session, `d${key.charCodeAt(0)}`, "one");
		panel.handleKey(KEY.down, true);
		assert.equal(panel.hasFocus(), true);
		assert.equal(panel.handleKey(key, true), false, `${JSON.stringify(key)} reaches pi`);
		assert.equal(panel.hasFocus(), false, "the editor has the keyboard again");
		panel.dispose();
	}
});

test("an in-memory parent: the panel lists no rows, shows the 'cannot be viewed' notice, and takes no focus", () => {
	const { panel, opened } = setup("p5", { viewable: false });
	assert.deepEqual(panel.render(100), [], "no subagents, no notice");
	start("p5", "e1", "one");
	const text = panel.render(100).join("\n");
	assert.match(text, /cannot be viewed/);
	assert.ok(!text.includes("Explore(one)"), text);
	assert.equal(panel.handleKey(KEY.down, true), false);
	assert.deepEqual(opened, []);
	panel.dispose();
});

test("rows rebuilt from disk, including a run that died while 'running', do not show as fresh rows; a live run does", () => {
	const dir = mkdtempSync(join(tmpdir(), "subagent-panel-"));
	const sub = join(dir, "subagents", "p6");
	mkdirSync(sub, { recursive: true });
	writeFileSync(
		join(sub, "old1.json"),
		JSON.stringify({ agentType: "Plan", status: "completed", endedAt: Date.now() - 1000 }),
	);
	writeFileSync(
		join(sub, "dead1.json"),
		JSON.stringify({ agentType: "Plan", status: "running", startedAt: Date.now() - 5000 }),
	);
	writeFileSync(join(sub, "v1.json"), JSON.stringify({ agentType: "Plan" }));
	registry.rebuild({ ...parent("p6"), sessionFile: join(dir, "s.jsonl") });
	assert.equal(registry.get("dead1")!.status, "stopped");
	assert.ok(registry.get("dead1")!.endedAt !== undefined, "a dead run has an end time");
	const { panel } = setup("p6");
	assert.deepEqual(panel.render(100), []);
	start("p6", "live1", "now");
	const text = panel.render(100).join("\n");
	assert.match(text, /Explore\(now\)/);
	assert.ok(!text.includes("Plan"), text);
	panel.dispose();
});
