// Agent teams: the shared task list (team-tasks.ts): creating, dependencies, the status table and who may do what, assigning,
// views, liveness (a stopped member's tasks go back to pending) and retention.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	createTask,
	getTask,
	listTasks,
	releaseTasks,
	sweepTasks,
	type TaskEnv,
	taskLine,
	updateTask,
} from "../../../src/extensions/subagent/team-tasks.ts";
import { stubTeam } from "./team-helpers.ts";

// An environment for `me`: `live` are the members the roster says are live (the lead always is).
function world(live: string[] = ["a", "b"]) {
	const dir = join(mkdtempSync(join(tmpdir(), "tasks-")), "session-t");
	const assigned: { id: string; owner: string }[] = [];
	const warns: string[] = [];
	const as = (me: string, extra: Partial<TaskEnv> = {}): TaskEnv => ({
		dir,
		team: "session-t",
		me,
		lead: me === "lead",
		live: (n) => n === "lead" || live.includes(n),
		assign: me === "lead" ? async (t, owner) => void assigned.push({ id: t.id, owner }) : undefined,
		hooks: { bus: undefined, warn: (m) => warns.push(m) },
		...extra,
	});
	return { dir, as, lead: as("lead"), a: as("a"), b: as("b"), assigned, warns, live };
}
const claimed = async (env: TaskEnv, id: string) => updateTask(env, { id, status: "in_progress" });

test("create: ids count up from 1, the file is 0600 in a 0700 directory, the subject is trimmed, a subject is required", async () => {
	const w = world();
	const t1 = await createTask(w.a, { subject: "  first  ", description: "d" });
	const t2 = await createTask(w.lead, { subject: "second" });
	assert.deepEqual([t1.id, t2.id], ["1", "2"]);
	assert.equal(t1.subject, "first");
	assert.equal(t1.status, "pending");
	assert.equal(t1.createdBy, "a");
	assert.deepEqual(t1.blockedBy, []);
	assert.equal(readFileSync(join(w.dir, "next"), "utf8"), "3");
	assert.equal(statSync(join(w.dir, "1.json")).mode & 0o777, 0o600);
	assert.equal(statSync(w.dir).mode & 0o777, 0o700);
	assert.deepEqual(readdirSync(w.dir).sort(), ["1.json", "2.json", "next"], "no lock or temporary file is left");
	await assert.rejects(createTask(w.a, { subject: "  " }), /`subject` is required/);
	assert.deepEqual(
		listTasks(w).map((t) => t.id),
		["1", "2"],
	);
});

test("the id counter survives a lost `next`: a new id is above every task file", async () => {
	const w = world();
	await createTask(w.a, { subject: "x" });
	await createTask(w.a, { subject: "y" });
	writeFileSync(join(w.dir, "next"), "1"); // stale
	assert.equal((await createTask(w.a, { subject: "z" })).id, "3");
});

test("dependencies: an unknown id, itself, and a cycle (direct or through others) are refused", async () => {
	const w = world();
	const t1 = await createTask(w.a, { subject: "1" });
	const t2 = await createTask(w.a, { subject: "2", blockedBy: [t1.id] });
	const t3 = await createTask(w.a, { subject: "3", blockedBy: [t2.id] });
	await assert.rejects(createTask(w.a, { subject: "x", blockedBy: ["9"] }), /unknown task "9"/);
	await assert.rejects(createTask(w.a, { subject: "x", blockedBy: ["nope"] }), /not a task id/);
	await assert.rejects(updateTask(w.a, { id: "1", blockedBy: ["1"] }), /cycle: task 1 cannot be blocked by itself/);
	await assert.rejects(updateTask(w.a, { id: "1", blockedBy: ["2"] }), /cycle: 1 -> 2 -> 1/);
	await assert.rejects(updateTask(w.a, { id: "1", blockedBy: ["3"] }), /cycle: 1 -> 3 -> 2 -> 1/);
	await assert.rejects(updateTask(w.a, { id: "1", blockedBy: ["7"] }), /unknown task "7"/);
	assert.deepEqual(getTask(w, "1").blockedBy, [], "a refused change writes nothing");
	// a legal change replaces the list
	await updateTask(w.a, { id: t3.id, blockedBy: [t1.id] });
	assert.deepEqual(getTask(w, "3").blockedBy, ["1"]);
});

