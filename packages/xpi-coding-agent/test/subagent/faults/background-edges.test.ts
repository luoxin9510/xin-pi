// v3a ticket 03: the edges of background scripts, on fake pi children and a stand-in for pi's codemode (the real wrapper
// seam is test/parent/). The stand-in runs the JS function a test passes as `params.script`, which calls the real Agent tool
// with nested call ids "<codemode id>/<n>" like codemode's sandbox does.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { scripts } from "../../../src/extensions/subagent/background.ts";
import { readConfig } from "../../../src/extensions/subagent/config.ts";
import { registry } from "../../../src/extensions/subagent/registry.ts";
import { codemodeStandIn, ev, happyLines, loadTool, sandbox, usage } from "../helpers.ts";

const until = async (what: string, pred: () => boolean, ms = 8000) => {
	const t0 = Date.now();
	while (!pred()) {
		if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 20));
	}
};

// The codemode stand-in on the real controller (test/subagent/helpers.ts). `run` is a codemode call.
const wrapper = codemodeStandIn;

const cfg = { maxConcurrent: 1 }; // the first loadTool of the process fixes the limit
const hang = () => ({
	lines: [ev.session(), ev.assistant("t1", usage(10, 5, 0.01), { stopReason: "toolUse" }), ev.tool("read")],
	hang: true,
	abortSettles: true,
});

test("a script that throws: the message carries the error", async () => {
	const s = sandbox();
	s.scenario({ lines: happyLines() });
	const t = await loadTool(cfg, { cwd: s.repo });
	const w = wrapper(t);
	await w.run("cErr", async ({ agent }) => {
		await agent();
		throw new Error("boom");
	});
	await until("message", () => w.delivered.length === 1);
	assert.match(
		w.delivered[0],
		/^Background script S\d+ failed\.\nError: boom\nAgents:\n- [a-z0-9]{12} general-purpose completed/,
	);
});

test("over 8 KB: first 8 KB plus a file with all of it (session subagents dir; temp dir when in memory); same for a detached agent", async () => {
	const s = sandbox();
	const big = "y".repeat(20_000);
	s.scenario({ lines: happyLines(big) });
	const sessionFile = join(s.root, "sessions", "main.jsonl");
	const t = await loadTool(cfg, { cwd: s.repo, sessionFile, sessionId: "main-id" });
	const w = wrapper(t);
	await w.run("cBig", async ({ agent }) => {
		await agent();
		return big;
	});
	await until("script message", () => w.delivered.length === 1);
	const file = w.delivered[0].match(/all of it is in (\S+\.txt)/)![1];
	assert.equal(dirname(file), join(dirname(sessionFile), "subagents", "main-id"));
	assert.ok(readFileSync(file, "utf8").endsWith(big));
	assert.ok(w.delivered[0].includes("y".repeat(8000)) && !w.delivered[0].includes("y".repeat(8001)), "cut at 8000");

	// a detached agent's own message: same rule
	await t.tool.execute(
		"cDet/1",
		{ description: "d", prompt: "p", run_in_background: true },
		undefined,
		undefined,
		t.ctx,
	);
	await until("agent message", () => t.messages.length === 2);
	const agentFile = t.messages[1].message.content.match(/all of it is in (\S+\.txt)/)![1];
	assert.equal(dirname(agentFile), dirname(file));
	assert.equal(readFileSync(agentFile, "utf8"), big);

	// an in-memory session: a temp dir
	const mem = await loadTool(cfg, { cwd: s.repo, sessionId: "mem-id" });
	const w2 = wrapper(mem);
	await w2.run("cMem", async ({ agent }) => {
		await agent();
		return big;
	});
	await until("in-memory message", () => w2.delivered.length === 1);
	const memFile = w2.delivered[0].match(/all of it is in (\S+\.txt)/)![1];
	assert.ok(readFileSync(memFile, "utf8").endsWith(big));
	assert.ok(memFile.includes("subagent-") && !memFile.includes("subagents"), memFile);
});

