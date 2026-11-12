// Agent teams: where they are on, starting a teammate with a named Agent call and the refusals, the teammate's process
// (environment, tools, prompt), the lead's side (idle notice, no group message), the cap, and former teammates after a
// reload. A fake `pi --mode rpc` child plays each teammate (test/subagent/fake-pi.mjs).
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { scripts } from "../../../src/extensions/subagent/background.ts";
import { registry } from "../../../src/extensions/subagent/registry.ts";
import { teams } from "../../../src/extensions/subagent/team.ts";
import { agentFile, codemodeStandIn, ev, flag, loadTool, sandbox } from "../helpers.ts";

const ok = (text = "done") => [ev.session(), ev.assistant(text), ev.turnEnd(), ev.settled()];
const until = async (what: string, pred: () => boolean, ms = 30_000) => {
	const t0 = Date.now();
	while (!pred()) {
		if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 20));
	}
};
// What the latest child recorded, once it has its prompt (the file is written as the child starts and grows).
async function recorded(x: { s: ReturnType<typeof sandbox> }) {
	let last: ReturnType<typeof x.s.record> | undefined;
	await until("the child's record", () => {
		try {
			last = x.s.record();
			return last.commands.some((c) => c.type === "prompt");
		} catch {
			return false;
		}
	});
	return last!;
}
const ON = { agentTeams: { enabled: true } };

let n = 0;
async function setup(
	options: { top?: Record<string, unknown>; mode?: string; noSession?: boolean; hasUI?: boolean } = {},
) {
	const s = sandbox();
	const sessionId = `0190teams-${++n}-${Math.random().toString(16).slice(2, 8)}`;
	process.env.XPI_CODING_AGENT_DIR = join(s.root, "agent");
	const sessionFile = options.noSession ? undefined : join(s.root, "parent.jsonl");
	const load = () =>
		loadTool(
			{},
			{
				cwd: s.repo,
				sessionFile,
				sessionId,
				topSettings: options.top ?? ON,
				mode: options.mode,
				hasUI: options.hasUI,
			},
		);
	const t = await load();
	const teamDir = join(s.root, "agent", "teams", `session-${sessionId}`);
	const messages = () => t.messages.map((m) => m.message.content as string);
	const send = async (params: Record<string, unknown>) =>
		(await t.tools.SendMessage.execute("send-1", params, undefined, undefined, t.ctx)).structuredContent;
	return { s, t, sessionId, teamDir, load, messages, send, end: () => t.emit("session_shutdown", {}) };
}

test("where teams are on: tui, a saved session, the setting or the environment variable", async () => {
	const cases: { name: string; options: Parameters<typeof setup>[0]; env?: string; on: boolean }[] = [
		{ name: "tui with the setting", options: {}, on: true },
		{ name: "the setting as true", options: { top: { agentTeams: true } }, on: true },
		{ name: "no setting", options: { top: {} }, on: false },
		{ name: "enabled false", options: { top: { agentTeams: { enabled: false } } }, on: false },
		{ name: "the variable alone", options: { top: {} }, env: "1", on: true },
		{ name: "the variable with the setting false", options: { top: { agentTeams: false } }, env: "1", on: true },
		{ name: "print mode", options: { mode: "print", hasUI: false }, on: false },
		{ name: "rpc mode (hasUI is true there)", options: { mode: "rpc" }, on: false },
		{ name: "--no-session", options: { noSession: true }, on: false },
	];
	for (const c of cases) {
		if (c.env) process.env.XPI_EXPERIMENTAL_AGENT_TEAMS = c.env;
		else delete process.env.XPI_EXPERIMENTAL_AGENT_TEAMS;
		const x = await setup(c.options);
		try {
			assert.equal(teams.on, c.on, c.name);
			// the lead's SendMessage declares the shutdown arguments only with teams on
			const props = Object.keys(x.t.tools.SendMessage.parameters.properties);
			assert.equal(props.includes("kind"), c.on, c.name);
			assert.equal(x.t.tools.SendMessage.parameters.required?.includes("message") ?? false, !c.on, c.name);
			x.s.scenario({ lines: ok("plain") });
			const r = (await x.t.run({ name: "w" })).structuredContent;
			assert.equal(r.status, c.on ? "started" : "completed", `${c.name}: a named call`);
		} finally {
			delete process.env.XPI_EXPERIMENTAL_AGENT_TEAMS;
			await x.end();
		}
	}
});

