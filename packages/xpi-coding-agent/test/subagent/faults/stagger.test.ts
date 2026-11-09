// `subagent.staggerStart`: the gate that lets one sibling write the shared prompt prefix to the provider's cache before
// the others start. The gate alone runs on a fake clock; the wiring runs fake children in real time.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { readConfig } from "../../../src/extensions/subagent/config.ts";
import { registry } from "../../../src/extensions/subagent/registry.ts";
import { responded, STAGGER_TIMEOUT_MS, stagger, WARM_MS } from "../../../src/extensions/subagent/stagger.ts";
import { agentFile, ev, happyLines, loadTool, sandbox } from "../helpers.ts";

// Promise callbacks run before the next immediate; the fake clock leaves setImmediate alone.
const settle = () => new Promise((r) => setImmediate(r));

// Has this wait ended? "waiting", "leads" (got the gate), "follows" (went without it) or the rejection's message.
function watch(p: Promise<(() => void) | undefined>) {
	const seen = { state: "waiting" };
	p.then(
		(open) => {
			seen.state = open ? "leads" : "follows";
		},
		(err: Error) => {
			seen.state = err.message;
		},
	);
	return seen;
}

test("gate: the first child with a key leads at once; a later one waits until some child with the key gets a response", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	const leader = watch(stagger("signal", undefined));
	const follower = watch(stagger("signal", undefined));
	await settle();
	assert.equal(leader.state, "leads");
	assert.equal(follower.state, "waiting");
	responded("signal");
	await settle();
	assert.equal(follower.state, "follows");
});

test("gate: followers go after the timeout when the leader's response has not begun", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	const open = await stagger("timeout", undefined);
	const a = watch(stagger("timeout", undefined));
	const b = watch(stagger("timeout", undefined));
	t.mock.timers.tick(STAGGER_TIMEOUT_MS - 1);
	await settle();
	assert.deepEqual([a.state, b.state], ["waiting", "waiting"]);
	t.mock.timers.tick(1);
	await settle();
	assert.deepEqual([a.state, b.state], ["follows", "follows"]);
	open!(); // the leader ending later changes nothing
});

test("gate: the leader's run ending (failure, abort) opens the gate; the next child leads again", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	const open = await stagger("ended", undefined);
	const follower = watch(stagger("ended", undefined));
	await settle();
	assert.equal(follower.state, "waiting");
	open!();
	await settle();
	assert.equal(follower.state, "follows");
	// nothing was cached: a later child has to lead
	assert.equal(typeof (await stagger("ended", undefined)), "function");
});

test("gate: a different key never waits", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	await stagger("one", undefined);
	const other = watch(stagger("two", undefined));
	await settle();
	assert.equal(other.state, "leads");
});

test("gate: an abort ends one follower's wait; the others still wait for the leader", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	await stagger("abort", undefined);
	const controller = new AbortController();
	const stopped = watch(stagger("abort", controller.signal));
	const other = watch(stagger("abort", undefined));
	controller.abort();
	await settle();
	assert.equal(stopped.state, "aborted");
	assert.equal(other.state, "waiting");
	responded("abort");
	await settle();
	assert.equal(other.state, "follows");

	const gone = new AbortController();
	gone.abort();
	await stagger("abort-early", undefined);
	await assert.rejects(stagger("abort-early", gone.signal), /aborted/);
});

test("gate: after a response the prefix is cached, so for WARM_MS nobody waits or leads", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	await stagger("warm", undefined);
	responded("warm");
	t.mock.timers.tick(WARM_MS - 1);
	const first = watch(stagger("warm", undefined));
	const second = watch(stagger("warm", undefined));
	await settle();
	assert.deepEqual([first.state, second.state], ["follows", "follows"]);
	t.mock.timers.tick(1);
	const later = watch(stagger("warm", undefined));
	const behind = watch(stagger("warm", undefined));
	await settle();
	assert.deepEqual([later.state, behind.state], ["leads", "waiting"]);
});

test("gate: a leader that ends after its gate timed out does not open the next leader's gate", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	const slow = await stagger("late", undefined);
	t.mock.timers.tick(STAGGER_TIMEOUT_MS);
	await stagger("late", undefined); // the next leader
	const follower = watch(stagger("late", undefined));
	slow!();
	await settle();
	assert.equal(follower.state, "waiting");
});

test("subagent.staggerStart: boolean, default false; another type is a config error naming the key", () => {
	assert.equal(readConfig({}).staggerStart, false);
	assert.equal(readConfig({ staggerStart: true }).staggerStart, true);
	assert.equal(readConfig({ staggerStart: false }).staggerStart, false);
	assert.throws(() => readConfig({ staggerStart: "yes" }), /subagent\.staggerStart must be true or false, got "yes"/);
	assert.throws(() => readConfig({ staggerStart: 1 }), /subagent\.staggerStart must be true or false, got 1/);
});

