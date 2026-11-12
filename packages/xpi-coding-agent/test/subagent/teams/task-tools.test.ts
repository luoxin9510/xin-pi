// Agent teams: the four task tools in the lead and in a teammate's process, the teammate_idle event end to end, retention at
// team creation, and the prompts that mention the task list. A fake `pi --mode rpc` child plays each teammate.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { registry } from "../../../src/extensions/subagent/registry.ts";
import { teams } from "../../../src/extensions/subagent/team.ts";
import { registerTeamTools } from "../../../src/extensions/subagent/team-send.ts";
import { LEAD_PROMPT, teammatePrompt } from "../../../src/extensions/subagent/team-text.ts";
import { ev, loadTool, sandbox } from "../helpers.ts";
import { cleanupLater } from "./team-helpers.ts";

const until = async (what: string, pred: () => boolean, ms = 30_000) => {
	const t0 = Date.now();
	while (!pred()) {
		if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 20));
	}
};
const ok = (text = "done") => [ev.session(), ev.assistant(text), ev.turnEnd(), ev.settled()];
const TOOLS = ["TaskCreate", "TaskGet", "TaskList", "TaskUpdate"];

let n = 0;
async function lead(settings: Record<string, unknown> | null = { enabled: true }) {
	const s = sandbox();
	const sessionId = `0190task-${++n}-${Math.random().toString(16).slice(2, 8)}`;
	process.env.XPI_CODING_AGENT_DIR = join(s.root, "agent");
	const t = await loadTool(
		{},
		{
			cwd: s.repo,
			sessionFile: join(s.root, "parent.jsonl"),
			sessionId,
			topSettings: settings === null ? {} : { agentTeams: settings },
		},
	);
	const call = async (name: string, params: Record<string, unknown>) =>
		(await t.tools[name].execute("c", params, undefined, undefined, t.ctx)).structuredContent;
	const end = () => t.emit("session_shutdown", {});
	cleanupLater(end);
	const tasksDir = join(s.root, "agent", "tasks", `session-${sessionId}`);
	return { s, t, sessionId, call, end, tasksDir, messages: () => t.messages.map((m) => m.message.content as string) };
}

// A teammate's own tools, as its child process registers them (it reads config.json for who is live).
function mine(team: { dir: string; name: string }, name: string, events?: unknown) {
	const tools: Record<string, any> = {};
	registerTeamTools({ registerTool: (t: any) => (tools[t.name] = t), events } as any, {
		XPI_TEAM: team.name,
		XPI_TEAM_DIR: team.dir,
		XPI_TEAM_MEMBER: name,
		XPI_TEAM_TOOLS: "codemode",
	});
	const call = async (tool: string, params: Record<string, unknown>) =>
		(await tools[tool].execute("c", params, undefined, undefined, { abort() {} })).structuredContent;
	return { tools, call };
}

test("the lead gets the four task tools with codemode exposure while teams are on, and none with teams off", async () => {
	const on = await lead();
	const off = await lead(null);
	try {
		for (const name of TOOLS) {
			assert.equal(on.t.tools[name]?.exposure, "codemode", name);
			assert.equal(off.t.tools[name], undefined, `${name} with teams off`);
		}
		assert.equal(off.t.tools.SendMessage.exposure, "codemode");
		assert.match(LEAD_PROMPT, /TaskCreate/);
		await off.t.emit("before_agent_start", { messageType: "x", systemPromptOptions: { sections: {} } });
	} finally {
		await on.end();
		await off.end();
	}
});

test("with teams off a lead's prompt sections carry no task text", async () => {
	const off = await lead(null);
	try {
		const sections: Record<string, string> = {};
		await off.t.emit("before_agent_start", { messageType: "other", systemPromptOptions: { sections } });
		assert.deepEqual(sections, {});
	} finally {
		await off.end();
	}
});

