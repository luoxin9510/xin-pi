// v3b-04: colour, model and effort display, stop-all. Panel, screen and command against the real registries; no pi, no model.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { beginCodemodeScript } from "../../../src/extensions/codemode/scripts.ts";
import { scripts } from "../../../src/extensions/subagent/background.ts";
import { parseDefinition } from "../../../src/extensions/subagent/definition.ts";
import { Panel } from "../../../src/extensions/subagent/panel.ts";
import { registry } from "../../../src/extensions/subagent/registry.ts";
import { SubagentScreen } from "../../../src/extensions/subagent/subagent-screen.ts";
import { subagentsCommand } from "../../../src/extensions/subagent/subagents-command.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";

initTheme("dark");
const theme: any = {
	fg: (_c: string, s: string) => s,
	bg: (_c: string, s: string) => `[sel]${s}`,
	bold: (s: string) => s,
};
const parent = (sessionId: string) => ({ thinking: "off", cwd: "/tmp", trusted: true, sessionId });
const KEY = { down: "\x1b[B" };
const RELEASE_X = "\x1b[120;2:3u"; // kitty: release of shift+x
const SHIFT_X_KITTY = "\x1b[120;2u";
const fm = (extra: string) => `---\nname: a\ndescription: d\n${extra}\n---\nbody`;
const tui: any = { terminal: { rows: 14 }, requestRender() {} };
const screenOf = (id: string) =>
	new SubagentScreen(
		tui,
		theme,
		id,
		() => false,
		{ cwd: "/tmp" } as any,
		() => {},
	);

// A fake running child that ends (like the real one does on abort) when told to stop.
function runningAgent(
	sessionId: string,
	id: string,
	extra: { color?: string; model?: string; thinking?: string } = {},
) {
	registry.begin(parent(sessionId), {
		id,
		type: "Explore",
		description: id,
		model: extra.model ?? "m",
		thinking: extra.thinking ?? "off",
		color: extra.color,
	});
	registry.attach(id, {
		send: (c: { type: string }) => {
			if (c.type !== "abort") return false;
			setTimeout(() => (registry.stopRequested(id), registry.finish(id, "stopped")), 5);
			return true;
		},
		setModel: async () => undefined,
	} as any);
}

test("color is parsed, no longer inert; an unknown value warns and is ignored", () => {
	const ok = parseDefinition("f", fm("color: purple"));
	assert.ok(ok.ok && ok.def.color === "purple" && !ok.def.inert.includes("color") && ok.def.warnings.length === 0);
	const bad = parseDefinition("f", fm("color: mauve"));
	assert.ok(bad.ok);
	assert.equal(bad.def.color, undefined);
	assert.equal(bad.def.warnings.length, 1);
	assert.match(bad.def.warnings[0]!, /color.*mauve/);
	assert.ok(!bad.def.inert.includes("color"));
	const none = parseDefinition("f", fm("model: x"));
	assert.ok(none.ok && none.def.color === undefined && none.def.warnings.length === 0);
});