// --- the wiring, with fake children. Each child appends "start" when its process starts and "line <n>" before each
// scripted line, so the log gives the order of events across the siblings. A child holds before one line until all
// the siblings have started (or 4 s have passed), so the order does not depend on how fast processes start.

const responseBegins = () => JSON.stringify({ type: "message_start", message: { role: "assistant", content: [] } });
// line 0 session, line 1 the response begins, lines 2 to 4 the answer and the end
const answer = (log: string, hold: { line: number; starts: number }) => ({
	lines: [ev.session(), responseBegins(), ev.assistant("done"), ev.turnEnd(), ev.settled()],
	logFile: log,
	hold,
});
const logged = (log: string) => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
const until = async (what: string, pred: () => boolean, ms = 8000) => {
	const t0 = Date.now();
	while (!pred()) {
		if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 20));
	}
};

test("staggerStart off (default): siblings start together, as before", async () => {
	const s = sandbox();
	const log = join(s.root, "order.log");
	s.scenario(answer(log, { line: 0, starts: 2 })); // nobody says anything before both have started
	const t = await loadTool({}, { cwd: s.repo });
	const results = await Promise.all([t.run({}), t.run({})]);
	assert.deepEqual(
		results.map((r) => r.structuredContent.status),
		["completed", "completed"],
	);
	assert.deepEqual(logged(log).slice(0, 2), ["start", "start"]);
});

test("staggerStart on: the other siblings start once the first one's response has begun, not when it ends", async () => {
	const s = sandbox();
	const log = join(s.root, "order.log");
	s.scenario(answer(log, { line: 2, starts: 3 })); // the leader goes on after its message_start once all three run
	const t = await loadTool({ staggerStart: true }, { cwd: s.repo });
	const results = await Promise.all([t.run({}), t.run({}), t.run({})]);
	assert.deepEqual(
		results.map((r) => r.structuredContent.status),
		["completed", "completed", "completed"],
	);
	const order = logged(log);
	assert.deepEqual(order.slice(0, 3), ["start", "line 0", "line 1"], "the leader runs alone up to its message_start");
	assert.ok(order.lastIndexOf("start") < order.indexOf("line 4"), `all started before any run ended: ${order}`);
});

test("staggerStart on: siblings with another tool set do not wait", async () => {
	const s = sandbox();
	const log = join(s.root, "order.log");
	s.write(join(s.repo, ".pi/agents/reader.md"), agentFile("name: reader\ndescription: d\ntools: read"));
	s.scenario(answer(log, { line: 0, starts: 2 }));
	const t = await loadTool({ staggerStart: true }, { cwd: s.repo });
	await Promise.all([t.run({}), t.run({ subagent_type: "reader" })]);
	assert.deepEqual(logged(log).slice(0, 2), ["start", "start"]);
});

test("staggerStart on: a leader that ends without a response lets the next sibling start", async () => {
	const s = sandbox();
	const log = join(s.root, "order.log");
	s.scenario({ lines: happyLines(), delayMs: 100, logFile: log }); // no message_start in these lines
	const t = await loadTool({ staggerStart: true }, { cwd: s.repo });
	const t0 = Date.now();
	await Promise.all([t.run({}), t.run({})]);
	assert.ok(Date.now() - t0 < STAGGER_TIMEOUT_MS, "the follower did not sit out the timeout");
	const order = logged(log);
	assert.equal(order.lastIndexOf("start"), happyLines().length + 1, `the leader played every line first: ${order}`);
});

test("staggerStart on: a sibling stopped while it waits never starts", async () => {
	const s = sandbox();
	const log = join(s.root, "order.log");
	s.scenario({ lines: [ev.session()], hang: true, abortSettles: true, logFile: log }); // the response never begins
	const t = await loadTool({ staggerStart: true }, { cwd: s.repo, sessionId: "stagger-stop" });
	const leader = new AbortController();
	const leading = t.run({}, leader.signal);
	await until("the leader runs", () => logged(log).includes("line 0"));

	// a foreground call: its signal
	const waiting = new AbortController();
	const call = t.run({}, waiting.signal);
	waiting.abort();
	await assert.rejects(call, /aborted/);

	// a background agent: stop, which reaches it although it has no child yet
	const detached = (
		await t.tool.execute(
			"stagger/1",
			{ description: "d", prompt: "p", run_in_background: true },
			undefined,
			undefined,
			t.ctx,
		)
	).structuredContent;
	await registry.stopAll([detached.agentId]);
	await until("the stopped agent's message", () => t.messages.length === 1);
	assert.match(
		t.messages[0].message.content,
		new RegExp(`Background agent ${detached.agentId} general-purpose stopped`),
	);
	assert.equal(registry.get(detached.agentId), undefined, "it never started");

	assert.deepEqual(logged(log), ["start", "line 0"], "only the leader's process ever ran");
	leader.abort();
	await assert.rejects(leading, /aborted/);
});
