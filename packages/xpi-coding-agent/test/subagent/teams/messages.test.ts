// Agent teams: SendMessage between members. The teammate's tool (registered in a child process), the lead's, delivery
// end to end through the mailboxes with a fake child, and the shutdown flow.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import subagent from "../../../src/extensions/subagent/index.ts";
import { registry } from "../../../src/extensions/subagent/registry.ts";
import { teams } from "../../../src/extensions/subagent/team.ts";
import { type InboxEntry, inboxFile, peekEntries } from "../../../src/extensions/subagent/team-files.ts";
import { registerTeamTools } from "../../../src/extensions/subagent/team-send.ts";
import { ev, loadTool, sandbox } from "../helpers.ts";
import { cleanupLater, cleanupNow } from "./team-helpers.ts";

const ok = (text = "done") => [ev.session(), ev.assistant(text), ev.turnEnd(), ev.settled()];
const until = async (what: string, pred: () => boolean, ms = 30_000) => {
	const t0 = Date.now();
	while (!pred()) {
		if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 20));
	}
};

// --- the teammate's tool, with a config.json the lead wrote

type Member = { name: string; status: string; shutdownRequested?: number };
function childTool(me: string, members: Member[], tools = "codemode") {
	const dir = mkdtempSync(join(tmpdir(), "team-child-"));
	writeFileSync(
		join(dir, "config.json"),
		JSON.stringify({ team: "session-abcdef123456", members: [{ name: "lead", status: "running" }, ...members] }),
	);
	const registered: Record<string, any> = {};
	registerTeamTools({ registerTool: (t: any) => (registered[t.name] = t) } as any, {
		XPI_TEAM_DIR: dir,
		XPI_TEAM_MEMBER: me,
		XPI_TEAM_TOOLS: tools,
	});
	let aborted = 0;
	const ctx = { abort: () => aborted++ };
	return {
		dir,
		tool: registered.SendMessage,
		call: (params: Record<string, unknown>) => registered.SendMessage.execute("c", params, undefined, undefined, ctx),
		get aborted() {
			return aborted;
		},
		inbox: (name: string): InboxEntry[] => peekEntries(inboxFile(dir, name)),
	};
}

test(
	"a teammate's SendMessage writes the recipient's mailbox and returns once it is written",
	{ timeout: 60_000 },
	async () => {
		const c = childTool("a", [
			{ name: "a", status: "running" },
			{ name: "b", status: "idle" },
		]);
		const r = await c.call({ to: "b", message: "hello b", summary: "greeting" });
		assert.equal(r.structuredContent.status, "sent");
		assert.equal(r.structuredContent.to, "b");
		const [entry] = c.inbox("b");
		assert.equal(entry!.id, r.structuredContent.id);
		assert.deepEqual(
			[entry!.from, entry!.to, entry!.text, entry!.summary, entry!.kind],
			["a", "b", "hello b", "greeting", "message"],
		);
		await c.call({ to: "lead", message: "done" });
		assert.equal(c.inbox("lead")[0]!.from, "a");
	},
);

test(
	"the teammate's tool is a codemode tool when the child has codemode and a direct tool otherwise",
	{ timeout: 60_000 },
	() => {
		assert.equal(childTool("a", [], "codemode").tool.exposure, "codemode");
		assert.equal(childTool("a", [], "direct").tool.exposure, "direct");
	},
);

test(
	"an unknown recipient throws with the roster; a stopped one throws stopped; so does a message to yourself or without text",
	{ timeout: 60_000 },
	async () => {
		const c = childTool("a", [
			{ name: "a", status: "running" },
			{ name: "b", status: "stopped" },
			{ name: "c", status: "idle" },
		]);
		await assert.rejects(
			c.call({ to: "ghost", message: "x" }),
			/no member "ghost" in team session-abcdef12\. Members: lead \(running\), a \(running\), b \(stopped\), c \(idle\)/,
		);
		await assert.rejects(c.call({ to: "b", message: "x" }), /stopped: b has stopped/);
		await assert.rejects(c.call({ to: "a", message: "x" }), /to yourself/);
		await assert.rejects(c.call({ to: "c" }), /`message` is required/);
		assert.deepEqual(c.inbox("b"), []);
	},
);