test("claim: blocked until every blocker is completed (the ids are named); completing one unblocks it; reopening blocks again", async () => {
	const w = world();
	await createTask(w.a, { subject: "1" });
	await createTask(w.a, { subject: "2" });
	await createTask(w.a, { subject: "3", blockedBy: ["1", "2"] });
	await assert.rejects(claimed(w.b, "3"), /blocked: task 3 waits for #1, #2/);
	await claimed(w.a, "1");
	await updateTask(w.a, { id: "1", status: "completed", result: "r1" });
	await assert.rejects(claimed(w.b, "3"), /blocked: task 3 waits for #2/);
	await claimed(w.a, "2");
	await updateTask(w.a, { id: "2", status: "completed" });
	const got = await claimed(w.b, "3");
	assert.equal(got.task.owner, "b");
	assert.equal(got.task.status, "in_progress");
	// the lead reopens a dependency: a dependent not yet claimed is blocked again
	await createTask(w.a, { subject: "4", blockedBy: ["1"] });
	await updateTask(w.lead, { id: "1", status: "pending" });
	await assert.rejects(claimed(w.b, "4"), /blocked: task 4 waits for #1/);
	assert.match(taskLine(w.dir, getTask(w, "4")), /\(blocked by #1\)/);
});

test("claim: a task a live member owns is a conflict naming the owner; an owner that is not live does not hold it", async () => {
	const w = world(["a", "b"]);
	await createTask(w.a, { subject: "1" });
	await claimed(w.a, "1");
	await assert.rejects(claimed(w.b, "1"), /conflict: a owns task 1/);
	// a's task is in_progress, so b cannot even claim it from pending; release it to a state where an owner remains
	await createTask(w.a, { subject: "2" });
	await updateTask(w.lead, { id: "2", owner: "a" }); // assigned, still pending
	await assert.rejects(claimed(w.b, "2"), /conflict: a owns task 2/);
	await assert.rejects(claimed(w.lead, "2"), /conflict: a owns task 2/);
	const gone = world(["b"]); // a is not live
	await createTask(gone.lead, { subject: "x" });
	await updateTask(gone.lead, { id: "1", owner: "b" });
	const g2 = gone.as("c", { live: (n) => n === "b" || n === "lead" });
	await assert.rejects(claimed(g2, "1"), /conflict: b owns task 1/);
	const g3 = gone.as("c", { live: (n) => n === "lead" }); // b has stopped
	assert.equal((await claimed(g3, "1")).task.owner, "c", "the task of a member that is not live is free");
	// an in_progress task whose owner has stopped (and was not released yet) is taken over
	const t4 = await createTask(w.a, { subject: "4" });
	await claimed(w.a, t4.id);
	const b2 = w.as("b", { live: (n) => n === "lead" });
	assert.equal((await claimed(b2, t4.id)).task.owner, "b");
	// the same member claiming its own assigned task is no conflict
	const t5 = await createTask(w.a, { subject: "5" });
	await updateTask(w.lead, { id: t5.id, owner: "b" });
	assert.equal((await claimed(w.b, t5.id)).task.owner, "b");
	assert.equal((await claimed(w.b, t5.id)).task.owner, "b", "claiming it again changes nothing");
});

test("claim is for yourself: another owner with a status is refused, whoever asks", async () => {
	const w = world();
	await createTask(w.a, { subject: "1" });
	await assert.rejects(updateTask(w.b, { id: "1", status: "in_progress", owner: "a" }), /a claim is for yourself/);
	await assert.rejects(updateTask(w.lead, { id: "1", status: "in_progress", owner: "a" }), /a claim is for yourself/);
	assert.equal((await updateTask(w.b, { id: "1", status: "in_progress", owner: "b" })).task.owner, "b");
});

test("the status table: who may complete, release, reopen; pending to completed and completed to in_progress are refused", async () => {
	const w = world();
	await createTask(w.a, { subject: "1" });
	await assert.rejects(updateTask(w.a, { id: "1", status: "completed" }), /claimed before it is completed/);
	await claimed(w.a, "1");
	await assert.rejects(
		updateTask(w.b, { id: "1", status: "completed" }),
		/forbidden: only the owner \(a\) or the lead completes/,
	);
	await assert.rejects(
		updateTask(w.b, { id: "1", status: "pending" }),
		/forbidden: only the owner \(a\) or the lead releases/,
	);
	// release by the owner clears the owner
	const released = await updateTask(w.a, { id: "1", status: "pending" });
	assert.equal(released.task.owner, undefined);
	assert.equal(released.task.status, "pending");
	// the lead completes a task another member owns
	await claimed(w.b, "1");
	const done = await updateTask(w.lead, { id: "1", status: "completed", result: "by lead" });
	assert.equal(done.task.status, "completed");
	assert.equal(done.task.owner, "b");
	assert.equal(done.task.result, "by lead");
	await assert.rejects(claimed(w.a, "1"), /is completed: the lead reopens it/);
	await assert.rejects(updateTask(w.a, { id: "1", status: "pending" }), /forbidden: only the lead reopens/);
	const reopened = await updateTask(w.lead, { id: "1", status: "pending" });
	assert.equal(reopened.task.status, "pending");
	assert.equal(reopened.task.owner, undefined);
	assert.equal((await claimed(w.a, "1")).task.owner, "a");
});

test("who may change what else: subject, description and blockedBy by the creator or the lead; a result by the owner or the lead", async () => {
	const w = world();
	await createTask(w.a, { subject: "1" });
	await createTask(w.a, { subject: "2" });
	await assert.rejects(updateTask(w.b, { id: "1", subject: "x" }), /forbidden: only its creator \(a\) or the lead/);
	await assert.rejects(updateTask(w.b, { id: "1", description: "x" }), /forbidden/);
	await assert.rejects(updateTask(w.b, { id: "1", blockedBy: ["2"] }), /forbidden/);
	assert.equal(
		(await updateTask(w.a, { id: "1", subject: " renamed ", description: "more" })).task.subject,
		"renamed",
	);
	assert.equal((await updateTask(w.lead, { id: "1", description: "by lead" })).task.description, "by lead");
	await assert.rejects(updateTask(w.a, { id: "1", subject: " " }), /cannot be empty/);
	await claimed(w.a, "1");
	await assert.rejects(updateTask(w.b, { id: "1", result: "r" }), /forbidden: only the owner \(a\) or the lead sets/);
	assert.equal((await updateTask(w.a, { id: "1", result: "partial" })).task.result, "partial");
});

test('assign: only the lead, only a pending task, only a live member; the owner is told; "" takes the owner away', async () => {
	const w = world(["a"]);
	await createTask(w.lead, { subject: "1" });
	await assert.rejects(updateTask(w.a, { id: "1", owner: "a" }), /forbidden: only the lead assigns/);
	await assert.rejects(updateTask(w.lead, { id: "1", owner: "ghost" }), /no live member "ghost"/);
	const done = await updateTask(w.lead, { id: "1", owner: "a" });
	assert.equal(done.task.owner, "a");
	assert.equal(done.task.status, "pending", "an assignment is not a claim");
	assert.deepEqual(w.assigned, [{ id: "1", owner: "a" }]);
	await updateTask(w.lead, { id: "1", owner: "a" });
	assert.equal(w.assigned.length, 1, "the same owner again tells nobody again");
	await updateTask(w.lead, { id: "1", owner: "" });
	assert.equal(getTask(w, "1").owner, undefined);
	await updateTask(w.lead, { id: "1", owner: "lead" });
	assert.equal(w.assigned.length, 1, "a task the lead gives itself needs no message");
	await updateTask(w.lead, { id: "1", owner: "" });
	await claimed(w.a, "1");
	await assert.rejects(updateTask(w.lead, { id: "1", owner: "a" }), /only a pending task is assigned/);
});

test("assign: when telling the owner fails the task stays assigned and the result carries a warning", async () => {
	const w = world(["a"]);
	const lead = w.as("lead", {
		assign: async () => {
			throw new Error("a is stopped");
		},
	});
	await createTask(lead, { subject: "1" });
	const r = await updateTask(lead, { id: "1", owner: "a" });
	assert.equal(r.task.owner, "a");
	assert.match(r.warning ?? "", /assigned to a, but telling it failed: a is stopped/);
});

test("an update that changes nothing writes nothing", async () => {
	const w = world();
	const t = await createTask(w.a, { subject: "1" });
	await new Promise((r) => setTimeout(r, 5));
	const same = await updateTask(w.a, { id: "1", status: "pending", subject: "1" });
	assert.equal(same.task.updatedAt, t.updatedAt);
});

test("a file that is not a task is skipped by the list; a task with a bad shape cannot be read", async () => {
	const w = world();
	await createTask(w.a, { subject: "1" });
	writeFileSync(join(w.dir, "2.json"), "not json");
	writeFileSync(join(w.dir, "3.json"), JSON.stringify({ id: "3", subject: 5 }));
	writeFileSync(join(w.dir, "4.json"), JSON.stringify({ ...getTask(w, "1"), id: "9" })); // id does not match its name
	assert.deepEqual(
		listTasks(w).map((t) => t.id),
		["1"],
	);
	assert.throws(() => getTask(w, "2"), /no task "2"/);
	assert.throws(() => getTask(w, "x"), /not a task id/);
});

test("liveness: a member that stops has its in_progress tasks go back to pending, with no owner; others' and pending ones stay", async () => {
	const t = stubTeam("sess-release");
	const dir = t.team.tasksDir;
	const w = { dir, team: t.team.name, hooks: { bus: undefined, warn: () => {} } };
	const env = (me: string): TaskEnv => ({ ...w, me, lead: me === "lead", live: () => true });
	await createTask(env("a"), { subject: "1" });
	await createTask(env("a"), { subject: "2" });
	await createTask(env("a"), { subject: "3" });
	await createTask(env("a"), { subject: "4" });
	await claimed(env("a"), "1");
	await claimed(env("b"), "2");
	await updateTask(env("lead"), { id: "3", owner: "a" }); // assigned, pending: not released
	await claimed(env("a"), "4");
	await updateTask(env("a"), { id: "4", status: "completed" }); // completed: not released
	t.team.addMember("a", "a-id", "general-purpose", "running");
	t.team.addMember("b", "b-id", "general-purpose", "running");
	await t.team.exchangeEnded("a", { userStopped: true, run: undefined });
	await t.team.flush();
	assert.deepEqual(
		listTasks({ dir }).map((x) => [x.id, x.status, x.owner]),
		[
			["1", "pending", undefined],
			["2", "in_progress", "b"],
			["3", "pending", "a"],
			["4", "completed", "a"],
		],
	);
	assert.deepEqual(await releaseTasks(dir, "b"), ["2"]);
});

test("session end keeps the tasks as they are (a stopped-by-the-end teammate's tasks are not released)", async () => {
	const t = stubTeam("sess-end-tasks");
	const dir = t.team.tasksDir;
	const env: TaskEnv = {
		dir,
		team: t.team.name,
		me: "a",
		lead: false,
		live: () => true,
		hooks: { bus: undefined, warn: () => {} },
	};
	await createTask(env, { subject: "1" });
	await claimed(env, "1");
	t.team.addMember("a", "a-id", "general-purpose", "running");
	t.team.beginClose();
	await t.team.exchangeEnded("a", { aborted: true });
	await t.team.finishClose();
	assert.equal(getTask({ dir }, "1").owner, "a");
	assert.equal(getTask({ dir }, "1").status, "in_progress");
});

test("retention: session task directories whose newest file is older than the limit go; the current, recent, live-lead and other directories stay", () => {
	const root = mkdtempSync(join(tmpdir(), "retain-"));
	const tasks = join(root, "tasks");
	const teamsDir = join(root, "teams");
	const DAY = 86_400_000;
	const now = Date.now();
	const make = (name: string, ageDays: number, files = ["1.json", "next"]) => {
		mkdirSync(join(tasks, name), { recursive: true });
		for (const f of files) {
			writeFileSync(join(tasks, name, f), "x");
			const at = new Date(now - ageDays * DAY);
			utimesSync(join(tasks, name, f), at, at);
		}
	};
	make("session-old", 40);
	make("session-recent", 5);
	make("session-mixed", 40);
	utimesSync(join(tasks, "session-mixed", "next"), new Date(now - DAY), new Date(now - DAY)); // one fresh file keeps it
	make("session-current", 90);
	make("session-livelead", 90);
	mkdirSync(join(teamsDir, "session-livelead"), { recursive: true });
	writeFileSync(join(teamsDir, "session-livelead", "config.json"), JSON.stringify({ leadPid: process.pid }));
	make("session-deadlead", 90);
	mkdirSync(join(teamsDir, "session-deadlead"), { recursive: true });
	writeFileSync(join(teamsDir, "session-deadlead", "config.json"), JSON.stringify({ leadPid: 2 ** 22 + 12345 }));
	make("notes", 90); // not a team's directory
	make("session-lockonly", 40, ["1.json"]);
	writeFileSync(join(tasks, "session-lockonly", ".lock"), "x"); // a lock file is not a task: it does not make it new
	const removed = sweepTasks(tasks, "session-current", 30, teamsDir, now).sort();
	assert.deepEqual(removed, ["session-deadlead", "session-lockonly", "session-old"]);
	assert.deepEqual(readdirSync(tasks).sort(), [
		"notes",
		"session-current",
		"session-livelead",
		"session-mixed",
		"session-recent",
	]);
	assert.deepEqual(sweepTasks(join(root, "nothing"), "x", 30, teamsDir, now), []);
});
