// Spec 07, pause and resume: a paused script starts no new agent (its Agent calls wait), agents already running
// finish, a resume lets the waiting calls go on in order, and a stop ends them.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { beginCodemodeScript } from "../../../src/extensions/codemode/scripts.ts";
import { scripts } from "../../../src/extensions/subagent/background.ts";
import { Panel } from "../../../src/extensions/subagent/panel.ts";
import { codemodeStandIn, ev, loadTool, sandbox } from "../helpers.ts";

const until = async (what: string, pred: () => boolean, ms = 8000) => {
	const t0 = Date.now();
	while (!pred()) {
		if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 20));
	}
};

async function setup(sessionId: string) {
	const s = sandbox();
	const log = join(s.root, "starts.log");
	// Each child takes a little while, so a pause lands while one runs.
	s.scenario({ lines: [ev.session(), ev.assistant("done"), ev.turnEnd(), ev.settled()], delayMs: 120, logFile: log });
	const t = await loadTool({ maxConcurrent: 5 }, { cwd: s.repo, sessionId });
	const starts = () =>
		existsSync(log)
			? readFileSync(log, "utf8")
					.split("\n")
					.filter((l) => l === "start").length
			: 0;
	return { t, w: codemodeStandIn(t), starts };
}
// Three agents, one after the other; the result says how each ended.
const three = async ({ agent }: { agent: () => Promise<{ status: string }> }) => {
	const out: string[] = [];
	for (let i = 0; i < 3; i++) out.push((await agent()).status);
	return out.join(",");
};

test("pause: the running agent finishes, the next call waits; resume lets the script go on", async () => {
	const { t, w, starts } = await setup("pause-1");
	await w.run("p1", three as any);
	const script = scripts.list("pause-1")[0]!;
	await until("the first agent", () => starts() === 1);
	assert.equal(scripts.togglePause(script.id), true);
	assert.equal(script.paused, true);
	await until("the first agent's end", () => script.agents.length === 1 && t.messages.length === 0 && starts() === 1);
	await new Promise((r) => setTimeout(r, 700)); // long enough for agents two and three, were they not held
	assert.equal(starts(), 1, "no new agent starts while the script is paused");
	assert.equal(script.state, "background", "paused is not ended");
	assert.equal(w.delivered.length, 0);

	assert.equal(scripts.togglePause(script.id), false);
	await until("the end message", () => w.delivered.length === 1);
	assert.equal(starts(), 3);
	assert.match(w.delivered[0]!, /completed\.\nReturn value:\ncompleted,completed,completed/);
});

test("stop while paused: the waiting call ends, the script is stopped; pausing an ended script does nothing", async () => {
	const { w, starts } = await setup("pause-2");
	await w.run("p2", three as any);
	const script = scripts.list("pause-2")[0]!;
	await until("the first agent", () => starts() === 1);
	scripts.togglePause(script.id);
	await new Promise((r) => setTimeout(r, 500)); // the first agent has ended and the second call is waiting
	assert.equal(await scripts.stop(script.id), true);
	await until("the stopped message", () => w.delivered.length === 1);
	assert.match(w.delivered[0]!, /stopped\./);
	assert.equal(starts(), 1);
	assert.equal(script.paused, false);
	assert.equal(scripts.togglePause(script.id), undefined, "an ended script cannot be paused");
});

test("a script that is not paused is not held; a call outside a script is not either", async () => {
	const { t, w, starts } = await setup("pause-3");
	const r = (await t.run({ run_in_background: false })).structuredContent;
	assert.equal(r.status, "completed");
	await w.run("p3", three as any);
	await until("the end message", () => w.delivered.length === 1);
	assert.equal(starts(), 4);
});

test("panel: p on a running script's row pauses and resumes it; the row and the hint say so", () => {
	const off = scripts.connect({
		sessionId: () => "pause-4",
		enabled: () => true,
		deliver: () => {},
		parent: () => ({ sessionFile: undefined, sessionId: "pause-4" }),
	});
	const run = beginCodemodeScript("pause-4-call", "pause-4", undefined);
	const script = scripts.list("pause-4")[0]!;
	const theme: any = { fg: (_c: string, x: string) => x, bg: (_c: string, x: string) => x, bold: (x: string) => x };
	const panel = new Panel(
		"pause-4",
		theme,
		() => {},
		() => {},
		{ lingerMs: 30_000, viewable: true },
	);
	assert.equal(panel.handleKey("p", true), false, "not focused: the key belongs to pi");
	panel.handleKey("\x1b[B", true);
	assert.match(panel.render(200).at(-1)!, /p pause/);
	assert.equal(panel.handleKey("p", true), true);
	assert.equal(script.paused, true);
	const paused = panel.render(200);
	assert.match(paused.find((l) => l.includes(`script ${script.id}`))!, /● paused · script/);
	assert.match(paused.at(-1)!, /p resume/);
	assert.equal(panel.handleKey("p", true), true);
	assert.equal(script.paused, false);
	run.end({});
	assert.doesNotMatch(panel.render(200).at(-1)!, /p pause|p resume/, "an ended script has nothing to pause");
	assert.equal(panel.handleKey("p", true), false);
	panel.dispose();
	off();
});
