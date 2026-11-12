// Agent teams: the three extension events (team-hooks.ts and where they fire): `block` and `hold`, their order against the
// locks, and the limit on a blocked teammate_idle.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createEventBus } from "../../../src/core/event-bus.ts";
import type { RunResult } from "../../../src/extensions/subagent/runner.ts";
import { emptyUsage } from "../../../src/extensions/subagent/runner.ts";
import { MAX_IDLE_BLOCKS } from "../../../src/extensions/subagent/team.ts";
import { emitHook, type HookAnswers, runHook } from "../../../src/extensions/subagent/team-hooks.ts";
import { createTask, getTask, type TaskEnv, updateTask } from "../../../src/extensions/subagent/team-tasks.ts";
import { settle, stubTeam } from "./team-helpers.ts";

const run = (output: string, extra: Partial<RunResult> = {}): RunResult => ({
	status: "completed",
	output,
	usage: emptyUsage(),
	turns: 1,
	durationMs: 1,
	aborted: false,
	...extra,
});

type Payload = HookAnswers & Record<string, any>;

function bus() {
	const b = createEventBus();
	const warns: string[] = [];
	return {
		b,
		warns,
		env: (holdTimeoutMs?: number) => ({ bus: b, warn: (m: string) => warns.push(m), holdTimeoutMs }),
	};
}

test("emitHook: no handler allows; block blocks with its feedback; the first block wins; a throwing handler does not break the others", async () => {
	const x = bus();
	assert.deepEqual(await runHook(x.env(), "task_created", {}), { blocked: false });
	assert.deepEqual(await runHook({ bus: undefined, warn: () => {} }, "task_created", {}), { blocked: false });
	x.b.on("agent-teams:task_created", (p) => (p as Payload).block("first"));
	x.b.on("agent-teams:task_created", (p) => (p as Payload).block("second"));
	assert.deepEqual(await runHook(x.env(), "task_created", {}), { blocked: true, feedback: "first" });
	const y = bus();
	y.b.on("agent-teams:task_created", (p) => {
		(p as Payload).block("before it threw");
		throw new Error("handler bug");
	});
	assert.deepEqual(await runHook(y.env(), "task_created", {}), { blocked: true, feedback: "before it threw" });
	const z = bus();
	z.b.on("agent-teams:task_created", () => {
		throw new Error("handler bug");
	});
	assert.deepEqual(await runHook(z.env(), "task_created", {}), { blocked: false });
	const e = bus();
	e.b.on("agent-teams:task_created", (p) => (p as Payload).block(""));
	const v = await runHook(e.env(), "task_created", {});
	assert.ok(v.blocked && v.feedback.length > 0, "an empty feedback still blocks, and says something");
});

test("emitHook: hold decides later (a string blocks, undefined allows); a rejected hold allows with a warning", async () => {
	const x = bus();
	let answer: (v: string | undefined) => void = () => {};
	x.b.on("agent-teams:teammate_idle", (p) => (p as Payload).hold(new Promise((r) => (answer = r))));
	const r = emitHook(x.env(), "teammate_idle", {});
	assert.equal(r.sync, undefined, "pending");
	answer("not yet");
	assert.deepEqual(await (r as { later: Promise<unknown> }).later, { blocked: true, feedback: "not yet" });
	const r2 = emitHook(x.env(), "teammate_idle", {});
	answer(undefined);
	assert.deepEqual(await (r2 as { later: Promise<unknown> }).later, { blocked: false });
	const y = bus();
	y.b.on("agent-teams:teammate_idle", (p) => (p as Payload).hold(Promise.reject(new Error("db down"))));
	assert.deepEqual(await runHook(y.env(), "teammate_idle", {}), { blocked: false });
	assert.match(y.warns.join("\n"), /hold failed: Error: db down: allowed/);
	// a block given with a hold wins at once, without waiting for it
	const z = bus();
	z.b.on("agent-teams:teammate_idle", (p) => {
		(p as Payload).hold(new Promise(() => {}));
		(p as Payload).block("now");
	});
	assert.deepEqual(emitHook(z.env(), "teammate_idle", {}).sync, { blocked: true, feedback: "now" });
});