test("a write that cannot be done throws, so a send never counts without its entry", { timeout: 60_000 }, async () => {
	const c = childTool("a", [
		{ name: "a", status: "running" },
		{ name: "b", status: "idle" },
	]);
	// the mailbox directory is a file: nothing can be written there
	writeFileSync(join(c.dir, "inboxes"), "in the way");
	await assert.rejects(c.call({ to: "b", message: "x" }));
});

test("a team that has ended: the config.json is gone", { timeout: 60_000 }, async () => {
	const c = childTool("a", []);
	const { rmSync } = await import("node:fs");
	rmSync(join(c.dir, "config.json"));
	await assert.rejects(c.call({ to: "lead", message: "x" }), /the team has ended/);
});

test(
	"shutdown: only the lead requests; a response needs a pending request, goes to the lead, and an approval aborts the run",
	{ timeout: 60_000 },
	async () => {
		const c = childTool("a", [
			{ name: "a", status: "running" },
			{ name: "b", status: "running" },
		]);
		await assert.rejects(c.call({ to: "b", kind: "shutdown_request" }), /only the lead can send a shutdown_request/);
		await assert.rejects(
			c.call({ to: "lead", kind: "shutdown_response", approve: true }),
			/no shutdown request is pending/,
		);
		assert.equal(c.aborted, 0);
		const pending = childTool("a", [{ name: "a", status: "running", shutdownRequested: Date.now() }]);
		await assert.rejects(pending.call({ to: "lead", kind: "shutdown_response" }), /needs `approve`/);
		await assert.rejects(pending.call({ to: "a", kind: "shutdown_response", approve: true }), /to yourself/);
		// a refusal keeps it working
		await pending.call({ to: "lead", kind: "shutdown_response", approve: false, message: "busy with X" });
		assert.equal(pending.aborted, 0);
		assert.deepEqual(
			pending.inbox("lead").map((e) => [e.kind, e.approve, e.text]),
			[["shutdown_response", false, "busy with X"]],
		);
		// an approval: written first, then the run is aborted
		const r = await pending.call({ to: "lead", kind: "shutdown_response", approve: true });
		assert.equal(pending.aborted, 1);
		assert.equal(r.structuredContent.status, "sent");
		assert.equal(pending.inbox("lead").at(-1)!.approve, true);
	},
);

test(
	"in a child process the extension registers SendMessage and the four task tools for a teammate and still no Agent",
	{ timeout: 60_000 },
	() => {
		const dir = mkdtempSync(join(tmpdir(), "team-child-"));
		writeFileSync(join(dir, "config.json"), JSON.stringify({ team: "t", members: [] }));
		const keys = ["XPI_SUBAGENT_DEPTH", "XPI_TEAM_DIR", "XPI_TEAM_MEMBER", "XPI_TEAM_TOOLS"];
		const saved = keys.map((k) => process.env[k]);
		Object.assign(process.env, {
			XPI_SUBAGENT_DEPTH: "1",
			XPI_TEAM_DIR: dir,
			XPI_TEAM_MEMBER: "a",
			XPI_TEAM_TOOLS: "direct",
		});
		try {
			const tools: Record<string, any> = {};
			subagent({ registerTool: (t: any) => (tools[t.name] = t), registerFlag: () => {}, on: () => {} } as any);
			assert.deepEqual(Object.keys(tools).sort(), [
				"SendMessage",
				"TaskCreate",
				"TaskGet",
				"TaskList",
				"TaskUpdate",
			]);
			for (const t of Object.values(tools)) assert.equal(t.exposure, "direct");
			delete process.env.XPI_TEAM_DIR;
			const none: Record<string, any> = {};
			subagent({ registerTool: (t: any) => (none[t.name] = t), registerFlag: () => {}, on: () => {} } as any);
			assert.deepEqual(Object.keys(none), [], "an ordinary subagent has neither");
		} finally {
			for (const [i, k] of keys.entries()) {
				if (saved[i] === undefined) delete process.env[k];
				else process.env[k] = saved[i];
			}
		}
	},
);

// --- the lead's tool and delivery end to end