test("short results are not cut and no file is made", async () => {
	const s = sandbox();
	s.scenario({ lines: happyLines() });
	const t = await loadTool(cfg, { cwd: s.repo });
	const w = wrapper(t);
	await w.run("cShort", async ({ agent }) => (await agent(), "z".repeat(7000)));
	await until("message", () => w.delivered.length === 1);
	assert.doesNotMatch(w.delivered[0], /all of it is in/);
});

test("two scripts at once both report; their agents share maxConcurrent (never overlap with a limit of 1)", async () => {
	const s = sandbox();
	s.scenario({ lines: happyLines(), delayMs: 120 });
	const t = await loadTool(cfg, { cwd: s.repo });
	const w = wrapper(t);
	const [a, b] = await Promise.all([
		w.run("cA", async ({ agent }) => (await agent(), "one")),
		w.run("cB", async ({ agent }) => (await agent(), "two")),
	]);
	assert.match(a.content[0].text, /moved to the background/);
	assert.match(b.content[0].text, /moved to the background/);
	await until("both messages", () => w.delivered.length === 2);
	const both = scripts.list("parent-id").filter((x) => x.callId === "cA" || x.callId === "cB");
	assert.equal(both.length, 2);
	assert.ok(w.delivered.every((m) => /completed\./.test(m)));
	const [r1, r2] = both.map((x) => registry.get(x.agents[0])!).sort((x, y) => x.startedAt - y.startedAt);
	assert.ok(r1.endedAt! <= r2.startedAt, "the second agent waited for the slot");
});

test("stopping a script through the registry: its agents end failed 'stopped by user', the script ends stopped, main is told", async () => {
	const s = sandbox();
	s.scenario(hang());
	const t = await loadTool(cfg, { cwd: s.repo });
	const w = wrapper(t);
	let seen: any;
	await w.run("cStop", async ({ agent }) => {
		seen = await agent();
		return "after";
	});
	const script = scripts.list("parent-id").find((x) => x.callId === "cStop")!;
	await until("agent running", () => script.agents.length === 1 && registry.handle(script.agents[0]) !== undefined);
	assert.equal(await scripts.stop(script.id), true);
	await until("message", () => w.delivered.length === 1);
	assert.equal(seen.status, "failed");
	assert.equal(seen.error, "stopped by user");
	assert.equal(registry.get(script.agents[0])!.status, "stopped");
	assert.equal(script.state, "stopped");
	assert.match(w.delivered[0], new RegExp(`^Background script ${script.id} stopped\\.`));
	assert.equal(await scripts.stop(script.id), false, "an ended script cannot be stopped");
});

test("session shutdown stops background scripts and detached agents (stopped, resumable); main hears nothing", async () => {
	const s = sandbox();
	s.scenario(hang());
	const sessionFile = join(s.root, "sessions", "main.jsonl");
	const t = await loadTool(cfg, { cwd: s.repo, sessionFile, sessionId: "sd-id" });
	const w = wrapper(t);
	await w.run("cSd", async ({ agent }) => (await agent(), "after"));
	const script = scripts.list("sd-id")[0];
	const det = (
		await t.tool.execute(
			"cSd2/1",
			{ description: "d", prompt: "p", run_in_background: true },
			undefined,
			undefined,
			t.ctx,
		)
	).structuredContent;
	await until("both running", () => registry.handle(script.agents[0]) !== undefined);
	await t.emit("session_shutdown", { reason: "reload" });
	await until("script ended", () => script.state === "stopped");
	assert.equal(registry.get(script.agents[0])!.status, "stopped");
	assert.equal(registry.get(det.agentId)!.status, "stopped");
	const meta = JSON.parse(
		readFileSync(join(dirname(sessionFile), "subagents", "sd-id", `${det.agentId}.json`), "utf8"),
	);
	assert.equal(meta.status, "stopped");
	assert.deepEqual(t.messages, [], "nothing is sent to main while the session ends");
});