test("emitHook: a hold that does not answer in time allows the step and logs a warning", async () => {
	const x = bus();
	x.b.on("agent-teams:task_completed", (p) => (p as Payload).hold(new Promise(() => {})));
	const t0 = Date.now();
	assert.deepEqual(await runHook(x.env(40), "task_completed", {}), { blocked: false });
	assert.ok(Date.now() - t0 >= 35 && Date.now() - t0 < 2000);
	assert.match(x.warns.join("\n"), /agent-teams:task_completed: a handler's hold did not answer in \d+ s: allowed/);
});

test("emitHook: an answer after the handler's first await is too late; observeOnly counts no answers; the payload carries its fields", async () => {
	const x = bus();
	let seen: Payload | undefined;
	x.b.on("agent-teams:task_created", async (p) => {
		seen = p as Payload;
		await Promise.resolve();
		(p as Payload).block("late");
	});
	assert.deepEqual(await runHook(x.env(), "task_created", { team: "t", by: "a" }), { blocked: false });
	await settle();
	assert.equal(seen?.team, "t");
	assert.equal(seen?.by, "a");
	assert.equal(typeof seen?.block, "function");
	assert.equal(typeof seen?.hold, "function");
	const y = bus();
	let called = 0;
	y.b.on("agent-teams:teammate_idle", (p) => {
		called++;
		(p as Payload).block("ignored");
		(p as Payload).hold(new Promise(() => {}));
	});
	assert.deepEqual(emitHook(y.env(), "teammate_idle", {}, true).sync, { blocked: false });
	assert.equal(called, 1, "the handler still sees the event");
});

// --- the task events

function taskWorld(holdTimeoutMs?: number) {
	const x = bus();
	const dir = join(mkdtempSync(join(tmpdir(), "hooktasks-")), "session-t");
	const as = (me: string): TaskEnv => ({
		dir,
		team: "session-t",
		me,
		lead: me === "lead",
		live: () => true,
		hooks: x.env(holdTimeoutMs),
	});
	return { ...x, dir, as };
}

test("task_created: the payload is the task without an id; a block throws the feedback and writes nothing, not even an id", async () => {
	const w = taskWorld();
	let payload: Payload | undefined;
	w.b.on("agent-teams:task_created", (p) => {
		payload = p as Payload;
		if ((p as Payload).task.subject === "no") (p as Payload).block("not allowed: too vague");
	});
	await assert.rejects(createTask(w.as("a"), { subject: "no" }), /refused by a hook: not allowed: too vague/);
	assert.equal(payload?.team, "session-t");
	assert.equal(payload?.by, "a");
	assert.equal("id" in payload!.task, false, "no id yet");
	assert.deepEqual(
		{ ...payload!.task },
		{ subject: "no", description: "", status: "pending", blockedBy: [], createdBy: "a" },
	);
	assert.equal(
		existsSync(w.dir) ? readdirSync(w.dir).filter((f) => !f.startsWith(".")).length : 0,
		0,
		"no task file, no counter",
	);
	assert.equal((await createTask(w.as("a"), { subject: "yes" })).id, "1", "the refused task used no id");
});

test("task_created: a hold runs before any lock and its id is taken after it allows", async () => {
	const w = taskWorld();
	let release: (v: string | undefined) => void = () => {};
	w.b.on("agent-teams:task_created", (p) => {
		if ((p as Payload).task.subject === "slow") (p as Payload).hold(new Promise((r) => (release = r)));
	});
	const slow = createTask(w.as("a"), { subject: "slow" });
	await settle(50);
	// the hook is waiting: nothing is locked, so another writer is not held up, and it gets id 1
	assert.equal(existsSync(join(w.dir, ".lock")), false, "the team lock is not held during the hold");
	assert.equal(existsSync(join(w.dir, "next.lock")), false);
	const quick = await createTask(w.as("b"), { subject: "quick" });
	assert.equal(quick.id, "1");
	release(undefined);
	assert.equal((await slow).id, "2", "the id comes from `next` after the hook allowed it");
	// a hold that blocks
	w.b.on(
		"agent-teams:task_created",
		(p) => (p as Payload).task.subject === "held" && (p as Payload).hold(Promise.resolve("held: no")),
	);
	await assert.rejects(createTask(w.as("a"), { subject: "held" }), /refused by a hook: held: no/);
});

test("task_created: the checks are made again after the hook: a blocker that is gone while it ran is refused", async () => {
	const w = taskWorld();
	const t1 = await createTask(w.as("a"), { subject: "1" });
	let release: (v: string | undefined) => void = () => {};
	w.b.on("agent-teams:task_created", (p) => {
		if ((p as Payload).task.subject === "dep") (p as Payload).hold(new Promise((r) => (release = r)));
	});
	const dep = createTask(w.as("a"), { subject: "dep", blockedBy: [t1.id] });
	await settle(30);
	const { rmSync } = await import("node:fs");
	rmSync(join(w.dir, "1.json")); // the blocker disappears while the hook decides
	release(undefined);
	await assert.rejects(dep, /unknown task "1"/);
});

test("task_completed: fires before the write with the task as completed; a block leaves it in progress; claims and refused changes fire nothing", async () => {
	const w = taskWorld();
	const seen: Payload[] = [];
	w.b.on("agent-teams:task_completed", (p) => {
		seen.push(p as Payload);
		if ((p as Payload).task.result === "bad") (p as Payload).block("tests are red");
	});
	await createTask(w.as("a"), { subject: "1" });
	await updateTask(w.as("a"), { id: "1", status: "in_progress" });
	assert.equal(seen.length, 0, "a claim is not a completion");
	await assert.rejects(updateTask(w.as("b"), { id: "1", status: "completed" }), /forbidden/);
	assert.equal(seen.length, 0, "a change that is refused anyway does not fire it");
	await assert.rejects(
		updateTask(w.as("a"), { id: "1", status: "completed", result: "bad" }),
		/refused by a hook: tests are red/,
	);
	assert.equal(seen.length, 1);
	assert.equal(seen[0]!.by, "a");
	assert.equal(seen[0]!.task.status, "completed", "the task as it would be");
	assert.equal(seen[0]!.task.id, "1");
	assert.equal(getTask(w, "1").status, "in_progress", "nothing was written");
	assert.equal(
		(await updateTask(w.as("a"), { id: "1", status: "completed", result: "good" })).task.status,
		"completed",
	);
	assert.equal(seen.length, 2);
});

test("task_completed: a hold runs before the lock and the step is checked again after it allows", async () => {
	const w = taskWorld();
	await createTask(w.as("a"), { subject: "1" });
	await updateTask(w.as("a"), { id: "1", status: "in_progress" });
	let release: (v: string | undefined) => void = () => {};
	w.b.on("agent-teams:task_completed", (p) => (p as Payload).hold(new Promise((r) => (release = r))));
	const completing = updateTask(w.as("a"), { id: "1", status: "completed" });
	await settle(50);
	assert.equal(existsSync(join(w.dir, "1.json.lock")), false, "no task lock during the hold");
	// meanwhile the lead takes the task back
	await updateTask(w.as("lead"), { id: "1", status: "pending" });
	release(undefined);
	await assert.rejects(completing, /claimed before it is completed/);
	assert.equal(getTask(w, "1").status, "pending");
});

// --- teammate_idle

function idleWorld(holdTimeoutMs?: number) {
	const x = bus();
	const t = stubTeam("sess-idlehook", { events: x.b, holdTimeoutMs, warn: (m) => x.warns.push(m) });
	t.team.addMember("a", "a-id", "general-purpose", "idle");
	return { ...x, t };
}
const feedbackIn = (w: ReturnType<typeof idleWorld>) => w.t.wakes.map((x) => x.prompt());

test("teammate_idle: the payload names the teammate and its result or error; with no handler the lead gets the notice", async () => {
	const w = idleWorld();
	const seen: Payload[] = [];
	w.b.on("agent-teams:teammate_idle", (p) => seen.push(p as Payload));
	await w.t.team.exchangeEnded("a", { run: run("all done") });
	await w.t.team.exchangeEnded("a", { run: run("", { status: "failed", error: "boom" }) });
	assert.equal(seen[0]!.team, w.t.team.name);
	assert.equal(seen[0]!.name, "a");
	assert.equal(seen[0]!.agentId, "a-id");
	assert.equal(seen[0]!.result, "all done");
	assert.equal("error" in seen[0]!, false);
	assert.equal(seen[1]!.error, "boom");
	assert.equal("result" in seen[1]!, false);
	await w.t.team.deliverNow();
	assert.match(w.t.toLead.join("\n"), /a is idle. Its final answer:\nall done[\s\S]*Its exchange failed: boom/);
});

test("teammate_idle: a block sends the feedback to the teammate instead of the idle notice, so it keeps working", async () => {
	const w = idleWorld();
	w.b.on("agent-teams:teammate_idle", (p) => (p as Payload).block("the tests are not written yet"));
	await w.t.team.exchangeEnded("a", { run: run("done") });
	await w.t.team.deliverNow();
	assert.deepEqual(w.t.toLead, [], "no idle notice");
	assert.equal(w.t.wakes.length, 1, "the teammate is woken by the feedback");
	assert.match(feedbackIn(w)[0]!, /from="lead"[\s\S]*the tests are not written yet/);
});

test(`teammate_idle: at most ${MAX_IDLE_BLOCKS} blocks in a row; the next notice goes to the lead whatever the hooks say, and the count starts again`, async () => {
	const w = idleWorld();
	let blocking = true;
	let calls = 0;
	w.b.on("agent-teams:teammate_idle", (p) => {
		calls++;
		if (blocking) (p as Payload).block(`again ${calls}`);
	});
	for (let i = 1; i <= MAX_IDLE_BLOCKS; i++) {
		await w.t.team.exchangeEnded("a", { run: run(`done ${i}`) });
		await w.t.team.deliverNow();
		assert.deepEqual(w.t.toLead, [], `block ${i}`);
		w.t.wakes.at(-1)!.finish(); // the woken exchange is over in this test; the next end follows
	}
	await w.t.team.exchangeEnded("a", { run: run("done 4") });
	await w.t.team.deliverNow();
	assert.equal(w.t.toLead.length, 1, "the fourth goes to the lead");
	assert.match(w.t.toLead[0]!, /done 4/);
	assert.equal(calls, MAX_IDLE_BLOCKS + 1, "the handler still sees it");
	assert.equal(w.t.wakes.length, MAX_IDLE_BLOCKS, "and nobody was woken by it");
	// the count starts again after a notice went through
	await w.t.team.exchangeEnded("a", { run: run("done 5") });
	await w.t.team.deliverNow();
	assert.equal(w.t.toLead.length, 1, "blocked again");
	blocking = false;
	await w.t.team.exchangeEnded("a", { run: run("done 6") });
	await w.t.team.deliverNow();
	assert.equal(w.t.toLead.length, 2, "allowed");
});

test("teammate_idle: a hold is waited for in the background, so the exchange ends at once; then the verdict is applied", async () => {
	const w = idleWorld();
	let release: (v: string | undefined) => void = () => {};
	w.b.on("agent-teams:teammate_idle", (p) => (p as Payload).hold(new Promise((r) => (release = r))));
	const t0 = Date.now();
	assert.equal(await w.t.team.exchangeEnded("a", { run: run("done") }), "idle");
	assert.ok(Date.now() - t0 < 500, "exchangeEnded did not wait for the hook");
	await w.t.team.deliverNow();
	assert.deepEqual(w.t.toLead, [], "nothing yet");
	release("fix the lint errors");
	await settle(50);
	await w.t.team.deliverNow();
	assert.deepEqual(w.t.toLead, []);
	assert.match(feedbackIn(w)[0]!, /fix the lint errors/);
});

test("teammate_idle: a hold that allows sends the notice; one that times out sends it with a warning", async () => {
	const w = idleWorld(60);
	let mode: "allow" | "never" = "allow";
	w.b.on("agent-teams:teammate_idle", (p) =>
		(p as Payload).hold(mode === "allow" ? Promise.resolve(undefined) : new Promise(() => {})),
	);
	await w.t.team.exchangeEnded("a", { run: run("one") });
	await settle(30);
	await w.t.team.deliverNow();
	assert.equal(w.t.toLead.length, 1);
	mode = "never";
	await w.t.team.exchangeEnded("a", { run: run("two") });
	await settle(150);
	await w.t.team.deliverNow();
	assert.equal(w.t.toLead.length, 2, "allowed on the timeout");
	assert.match(w.warns.join("\n"), /agent-teams:teammate_idle: a handler's hold did not answer/);
});

test("teammate_idle: nothing is sent when the session ends, or the teammate stops, while a hold decides", async () => {
	const w = idleWorld();
	let release: (v: string | undefined) => void = () => {};
	w.b.on("agent-teams:teammate_idle", (p) => (p as Payload).hold(new Promise((r) => (release = r))));
	await w.t.team.exchangeEnded("a", { run: run("x") });
	const first = release;
	w.t.team.beginClose();
	await w.t.team.finishClose();
	first(undefined); // the hold answers after the team's files are gone
	await settle(50);
	assert.equal(existsSync(w.t.team.dir), false, "the team's files are gone and nothing recreated them");
	assert.deepEqual(w.t.toLead, []);
	// a teammate that stopped meanwhile
	const v = idleWorld();
	v.b.on("agent-teams:teammate_idle", (p) => (p as Payload).hold(new Promise((r) => (release = r))));
	await v.t.team.exchangeEnded("a", { run: run("x") });
	await v.t.team.exchangeEnded("a", { userStopped: true, run: run("y") }); // a second exchange ends stopped
	release(undefined);
	await settle(50);
	await v.t.team.deliverNow();
	assert.deepEqual(
		v.t.toLead.filter((m) => m.includes("final answer")),
		[],
		"no idle notice for a stopped teammate",
	);
});