let n = 0;
async function lead(settings: Record<string, unknown> = { enabled: true }) {
	const s = sandbox();
	const sessionId = `0190msg-${++n}-${Math.random().toString(16).slice(2, 8)}`;
	process.env.XPI_CODING_AGENT_DIR = join(s.root, "agent");
	const t = await loadTool(
		{},
		{ cwd: s.repo, sessionFile: join(s.root, "parent.jsonl"), sessionId, topSettings: { agentTeams: settings } },
	);
	const send = async (params: Record<string, unknown>) =>
		(await t.tools.SendMessage.execute("send-1", params, undefined, undefined, t.ctx)).structuredContent;
	// what a running teammate was told: its child answers each steer with the user message it read (takeSteers)
	const told = (id: string) => {
		const texts: string[] = [];
		registry.watch(id, (e) => {
			const m = e.message as { role?: string; content?: string } | undefined;
			if (e.type === "message_end" && m?.role === "user") texts.push(m.content!);
		});
		return texts;
	};
	const end = () => t.emit("session_shutdown", {});
	cleanupLater(end);
	return {
		s,
		t,
		sessionId,
		send,
		told,
		end,
		messages: () => t.messages.map((m) => m.message.content as string),
	};
}

test(
	"the lead's SendMessage to a running teammate: written to its mailbox, delivered as a steer, taken",
	{ timeout: 60_000 },
	async () => {
		const x = await lead();
		x.s.scenario({ lines: [ev.session()], hang: true, abortSettles: true, takeSteers: true });
		const a = (await x.t.run({ name: "a" })).structuredContent;
		await until("the child", () => registry.handle(a.agentId) !== undefined);
		const heard = x.told(a.agentId);
		const r = await x.send({ to: "a", message: "check the tests", summary: "tests" });
		assert.equal(r.status, "sent");
		assert.equal(r.to, "a");
		assert.match(r.id, /^[0-9a-f]{16}$/);
		await until("the steer", () => heard.length === 1);
		assert.match(
			heard[0]!,
			/^<agent-message from="lead" team="session-0190msg-" kind="message" id="[0-9a-f]{16}">\ncheck the tests\n<\/agent-message>/,
		);
		assert.deepEqual(peekEntries(inboxFile(teams.current()!.dir, "a")), []);
		registry.stop(a.agentId);
		await x.end();
	},
);

test(
	"a message between two teammates goes through the mailboxes and the lead's deliverer to the running one",
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
		const heard = x.told(b.agentId);
		// a's own tool, as its child process would run it: it reads the roster from config.json
		await until("config.json lists both", () => {
			const members = JSON.parse(readFileSync(teams.current()!.configPath, "utf8")).members as Member[];
			return members.some((m) => m.name === "b" && m.status === "running");
		});
		const mine = (() => {
			const registered: Record<string, any> = {};
			registerTeamTools({ registerTool: (t: any) => (registered[t.name] = t) } as any, {
				XPI_TEAM_DIR: teams.current()!.dir,
				XPI_TEAM_MEMBER: "a",
				XPI_TEAM_TOOLS: "codemode",
			});
			return registered.SendMessage;
		})();
		await mine.execute("c", { to: "b", message: "which file is it?" }, undefined, undefined, { abort() {} });
		await until("the delivery", () => heard.length === 1, 4000);
		assert.match(heard[0]!, /from="a" team="[^"]+" kind="message" id="[0-9a-f]+">\nwhich file is it\?/);
		registry.stop(a.agentId);
		registry.stop(b.agentId);
		await x.end();
	},
);