test("Esc: aborting main's turn leaves a background script running", async () => {
	const s = sandbox();
	s.scenario({ lines: happyLines(), delayMs: 150 });
	const t = await loadTool(cfg, { cwd: s.repo });
	const w = wrapper(t);
	const esc = new AbortController();
	await w.run("cEscBg", async ({ agent }) => (await agent(), "survived"), esc.signal);
	esc.abort();
	await until("message", () => w.delivered.length === 1);
	assert.match(w.delivered[0], /completed\.\nReturn value:\nsurvived/);
});

test("Esc: aborting main's turn stops a script still in the foreground", async () => {
	const s = sandbox();
	s.scenario(hang());
	const t = await loadTool(cfg, { cwd: s.repo });
	const w = wrapper(t);
	const esc = new AbortController();
	const call = w.run("cEscFg", async ({ agent }) => (await agent({ run_in_background: false }), "never"), esc.signal);
	const script = scripts.list("parent-id").find((x) => x.callId === "cEscFg")!;
	await until("agent running", () => script.agents.length === 1 && registry.handle(script.agents[0]) !== undefined);
	esc.abort();
	await assert.rejects(call);
	assert.equal(script.state, "stopped");
	assert.equal(script.pinned, true);
	assert.deepEqual(w.delivered, []);
});

test("subagent.backgroundScripts: boolean, default true; another type is a config error naming the key", () => {
	assert.equal(readConfig({}).backgroundScripts, true);
	assert.equal(readConfig({ backgroundScripts: false }).backgroundScripts, false);
	assert.throws(
		() => readConfig({ backgroundScripts: "no" }),
		/subagent\.backgroundScripts must be true or false, got "no"/,
	);
});

test("backgroundScripts false: no script is tracked or moved; the call returns its own result", async () => {
	const s = sandbox();
	s.scenario({ lines: happyLines() });
	const t = await loadTool({ ...cfg, backgroundScripts: false }, { cwd: s.repo, sessionId: "bg-off" });
	const w = wrapper(t);
	const r = await w.run("cOff", async ({ agent }) => `plain ${(await agent()).status}`);
	assert.equal(r.content[0].text, "plain completed");
	assert.equal(scripts.list("bg-off").length, 0, "no script is tracked");
	assert.deepEqual(w.delivered, []);
});

test("no UI (print mode, `pi -p`): a script that starts an agent stays in the foreground and returns its own result", async () => {
	// pi exits when a print-mode turn ends, so a background script's result would be lost.
	const s = sandbox();
	s.scenario({ lines: happyLines("fg-out") });
	const t = await loadTool(cfg, { cwd: s.repo, hasUI: false, sessionId: "no-ui" }); // a unique session: earlier instances in this process stay connected
	const w = wrapper(t);
	const result = await w.run("cPrint", async ({ agent }) => `got ${(await agent()).status}`);
	assert.equal(result.content[0].text, "got completed");
	assert.deepEqual(w.delivered, []);
});

test("a foreground script whose result is an error ends failed; a throw ends failed", async () => {
	const s = sandbox();
	s.scenario({ lines: happyLines() });
	const t = await loadTool(cfg, { cwd: s.repo });
	const w = wrapper(t);
	await w.run("cFgErr", async ({ agent }) => (await agent({ run_in_background: false }), "bad"), undefined, true);
	assert.equal(scripts.list("parent-id").find((x) => x.callId === "cFgErr")!.state, "failed");
	await assert.rejects(
		w.run(
			"cFgThrow",
			async ({ agent }) => (await agent({ run_in_background: false }), Promise.reject(new Error("x"))),
		),
	);
	assert.equal(scripts.list("parent-id").find((x) => x.callId === "cFgThrow")!.state, "failed");
});