test("the lead uses the task list before it has a teammate; the tasks are files in the agent dir and stay after the session", async () => {
	const x = await lead();
	const a = await x.call("TaskCreate", { subject: "write tests", description: "all of them" });
	const b = await x.call("TaskCreate", { subject: "ship it", blockedBy: [a.id] });
	assert.deepEqual([a.id, a.createdBy, a.status], ["1", "lead", "pending"]);
	assert.ok(existsSync(join(x.tasksDir, "1.json")));
	const list = await x.call("TaskList", {});
	assert.deepEqual(
		list.tasks.map((t: any) => [t.id, t.openBlockers]),
		[
			["1", []],
			["2", ["1"]],
		],
	);
	assert.equal((await x.call("TaskGet", { id: b.id })).subject, "ship it");
	await assert.rejects(x.call("TaskUpdate", { id: "2", status: "in_progress" }), /blocked: task 2 waits for #1/);
	assert.equal((await x.call("TaskUpdate", { id: "1", status: "in_progress" })).owner, "lead");
	const text = (await x.t.tools.TaskList.execute("c", {}, undefined, undefined, x.t.ctx)).content[0].text;
	assert.match(text, /#1 \[in_progress\] lead: write tests/);
	assert.match(text, /#2 \[pending\] -: ship it \(blocked by #1\)/);
	await x.end();
	assert.ok(existsSync(join(x.tasksDir, "1.json")), "the tasks are kept at the session's end");
	assert.equal(existsSync(join(x.tasksDir, "..", "..", "teams", `session-${x.sessionId}`)), false);
});

test(
	"the lead gives a teammate a task: the teammate is told, claims it with its own tool, and a second teammate gets a conflict",
	{ timeout: 60_000 },
	async () => {
		const x = await lead();
		x.s.scenario({ lines: [ev.session()], hang: true, abortSettles: true, takeSteers: true });
		const a = (await x.t.run({ name: "a" })).structuredContent;
		const b = (await x.t.run({ name: "b" })).structuredContent;
		await until(
			"both children",
			() => registry.handle(a.agentId) !== undefined && registry.handle(b.agentId) !== undefined,
		);
		const heard: string[] = [];
		registry.watch(a.agentId, (e) => {
			const m = e.message as { role?: string; content?: string } | undefined;
			if (e.type === "message_end" && m?.role === "user") heard.push(m.content!);
		});
		await until("config.json lists both", () => {
			const members = JSON.parse(readFileSync(teams.current()!.configPath, "utf8")).members as {
				name: string;
				status: string;
			}[];
			return ["a", "b"].every((nm) => members.some((m) => m.name === nm && m.status === "running"));
		});
		const team = teams.current()!;
		const ta = mine(team, "a");
		const tb = mine(team, "b");
		const task = await x.call("TaskCreate", { subject: "fix the parser" });
		await x.call("TaskUpdate", { id: task.id, owner: "a" });
		await until("the assignment", () => heard.length === 1);
		assert.match(heard[0]!, /Task #1 is assigned to you: fix the parser[\s\S]*TaskUpdate/);
		await assert.rejects(tb.call("TaskUpdate", { id: "1", status: "in_progress" }), /conflict: a owns task 1/);
		await assert.rejects(tb.call("TaskUpdate", { id: "1", owner: "b" }), /forbidden: only the lead assigns/);
		assert.equal((await ta.call("TaskUpdate", { id: "1", status: "in_progress" })).owner, "a");
		assert.equal((await tb.call("TaskGet", { id: "1" })).status, "in_progress", "the same list in another process");
		// a teammate creates a task, and the lead sees it
		const made = await tb.call("TaskCreate", { subject: "follow-up", blockedBy: ["1"] });
		assert.equal(made.createdBy, "b");
		assert.equal((await x.call("TaskGet", { id: made.id })).createdBy, "b");
		// a stops: its in_progress task goes back to pending
		registry.stop(a.agentId);
		await until("a's task is released", () => {
			const t = JSON.parse(readFileSync(join(x.tasksDir, "1.json"), "utf8"));
			return t.status === "pending" && t.owner === undefined;
		});
		assert.equal((await tb.call("TaskUpdate", { id: "1", status: "in_progress" })).owner, "b");
		registry.stop(b.agentId);
		await x.end();
	},
);

test("a teammate's tool takes a task whose owner config.json lists as stopped, and refuses one whose owner is idle", async () => {
	const root = join(sandbox().root, "agent");
	const team = { dir: join(root, "teams", "session-x"), name: "session-x" };
	mkdirSync(team.dir, { recursive: true });
	const config = (members: { name: string; status: string }[]) =>
		writeFileSync(join(team.dir, "config.json"), JSON.stringify({ team: team.name, members }));
	config([
		{ name: "lead", status: "running" },
		{ name: "a", status: "idle" },
		{ name: "b", status: "running" },
	]);
	const tasks = join(root, "tasks", "session-x");
	mkdirSync(tasks, { recursive: true });
	const base = { subject: "s", description: "", blockedBy: [], createdBy: "lead", createdAt: 1, updatedAt: 1 };
	writeFileSync(join(tasks, "1.json"), JSON.stringify({ ...base, id: "1", status: "in_progress", owner: "a" }));
	const b = mine(team, "b");
	await assert.rejects(b.call("TaskUpdate", { id: "1", status: "in_progress" }), /conflict: a owns task 1/);
	config([
		{ name: "lead", status: "running" },
		{ name: "a", status: "stopped" },
		{ name: "b", status: "running" },
	]);
	assert.equal((await b.call("TaskUpdate", { id: "1", status: "in_progress" })).owner, "b");
	config([{ name: "lead", status: "running" }]); // b itself is gone from the roster: not live, but its own claim reads no roster
	assert.equal((await b.call("TaskGet", { id: "1" })).owner, "b");
});

test("a teammate's task tools are direct tools when the child has no codemode", () => {
	const tools: Record<string, any> = {};
	registerTeamTools({ registerTool: (t: any) => (tools[t.name] = t) } as any, {
		XPI_TEAM: "session-x",
		XPI_TEAM_DIR: join(sandbox().root, "agent", "teams", "session-x"),
		XPI_TEAM_MEMBER: "a",
		XPI_TEAM_TOOLS: "direct",
	});
	for (const name of ["SendMessage", ...TOOLS]) assert.equal(tools[name].exposure, "direct", name);
	const lone: Record<string, any> = {};
	registerTeamTools({ registerTool: (t: any) => (lone[t.name] = t) } as any, {});
	assert.deepEqual(Object.keys(lone), [], "an ordinary subagent has none");
});

test("the events reach the extensions in both processes: the lead's TaskCreate and a teammate's TaskUpdate can be blocked", async () => {
	const x = await lead();
	x.t.events.on("agent-teams:task_created", (p: any) => p.task.subject === "bad" && p.block("name it better"));
	await assert.rejects(x.call("TaskCreate", { subject: "bad" }), /refused by a hook: name it better/);
	assert.equal((await x.call("TaskCreate", { subject: "good" })).id, "1");
	const team = {
		dir: join(dirname(dirname(x.tasksDir)), "teams", `session-${x.sessionId}`),
		name: `session-${x.sessionId}`,
	};
	mkdirSync(team.dir, { recursive: true });
	writeFileSync(
		join(team.dir, "config.json"),
		JSON.stringify({
			team: team.name,
			members: [
				{ name: "lead", status: "running" },
				{ name: "w", status: "running" },
			],
		}),
	);
	const bus = x.t.events;
	bus.on("agent-teams:task_completed", (p: any) => p.block("not yet"));
	const w = mine(team, "w", bus);
	await w.call("TaskUpdate", { id: "1", status: "in_progress" });
	await assert.rejects(w.call("TaskUpdate", { id: "1", status: "completed" }), /refused by a hook: not yet/);
	await x.end();
});

test(
	"teammate_idle end to end: a hook's block sends its feedback to the teammate, and the next idle goes to the lead",
	{ timeout: 60_000 },
	async () => {
		const x = await lead();
		let blocked = 0;
		x.t.events.on("agent-teams:teammate_idle", (p: any) => {
			if (blocked++ === 0) p.block("also run the linter");
		});
		x.s.scenario({ lines: ok("first answer") });
		await x.t.run({ name: "w", prompt: "do the thing" });
		await until("the teammate got the feedback", () => {
			try {
				return x.s
					.record()
					.commands.some((c) => c.type === "prompt" && /also run the linter/.test(c.message ?? ""));
			} catch {
				return false;
			}
		});
		await until("the idle notice", () => x.messages().some((m) => /kind="idle"/.test(m)));
		assert.equal(blocked, 2, "the event fired for each end");
		assert.equal(x.messages().filter((m) => /kind="idle"/.test(m)).length, 1, "only the second end reached the lead");
		await x.end();
	},
);

test(
	"creating the team removes task directories older than taskRetentionDays and keeps the session's own",
	{ timeout: 60_000 },
	async () => {
		const x = await lead({ enabled: true, taskRetentionDays: 10 });
		await x.call("TaskCreate", { subject: "mine" });
		const tasks = dirname(x.tasksDir);
		const mk = (name: string, ageDays: number) => {
			mkdirSync(join(tasks, name), { recursive: true });
			writeFileSync(join(tasks, name, "1.json"), "{}");
			const at = new Date(Date.now() - ageDays * 86_400_000);
			utimesSync(join(tasks, name, "1.json"), at, at);
		};
		mk("session-ancient", 40);
		mk("session-fresh", 2);
		x.s.scenario({ lines: ok() });
		await x.t.run({ name: "w" });
		assert.equal(existsSync(join(tasks, "session-ancient")), false);
		assert.ok(existsSync(join(tasks, "session-fresh")));
		assert.ok(existsSync(x.tasksDir));
		await x.end();
	},
);

test("the prompts: the teammate's section explains the task list and self-claiming; the lead's says how to use it", () => {
	const mate = teammatePrompt("session-0190abcd-xxxx", "w", ["lead", "w"]);
	for (const part of [
		/TaskList/,
		/TaskCreate/,
		/TaskUpdate/,
		/status: "in_progress"/,
		/blocked.*conflict|`blocked` or `conflict`/,
		/claim the next unblocked, unowned one/,
	]) {
		assert.match(mate, part);
	}
	assert.match(LEAD_PROMPT, /task list[\s\S]*blockedBy/);
	assert.match(LEAD_PROMPT, /owner: name/);
});

test(
	"the lead marks its task directory on use and at start of a resumed session; retention of another session leaves it",
	{ timeout: 60_000 },
	async () => {
		const x = await lead({ enabled: true, taskRetentionDays: 1 });
		await x.call("TaskList", {});
		assert.equal(existsSync(x.tasksDir), false, "a read creates no directory and no marker");
		await x.call("TaskCreate", { subject: "mine" });
		assert.equal(JSON.parse(readFileSync(join(x.tasksDir, ".lead"), "utf8")).pid, process.pid);
		const tasks = dirname(x.tasksDir);
		const old = new Date(Date.now() - 90 * 86_400_000);
		// a resumed session's list, old on disk, and a started team in this process
		mkdirSync(join(tasks, "session-resumed"), { recursive: true });
		writeFileSync(join(tasks, "session-resumed", "1.json"), "{}");
		utimesSync(join(tasks, "session-resumed", "1.json"), old, old);
		writeFileSync(join(tasks, "session-resumed", ".lead"), JSON.stringify({ pid: process.pid, at: Date.now() }));
		x.s.scenario({ lines: ok() });
		await x.t.run({ name: "w" });
		assert.ok(existsSync(join(tasks, "session-resumed")), "a live lead's list stays");
		await x.end();
	},
);

test("a teammate process without XPI_TEAM registers SendMessage but no task tools", () => {
	const tools: Record<string, any> = {};
	registerTeamTools({ registerTool: (t: any) => (tools[t.name] = t) } as any, {
		XPI_TEAM_DIR: join(sandbox().root, "agent", "teams", "session-x"),
		XPI_TEAM_MEMBER: "a",
		XPI_TEAM_TOOLS: "direct",
	});
	assert.deepEqual(Object.keys(tools), ["SendMessage"]);
});