test(
	"the lead's SendMessage: a message to the lead, a stopped teammate, a non-member with a kind, and no message all throw",
	{ timeout: 60_000 },
	async () => {
		const x = await lead();
		x.s.scenario({ lines: [ev.session()], hang: true, abortSettles: true });
		const a = (await x.t.run({ name: "a" })).structuredContent;
		await until("the child", () => registry.handle(a.agentId) !== undefined);
		await assert.rejects(x.send({ to: "lead", message: "hi" }), /you are the lead/);
		await assert.rejects(x.send({ to: "a" }), /`message` is required/);
		await assert.rejects(x.send({ to: "a", kind: "shutdown_response", approve: true }), /only a teammate answers/);
		await assert.rejects(x.send({ to: "ghost", message: "x" }), /no agent "ghost" in this session\. Agents: a \(/);
		await assert.rejects(
			x.send({ to: "ghost", kind: "shutdown_request" }),
			/"shutdown_request" is for team members: "ghost" is not one|no agent "ghost"/,
		);
		registry.stop(a.agentId);
		await until("stopped", () => teams.current()!.members.get("a")!.status === "stopped");
		await assert.rejects(x.send({ to: "a", message: "x" }), /stopped: a has stopped/);
		await x.end();
	},
);

test("with teams off, SendMessage still needs a message and treats a name as before", { timeout: 60_000 }, async () => {
	const x = await lead({ enabled: false });
	await assert.rejects(x.send({ to: "ghost" }), /`message` is required/);
	await assert.rejects(x.send({ to: "ghost", message: "x" }), /no agent "ghost" in this session/);
	await x.end();
});

test(
	"shutdown, end to end: the request is delivered, the teammate approves, and the run's abort is not a failure",
	{ timeout: 60_000 },
	async () => {
		const x = await lead();
		x.s.scenario({ lines: [ev.session()], hang: true, abortSettles: true, takeSteers: true });
		const a = (await x.t.run({ name: "a" })).structuredContent;
		await until("the child", () => registry.handle(a.agentId) !== undefined);
		const heard = x.told(a.agentId);
		await x.send({ to: "a", kind: "shutdown_request", message: "we are done" });
		await until("the request", () => heard.length === 1);
		assert.match(heard[0]!, /kind="shutdown_request" id="[0-9a-f]+">\nwe are done/);
		assert.ok(teams.current()!.members.get("a")!.shutdownRequested !== undefined);
		// its child answers (its tool, as the child process runs it), then its run is aborted
		const registered: Record<string, any> = {};
		registerTeamTools({ registerTool: (t: any) => (registered[t.name] = t) } as any, {
			XPI_TEAM_DIR: teams.current()!.dir,
			XPI_TEAM_MEMBER: "a",
			XPI_TEAM_TOOLS: "codemode",
		});
		await registered.SendMessage.execute(
			"c",
			{ to: "lead", kind: "shutdown_response", approve: true },
			undefined,
			undefined,
			{ abort() {} },
		);
		registry.handle(a.agentId)!.send({ type: "abort" }); // what ctx.abort() does in the child
		await until("stopped", () => teams.current()!.members.get("a")!.status === "stopped");
		assert.equal(registry.get(a.agentId)!.status, "stopped");
		await until("the response reaches the lead", () => x.messages().some((m) => /kind="shutdown_response"/.test(m)));
		assert.ok(!x.messages().some((m) => /kind="idle"/.test(m)), "no idle notice for an approved shutdown");
		await assert.rejects(x.send({ to: "a", message: "x" }), /stopped/);
		await x.end();
	},
);

test("a failed exchange leaves the teammate idle and the lead gets the error", { timeout: 60_000 }, async () => {
	const x = await lead();
	x.s.scenario({
		lines: [
			ev.session(),
			ev.assistant("", undefined, { stopReason: "error", errorMessage: "provider down" }),
			ev.turnEnd({ stopReason: "error" }),
			ev.settled(),
		],
	});
	await x.t.run({ name: "a" });
	await until("idle", () => teams.current()?.members.get("a")?.status === "idle");
	await until("the notice", () => x.messages().some((m) => /kind="idle"/.test(m)));
	assert.match(x.messages().find((m) => /kind="idle"/.test(m))!, /Its exchange failed: provider down/);
	await x.end();
});

test(
	"a message to an idle teammate wakes it: a new exchange continues its session with the message as the prompt",
	{ timeout: 60_000 },
	async () => {
		const x = await lead();
		x.s.scenario({ lines: ok("first answer") });
		const a = (await x.t.run({ name: "a" })).structuredContent;
		await until("idle", () => teams.current()?.members.get("a")?.status === "idle");
		x.s.scenario({ lines: ok("second answer") });
		await x.send({ to: "a", message: "one more thing" });
		await until("the second notice", () => x.messages().filter((m) => /kind="idle"/.test(m)).length === 2, 6000);
		await until("the second prompt", () => {
			try {
				return x.s.record().commands.some((c) => c.type === "prompt" && /one more thing/.test(c.message ?? ""));
			} catch {
				return false; // the file is being written
			}
		});
		const rec = x.s.record();
		assert.match(
			rec.commands.find((c) => c.type === "prompt")!.message!,
			/^<agent-message from="lead"[\s\S]*one more thing/,
		);
		assert.equal(rec.argv[rec.argv.indexOf("--session-id") + 1], a.agentId, "the same session");
		assert.match(x.messages().filter((m) => /kind="idle"/.test(m))[1]!, /second answer/);
		await x.end();
	},
);

test("a sender that is not a member of the team cannot send", { timeout: 60_000 }, async () => {
	const c = childTool("ghost", [{ name: "a", status: "running" }]);
	await assert.rejects(c.call({ to: "a", message: "x" }), /ghost is not a member of team session-abcdef12/);
	assert.deepEqual(c.inbox("a"), []);
});

test(
	"shutting down an idle teammate: the request wakes it, it approves, it stops, and there is no idle notice for that exchange",
	{ timeout: 60_000 },
	async () => {
		const x = await lead();
		x.s.scenario({ lines: ok("first") });
		const a = (await x.t.run({ name: "a" })).structuredContent;
		await until("idle", () => teams.current()?.members.get("a")?.status === "idle");
		await until("its notice", () => x.messages().some((m) => /kind="idle"/.test(m)));
		x.s.scenario({ lines: [ev.session()], hang: true, abortSettles: true, takeSteers: true });
		await x.send({ to: "a", kind: "shutdown_request", message: "wrap up" });
		await until(
			"woken and running",
			() => teams.current()!.members.get("a")!.status === "running" && registry.handle(a.agentId) !== undefined,
		);
		const member = () =>
			JSON.parse(readFileSync(teams.current()!.configPath, "utf8")).members.find((m: Member) => m.name === "a");
		await until("config.json says so", () => member().shutdownRequested !== undefined);
		const registered: Record<string, any> = {};
		registerTeamTools({ registerTool: (t: any) => (registered[t.name] = t) } as any, {
			XPI_TEAM_DIR: teams.current()!.dir,
			XPI_TEAM_MEMBER: "a",
			XPI_TEAM_TOOLS: "codemode",
		});
		await registered.SendMessage.execute(
			"c",
			{ to: "lead", kind: "shutdown_response", approve: true },
			undefined,
			undefined,
			{ abort() {} },
		);
		registry.handle(a.agentId)!.send({ type: "abort" });
		await until("stopped", () => teams.current()!.members.get("a")!.status === "stopped");
		await until("the response", () => x.messages().some((m) => /kind="shutdown_response"/.test(m)));
		assert.equal(x.messages().filter((m) => /kind="idle"/.test(m)).length, 1, "only the first exchange's notice");
		await x.end();
	},
);

test("a shutdown request that is refused leaves no mark", { timeout: 60_000 }, async () => {
	const x = await lead();
	x.s.scenario({ lines: [ev.session()], hang: true, abortSettles: true });
	const a = (await x.t.run({ name: "a" })).structuredContent;
	await until("the child", () => registry.handle(a.agentId) !== undefined);
	teams.current()!.members.get("a")!.status = "stopping"; // sendToMember refuses a request to a member already shutting down
	await assert.rejects(x.send({ to: "a", kind: "shutdown_request" }), /already shutting down/);
	assert.equal(teams.current()!.members.get("a")!.shutdownRequested, undefined);
	teams.current()!.members.get("a")!.status = "running";
	registry.stop(a.agentId);
	await x.end();
});

test("SendMessage reaches a live teammate by its agentId as well as by its name", { timeout: 60_000 }, async () => {
	const x = await lead();
	x.s.scenario({ lines: [ev.session()], hang: true, abortSettles: true, takeSteers: true });
	const a = (await x.t.run({ name: "a" })).structuredContent;
	await until("the child", () => registry.handle(a.agentId) !== undefined);
	const heard = x.told(a.agentId);
	const r = await x.send({ to: a.agentId, message: "by id" });
	assert.equal(r.status, "sent");
	assert.equal(r.to, "a");
	await until("the steer", () => heard.length === 1);
	assert.match(heard[0]!, /by id/);
	registry.stop(a.agentId);
	await x.end();
});

test.afterEach(cleanupNow);
test.after(() => registry.clear());