test("every agent failed: the script ends failed with an error line even if it returned normally", async () => {
	const s = sandbox();
	s.scenario({ lines: [ev.session()], exitCode: 3 });
	const t = await loadTool(cfg, { cwd: s.repo });
	const w = wrapper(t);
	await w.run("cAllFail", async ({ agent }) => `status ${(await agent()).status}`);
	await until("message", () => w.delivered.length === 1);
	assert.match(w.delivered[0], /^Background script S\d+ failed\.\nError: every agent failed/);
	assert.equal(scripts.list("parent-id").find((x) => x.callId === "cAllFail")!.state, "failed");
});

test("over 8 KB counts bytes (UTF-8) and cuts at a character boundary", async () => {
	const s = sandbox();
	s.scenario({ lines: happyLines() });
	const sessionFile = join(s.root, "sessions", "main.jsonl");
	const t = await loadTool(cfg, { cwd: s.repo, sessionFile, sessionId: "mb-id" });
	const w = wrapper(t);
	const text = "é".repeat(3000); // 6000 chars, 6000 bytes: under the cap
	const wide = "界".repeat(3000); // 3000 chars, 9000 bytes: over it
	await w.run("cMbShort", async ({ agent }) => (await agent(), text));
	await until("short", () => w.delivered.length === 1);
	assert.doesNotMatch(w.delivered[0], /all of it is in/);
	await w.run("cMbWide", async ({ agent }) => (await agent(), wide));
	await until("wide", () => w.delivered.length === 2);
	const shown = w.delivered[1].split("Return value:\n")[1].split("\n... (cut")[0];
	assert.equal(shown, "界".repeat(2666), "8000 bytes = 2666 whole characters");
	assert.doesNotMatch(shown, /\ufffd/);
	assert.match(w.delivered[1], /cut, 9000 bytes/);
});

test("stopping a script: it cannot start another agent while its agents stop", async () => {
	const s = sandbox();
	s.scenario(hang());
	const t = await loadTool(cfg, { cwd: s.repo });
	const w = wrapper(t);
	let second: unknown;
	await w.run("cNoMore", async ({ agent }) => {
		await agent();
		second = await agent().catch((e) => e);
		return "after";
	});
	const script = scripts.list("parent-id").find((x) => x.callId === "cNoMore")!;
	await until("agent running", () => script.agents.length === 1 && registry.handle(script.agents[0]) !== undefined);
	await scripts.stop(script.id);
	await until("message", () => w.delivered.length === 1);
	assert.ok(second instanceof Error, "the second agent did not start");
	assert.equal(script.agents.length, 1);
});

test("ended scripts leave the registry (the last 50 stay for the panel) and no longer own tool calls", async () => {
	const s = sandbox();
	s.scenario({ lines: happyLines() });
	const t = await loadTool(cfg, { cwd: s.repo, sessionId: "leak-id" });
	const w = wrapper(t);
	for (let i = 0; i < 55; i++) await w.run(`cLeak${i}`, async () => "x", undefined, false);
	const ended = scripts.list("leak-id");
	assert.equal(ended.length, 50);
	assert.equal(ended.at(-1)!.callId, "cLeak54");
	assert.equal(scripts.owner("cLeak54/1"), undefined, "an ended script owns nothing");
});

test("no UI: run_in_background true waits like a foreground call and the description says nothing of background scripts", async () => {
	const s = sandbox();
	s.scenario({ lines: happyLines("pr-out") });
	const t = await loadTool(cfg, { cwd: s.repo });
	const ctx = { ...t.ctx, hasUI: false };
	const r = await t.tool.execute(
		"cNoUi/1",
		{ description: "d", prompt: "p", run_in_background: true },
		undefined,
		undefined,
		ctx,
	);
	assert.equal(r.structuredContent.status, "completed");
	assert.equal(r.structuredContent.output, "pr-out");
	assert.deepEqual(t.messages, []);
	const noUi = await loadTool(cfg, { cwd: s.repo, hasUI: false });
	assert.doesNotMatch(noUi.tool.description, /background/i);
	assert.match(t.tool.description, /background/i);
});