test("a bad agentTeams setting stops the session start, naming the key", async () => {
	await assert.rejects(
		setup({ top: { agentTeams: { maxTeammates: 0, enabled: true } } }),
		/agentTeams\.maxTeammates must be a positive integer/,
	);
	await assert.rejects(setup({ top: { agentTeams: "yes" } }), /agentTeams must be true, false or an object/);
});

test("the lead's tool declaration is unchanged with teams off", async () => {
	const off = await setup({ top: {} });
	const on = await setup();
	try {
		assert.deepEqual(Object.keys(off.t.tools.SendMessage.parameters.properties), ["to", "message", "summary"]);
		assert.deepEqual(off.t.tools.SendMessage.parameters.required, ["to", "message"]);
		assert.ok(!off.t.tools.Agent.description.includes("Agent teams are on"));
		assert.ok(on.t.tools.Agent.description.includes("Agent teams are on"));
	} finally {
		await off.end();
		await on.end();
	}
});

test("a named call starts a teammate and returns at once; the team, its files and the child's environment and prompt", async () => {
	const x = await setup();
	x.s.scenario({
		lines: [ev.session(), ev.tool("read"), ev.assistant("final"), ev.turnEnd(), ev.settled()],
		delayMs: 300,
	});
	const t0 = Date.now();
	const r = (await x.t.run({ name: "worker", description: "does work", prompt: "do the thing" })).structuredContent;
	assert.ok(Date.now() - t0 < 250, "it did not wait for the teammate");
	assert.equal(r.status, "started");
	assert.equal(r.name, "worker");
	assert.equal(r.team, `session-${x.sessionId.slice(0, 8)}`);
	assert.equal(r.agentType, "general-purpose");
	// the team on disk is named after the whole session id
	const config = JSON.parse(readFileSync(join(x.teamDir, "config.json"), "utf8"));
	assert.equal(config.team, `session-${x.sessionId}`);
	assert.equal(config.leadPid, process.pid);
	assert.deepEqual(
		config.members.map((m: { name: string }) => m.name),
		["lead", "worker"],
	);
	await until("the child", () => registry.handle(r.agentId) !== undefined);
	const rec = await recorded(x);
	assert.deepEqual(rec.team, {
		XPI_TEAM: `session-${x.sessionId}`,
		XPI_TEAM_MEMBER: "worker",
		XPI_TEAM_DIR: x.teamDir,
		XPI_TEAM_TOOLS: "codemode",
	});
	assert.equal(flag(rec.argv, "--tools"), "+codemode,+SendMessage");
	assert.equal(flag(rec.argv, "--exclude-tools"), undefined);
	assert.match(rec.systemPromptTail!, /# Agent team\nYou are "worker", a teammate in team session-/);
	assert.match(rec.systemPromptTail!, /Members when you started: lead, worker\./);
	assert.doesNotMatch(
		rec.systemPrompt!,
		/worker/,
		"the head does not name the agent: children share the cache prefix",
	);
	assert.doesNotMatch(rec.systemPrompt!, /Agent team/);
	assert.equal(rec.commands.find((c) => c.type === "prompt")?.message, "do the thing");
	// it ends: idle, one idle notice for the lead, no end message of a background agent
	await until("the idle notice", () => x.messages().some((m) => /kind="idle"/.test(m)));
	await until("it is idle", () => teams.current()!.members.get("worker")!.status === "idle");
	const notices = x.messages().filter((m) => /kind="idle"/.test(m));
	assert.equal(notices.length, 1);
	assert.match(
		notices[0]!,
		/^<agent-message from="worker" team="session-0190team" kind="idle">\nworker is idle\. Its final answer:\nfinal/,
	);
	assert.ok(
		!x.messages().some((m) => /^Background agent/.test(m)),
		"the idle notice replaces the background end message",
	);
	assert.equal(x.t.messages.at(-1)!.options.triggerTurn, true);
	// its meta file keeps what a later continue needs
	const meta = JSON.parse(readFileSync(join(x.s.root, "subagents", x.sessionId, `${r.agentId}.json`), "utf8"));
	assert.equal(meta.teammate, true);
	assert.equal(meta.team, `session-${x.sessionId}`);
	assert.equal(meta.name, "worker");
	assert.equal(meta.teamPrompt, rec.systemPromptTail!.match(/# Agent team[\s\S]*?(?=\n\n# Environment)/)![0]);
	assert.equal(registry.get(r.agentId)!.status, "completed");
	await x.end();
});

test("refused with teams on: schema, run_in_background false, and a workflow; each throws saying why", async () => {
	const x = await setup();
	x.s.scenario({ lines: ok() });
	await assert.rejects(
		x.t.run({ name: "w", schema: { type: "object", properties: {} } }),
		/cannot return structured output/,
	);
	await assert.rejects(x.t.run({ name: "w", run_in_background: false }), /always runs in the background/);
	for (const id of ["workflow:demo:abc/1", "workflow:demo:abc"]) {
		await assert.rejects(
			x.t.tool.execute(id, { description: "d", prompt: "p", name: "w" }, undefined, undefined, x.t.ctx),
			/a workflow cannot start a teammate/,
		);
	}
	assert.equal(teams.current(), undefined, "nothing was started");
	assert.deepEqual(registry.list(x.sessionId), []);
	await x.end();
});

test("a call with isolation, a fork, or no name stays an ordinary subagent; so does a name another subagent has", async () => {
	const x = await setup();
	x.s.scenario({ lines: ok("plain") });
	await assert.rejects(
		x.t.run({ name: "w", isolation: "bogus" }),
		/invalid isolation "bogus"/,
		"isolation: the ordinary call's checks",
	);
	const unnamed = (await x.t.run({})).structuredContent;
	assert.equal(unnamed.status, "completed");
	registry.begin(
		{ cwd: x.s.repo, thinking: "off", trusted: true, sessionId: x.sessionId },
		{ id: "plain1", type: "general-purpose", name: "taken", description: "d", model: "m", thinking: "off" },
	);
	await assert.rejects(x.t.run({ name: "taken" }), /the name "taken" is already used by agent plain1/);
	await assert.rejects(x.t.run({ name: "f", subagent_type: "fork" }), /fork needs a saved session|ENOENT|fork/);
	assert.equal(teams.current(), undefined, "none of these made a team");
	await x.end();
});

test("a name that a teammate has is refused, and points to SendMessage", async () => {
	const x = await setup();
	x.s.scenario({ lines: ok(), hang: true, abortSettles: true });
	const r = (await x.t.run({ name: "w" })).structuredContent;
	await assert.rejects(x.t.run({ name: "w" }), /"w" is a teammate of this team: message it with SendMessage/);
	registry.stop(r.agentId);
	await x.end();
});

test("the cap counts members that are not stopped, idle ones too; stopping one frees its place", async () => {
	const x = await setup({ top: { agentTeams: { enabled: true, maxTeammates: 2 } } });
	x.s.scenario({ lines: ok(), hang: true, abortSettles: true });
	const a = (await x.t.run({ name: "a" })).structuredContent;
	const b = (await x.t.run({ name: "b" })).structuredContent;
	await assert.rejects(
		x.t.run({ name: "c" }),
		/already has 2 teammates that are not stopped \(a: \w+, b: \w+\); stop one or raise agentTeams\.maxTeammates \(now 2\)/,
	);
	// a ends by itself (idle) and still counts
	await until("a child", () => registry.handle(a.agentId) !== undefined);
	registry.stop(a.agentId);
	await until("a stopped", () => teams.current()!.members.get("a")!.status === "stopped");
	const c = (await x.t.run({ name: "c" })).structuredContent;
	assert.equal(c.status, "started");
	registry.stop(b.agentId);
	registry.stop(c.agentId);
	await x.end();
});

test("an idle teammate counts toward the cap", async () => {
	const x = await setup({ top: { agentTeams: { enabled: true, maxTeammates: 1 } } });
	x.s.scenario({ lines: ok("fast") });
	await x.t.run({ name: "a" });
	await until("idle", () => teams.current()?.members.get("a")?.status === "idle");
	await assert.rejects(x.t.run({ name: "b" }), /already has 1 teammates that are not stopped \(a: idle\)/);
	await x.end();
});

test("a teammate started from a script is not in the script's group: no group message, the script is not moved to the background", async () => {
	const x = await setup();
	x.s.scenario({ lines: ok("mate answer") });
	const stand = codemodeStandIn(x.t);
	const out = await stand.run("script-teams-1", async ({ agent }) => {
		const r = await agent({ name: "mate" });
		return `started ${r.status}`;
	});
	assert.ok(!out.details?.background, "the script stayed in the foreground and returned its own result");
	assert.equal(out.content[0].text, "started started");
	await until("the idle notice", () => x.messages().some((m) => /kind="idle"/.test(m)));
	assert.deepEqual(
		scripts.list(x.sessionId).filter((s) => s.members.length > 0),
		[],
		"the script has no group members",
	);
	assert.ok(!x.messages().some((m) => /^Background script|Agents:/.test(m)), "no group message");
	// control: an unnamed call in a script still moves it to the background
	x.s.scenario({ lines: ok("plain"), delayMs: 100 });
	const bg = await stand.run("script-teams-2", async ({ agent }) => {
		await agent({});
		return "x";
	});
	assert.ok(bg.details?.background, "an ordinary Agent call keeps its behaviour");
	await x.end();
});

test("a teammate's tools: the team's tool is added to an explicit --tools list and never excluded, whatever the agent file says", async () => {
	const cases: { name: string; fields: string; tools: string; exclude?: RegExp; mode: string }[] = [
		{ name: "tools list", fields: "tools: Read, Grep", tools: "codemode,read,grep,SendMessage", mode: "codemode" },
		{
			name: "tools list naming SendMessage",
			fields: "tools: Read, SendMessage",
			tools: "codemode,read,SendMessage",
			mode: "codemode",
		},
		{
			name: "disallowedTools naming it",
			fields: "disallowedTools: SendMessage, Bash",
			tools: "+codemode,+SendMessage",
			exclude: /^bash$/,
			mode: "codemode",
		},
		{ name: "codemode false", fields: "codemode: false\ntools: Read", tools: "read,SendMessage", mode: "direct" },
		{
			name: "codemode false, default tools",
			fields: "codemode: false",
			tools: "+SendMessage",
			exclude: /^codemode$/,
			mode: "direct",
		},
		{
			name: "permission mode plan",
			fields: "permissionMode: plan",
			tools: "codemode,read,grep,find,ls,SendMessage",
			exclude: /^write,edit,bash,powershell,mcp__\*$/,
			mode: "codemode",
		},
		{
			name: "plan without codemode",
			fields: "permissionMode: plan\ncodemode: false",
			tools: "read,grep,find,ls,SendMessage",
			exclude: /codemode/,
			mode: "direct",
		},
	];
	for (const c of cases) {
		const x = await setup();
		x.s.write(join(x.s.repo, ".pi/agents/x.md"), agentFile(`name: x\ndescription: d\n${c.fields}`));
		x.s.scenario({ lines: ok() });
		await x.t.run({ name: "m", subagent_type: "x" });
		const rec = await recorded(x);
		assert.equal(flag(rec.argv, "--tools"), c.tools, c.name);
		const exclude = flag(rec.argv, "--exclude-tools");
		if (c.exclude) assert.match(exclude ?? "", c.exclude, c.name);
		assert.ok(!(exclude ?? "").split(",").includes("SendMessage"), `${c.name}: never excluded`);
		assert.equal(rec.team?.XPI_TEAM_TOOLS, c.mode, c.name);
		await x.end();
	}
});

test("naming SendMessage in an agent file's tools gives no unknown-tool warning for a teammate (an ordinary agent still gets one)", async () => {
	const x = await setup();
	x.s.write(join(x.s.repo, ".pi/agents/x.md"), agentFile("name: x\ndescription: d\ntools: Read, SendMessage"));
	x.s.scenario({ lines: ok() });
	const mate = (await x.t.run({ name: "m", subagent_type: "x" })).structuredContent;
	assert.deepEqual(mate.warnings, []);
	const plain = (await x.t.run({ subagent_type: "x" })).structuredContent;
	assert.ok(plain.warnings.some((w: string) => /tool "SendMessage" has no pi equivalent/.test(w)));
	await x.end();
});

test("a teammate's cache prefix is the same for every member and differs from an ordinary agent's", async () => {
	const x = await setup();
	x.s.scenario({ lines: ok() });
	const { resolveChild } = await import("../../../src/extensions/subagent/resolve.ts");
	const { discoverAgents } = await import("../../../src/extensions/subagent/discovery.ts");
	const def = discoverAgents(x.s.repo).agents.get("general-purpose")!;
	const config = (await import("../../../src/extensions/subagent/config.ts")).readConfig({ piCommand: "x" });
	const parent = { cwd: x.s.repo, thinking: "off", trusted: true, sessionId: "p", model: "a/b" };
	const launch = (member: string) => ({ team: "session-p", dir: "/d", member, roster: ["lead", member] });
	const a = resolveChild(def, { description: "d", prompt: "p" }, config, parent, {
		mcpServers: [],
		team: launch("a"),
	});
	const b = resolveChild(def, { description: "d", prompt: "p" }, config, parent, {
		mcpServers: [],
		team: launch("b"),
	});
	const plain = resolveChild(def, { description: "d", prompt: "p" }, config, parent, { mcpServers: [] });
	assert.equal(a.prefixKey, b.prefixKey);
	assert.notEqual(a.prefixKey, plain.prefixKey);
	assert.match(a.prefixKey, /team tools: SendMessage codemode/);
	assert.notEqual(a.systemPrompt.tail, b.systemPrompt.tail);
	assert.equal(a.systemPrompt.head, plain.systemPrompt.head);
	await x.end();
});

test("former teammates: after a reload, the old name continues it as a member with its history and its frozen prompt", async () => {
	const x = await setup();
	x.s.scenario({ lines: ok("first") });
	const first = (await x.t.run({ name: "veteran", description: "old hand" })).structuredContent;
	await until("idle", () => teams.current()?.members.get("veteran")?.status === "idle");
	const frozen = (await recorded(x)).systemPromptTail!;
	await x.end();
	assert.ok(!existsSync(x.teamDir), "session end removed the team's files");
	// a fresh process: nothing in memory, the meta files remain
	registry.clear();
	const t2 = await x.load();
	assert.equal(teams.current(), undefined, "the team is not restored");
	assert.equal(registry.get(first.agentId)!.teammate, true);
	x.s.scenario({ lines: ok("second") });
	const again = (await t2.run({ name: "veteran", description: "old hand", prompt: "welcome back" })).structuredContent;
	assert.equal(again.status, "started");
	assert.equal(again.agentId, first.agentId, "the same agent, with its session");
	const idleNotices = (m: string[]) => m.filter((c) => /kind="idle"/.test(c)).length;
	await until("its end", () => idleNotices(t2.messages.map((m) => m.message.content as string)) === 1);
	const rec = await recorded(x);
	assert.equal(flag(rec.argv, "--session-id"), first.agentId);
	assert.equal(rec.commands.find((c) => c.type === "prompt")?.message, "welcome back");
	assert.equal(rec.team?.XPI_TEAM_MEMBER, "veteran");
	assert.equal(
		rec.systemPromptTail!.match(/# Agent team[\s\S]*?(?=\n\n# Environment)/)![0],
		frozen.match(/# Agent team[\s\S]*?(?=\n\n# Environment)/)![0],
		"the prompt section is the one frozen at the first start",
	);
	assert.ok(existsSync(join(x.teamDir, "config.json")), "a new team, made by the first member");
	// SendMessage with the old name does the same
	registry.clear();
	await t2.emit("session_shutdown", {});
	const t3 = await x.load();
	x.s.scenario({ lines: ok("third") });
	const viaSend = (
		await t3.tools.SendMessage.execute("s", { to: "veteran", message: "ping" }, undefined, undefined, t3.ctx)
	).structuredContent;
	assert.equal(viaSend.status, "started");
	assert.equal(viaSend.agentId, first.agentId);
	await t3.emit("session_shutdown", {});
});

test("session end stops running teammates and removes the team's files, with no notice to the lead", async () => {
	const x = await setup();
	x.s.scenario({ lines: ok(), hang: true, abortSettles: true });
	const r = (await x.t.run({ name: "w" })).structuredContent;
	await until("the child", () => registry.handle(r.agentId) !== undefined);
	assert.ok(existsSync(x.teamDir));
	await x.end();
	assert.ok(!existsSync(x.teamDir), "config.json and the mailboxes are gone");
	assert.equal(registry.get(r.agentId)!.status, "stopped");
	assert.ok(!x.messages().some((m) => /agent-message|was stopped/.test(m)), "main hears nothing about it");
	assert.deepEqual(
		existsSync(join(x.s.root, "agent", "teams")) ? readdirSync(join(x.s.root, "agent", "teams")) : [],
		[],
	);
});

test("a stale team directory of a dead lead is removed when the next team is created", async () => {
	const x = await setup();
	const { mkdirSync, writeFileSync } = await import("node:fs");
	const stale = join(x.s.root, "agent", "teams", "session-crashed");
	mkdirSync(join(stale, "inboxes"), { recursive: true });
	writeFileSync(join(stale, "config.json"), JSON.stringify({ leadPid: 2 ** 22 + 12345 }));
	x.s.scenario({ lines: ok() });
	await x.t.run({ name: "w" });
	assert.ok(!existsSync(stale));
	await x.end();
});

test.after(() => registry.clear());