test("panel row tints the label only; the screen header tints the label", () => {
	runningAgent("c1", "c1-a", { color: "blue" });
	runningAgent("c1", "c1-b");
	const panel = new Panel(
		"c1",
		theme,
		() => {},
		() => {},
		{ lingerMs: 30_000, viewable: true },
	);
	const rows = panel.render(120);
	const blue = rows.find((l) => l.includes("c1-a"))!;
	const m = blue.match(/● running · (\x1b\[38;5;\d+m)Explore\(c1-a\)\x1b\[39m · /);
	assert.ok(m, JSON.stringify(blue));
	assert.ok(!rows.find((l) => l.includes("c1-b"))!.includes("\x1b["), "no colour, no escape");
	panel.dispose();

	const head = screenOf("c1-a").render(100)[0]!;
	assert.ok(head.includes(`${m[1]}Explore(c1-a)`), head);
});

test("screen header and /subagents picker show model and effort; a record without a model shows nothing extra", async () => {
	runningAgent("m1", "m1-a", { model: "anthropic/claude-haiku-5-5", thinking: "high" });
	runningAgent("m1", "m1-b", { model: "", thinking: "" });
	assert.match(
		screenOf("m1-a").render(160)[0]!,
		/Explore\(m1-a\) {3}main: .* · 0 turns · anthropic\/claude-haiku-5-5 · high$/,
	);
	assert.match(screenOf("m1-b").render(160)[0]!, /Explore\(m1-b\) {3}main: .* · 0 turns$/);

	const menus: string[][] = [];
	const dir = mkdtempSync(join(tmpdir(), "subagent-polish-"));
	const file = join(dir, "s.jsonl");
	writeFileSync(file, "");
	const ctx: any = {
		sessionManager: { getSessionFile: () => file, getSessionId: () => "m1" },
		ui: { select: async (_t: string, o: string[]) => (menus.push(o), undefined), notify() {} },
	};
	await subagentsCommand(ctx);
	const a = menus[0]!.find((l) => l.includes("m1-a"))!;
	const b = menus[0]!.find((l) => l.includes("m1-b"))!;
	assert.match(a, /Explore\(m1-a\) · anthropic\/claude-haiku-5-5 · high · 0 turns · m1-a$/);
	assert.match(b, /Explore\(m1-b\) · 0 turns · m1-b$/);
});

test("/subagents stop stops running subagents and scripts and counts them; with nothing running it says so", async () => {
	const notes: string[] = [];
	const ctx: any = {
		sessionManager: { getSessionFile: () => "/x", getSessionId: () => "k1" },
		ui: { notify: (m: string) => notes.push(m) },
	};
	await subagentsCommand(ctx, "stop");
	assert.match(notes.pop()!, /nothing is running/);

	runningAgent("k1", "k1-a");
	runningAgent("k1", "k1-b");
	const off = scripts.connect({
		sessionId: () => "k1",
		enabled: () => true,
		deliver: () => {},
		parent: () => ({ sessionFile: undefined, sessionId: "k1" }),
	});
	const run = beginCodemodeScript("kc", "k1", undefined);
	await subagentsCommand(ctx, "stop");
	off();
	assert.equal(registry.get("k1-a")!.status, "stopped");
	assert.equal(registry.get("k1-b")!.status, "stopped");
	assert.equal(run.signal.aborted, true);
	run.end({});
	assert.match(notes.pop()!, /stopped 2 subagents and 1 script\b/);
});

test("shift+x on the focused panel stops everything (as X and as kitty CSI-u); x stops one row; keys pass through; releases are swallowed", async () => {
	for (const [session, key] of [
		["h1", "X"],
		["h2", SHIFT_X_KITTY],
	] as const) {
		runningAgent(session, `${session}-a`);
		runningAgent(session, `${session}-b`);
		const panel = new Panel(
			session,
			theme,
			() => {},
			() => {},
			{ lingerMs: 30_000, viewable: true },
		);
		assert.equal(panel.handleKey(key, true), false, "not focused: the key belongs to pi");
		panel.handleKey(KEY.down, true);
		assert.match(panel.render(100).at(-1)!, /X stop all/);
		assert.equal(panel.handleKey(RELEASE_X, true), true, "a release is swallowed while focused and does nothing");
		assert.equal(registry.get(`${session}-a`)!.status, "running");
		assert.equal(panel.handleKey(key, true), true);
		await new Promise((r) => setTimeout(r, 80));
		assert.equal(registry.get(`${session}-a`)!.status, "stopped");
		assert.equal(registry.get(`${session}-b`)!.status, "stopped");
		panel.dispose();
	}
	runningAgent("h3", "h3-a");
	runningAgent("h3", "h3-b");
	const panel = new Panel(
		"h3",
		theme,
		() => {},
		() => {},
		{ lingerMs: 30_000, viewable: true },
	);
	panel.handleKey(KEY.down, true);
	assert.equal(panel.handleKey("x", true), true);
	await new Promise((r) => setTimeout(r, 80));
	assert.equal(registry.get("h3-a")!.status, "stopped");
	assert.equal(registry.get("h3-b")!.status, "running", "x stops only the selected row");
	assert.equal(panel.handleKey("q", true), false, "other keys pass through");
	panel.dispose();
});
