// Fork (spec 04): `subagent_type: "fork"` starts a child from a copy of main's session, with main's model, no system
// prompt of its own, and a result for every tool call main had not finished. Also `/subtask`, and what a fork refuses.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { FORK_RESULT } from "../../../src/extensions/subagent/fork.ts";
import { agentFile, ev, flag, loadTool, sandbox } from "../helpers.ts";

const ok = (text = "fork answer") => ({ lines: [ev.session(), ev.assistant(text), ev.turnEnd(), ev.settled()] });

// A main session file as pi writes it: a user message, an assistant message with two tool calls, and the result of the
// first one only (the second is the script that is calling Agent right now).
function mainSession(file: string, cwd: string) {
	const at = "2026-11-10T00:00:00.000Z";
	const entries = [
		{ type: "session", version: 3, id: "main-session", timestamp: at, cwd },
		{
			type: "message",
			id: "u1",
			parentId: null,
			timestamp: at,
			message: { role: "user", content: "The code word is KIWI-9.", timestamp: 1 },
		},
		{
			type: "message",
			id: "a1",
			parentId: "u1",
			timestamp: at,
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "Working on it." },
					{ type: "toolCall", id: "call-done", name: "read", arguments: { path: "x" } },
					{ type: "toolCall", id: "call-open", name: "codemode", arguments: { code: "await tools.Agent({})" } },
				],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-opus-5-5",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 2,
			},
		},
		{
			type: "message",
			id: "r1",
			parentId: "a1",
			timestamp: at,
			message: {
				role: "toolResult",
				toolCallId: "call-done",
				toolName: "read",
				content: [{ type: "text", text: "file" }],
				isError: false,
				timestamp: 3,
			},
		},
	];
	writeFileSync(file, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
}

async function setup(
	settings: Record<string, unknown> = {},
	sessionId = `fork-${Math.random().toString(36).slice(2, 8)}`,
) {
	const s = sandbox();
	const sessionFile = join(s.root, "main.jsonl");
	mainSession(sessionFile, s.repo);
	s.scenario(ok());
	const t = await loadTool(settings, { cwd: s.repo, sessionFile, sessionId });
	const dir = join(s.root, "subagents", sessionId);
	const sessionOf = (agentId: string) => {
		const file = readdirSync(dir).find((f) => f.endsWith(`_${agentId}.jsonl`))!;
		return readFileSync(join(dir, file), "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l));
	};
	return { s, t, sessionFile, sessionOf, dir };
}

test("a fork starts from a copy of main's session, with a result for the call main has not finished", async () => {
	const { s, t, sessionFile, sessionOf } = await setup();
	const r = (await t.run({ subagent_type: "fork", prompt: "What is the code word?" })).structuredContent;
	assert.equal(r.status, "completed");
	assert.equal(r.agentType, "fork");
	assert.equal(r.output, "fork answer");
	const entries = sessionOf(r.agentId);
	assert.equal(entries[0].id, r.agentId, "the copy is the fork's own session");
	assert.equal(entries[0].parentSession, sessionFile);
	assert.deepEqual(
		entries.slice(1, 4).map((e) => e.id),
		["u1", "a1", "r1"],
		"main's conversation, unchanged",
	);
	const injected = entries.slice(4);
	assert.equal(injected.length, 1, "only the unanswered call gets a result");
	assert.equal(injected[0].message.role, "toolResult");
	assert.equal(injected[0].message.toolCallId, "call-open");
	assert.equal(injected[0].message.toolName, "codemode");
	assert.equal(injected[0].message.content[0].text, FORK_RESULT);
	assert.equal(injected[0].parentId, "r1");
	assert.equal(readFileSync(sessionFile, "utf8").trim().split("\n").length, 4, "main's file is not touched");

	const rec = s.record();
	assert.equal(flag(rec.argv, "--session-id"), r.agentId);
	assert.equal(flag(rec.argv, "--model"), "anthropic/claude-opus-5-5", "main's model");
	assert.equal(flag(rec.argv, "--thinking"), "medium", "main's thinking level");
	assert.equal(flag(rec.argv, "--tools"), "+codemode");
	assert.equal(rec.argv.includes("--system-prompt"), false, "no system prompt of its own: the session holds main's");
	assert.equal(rec.argv.includes("--system-prompt-tail"), false);
	assert.equal(rec.depth, "1", "a normal child: it gets no Agent tool, so it cannot start a subagent");
	assert.equal(rec.commands.find((c) => c.type === "prompt")?.message, "What is the code word?");
});

test("a fork is continued like any agent (resume, SendMessage, by name) and is not copied again", async () => {
	const { s, t, sessionOf, dir } = await setup();
	const first = (await t.run({ subagent_type: "fork", name: "side", prompt: "one" })).structuredContent;
	const before = sessionOf(first.agentId).length;
	s.scenario(ok("second"));
	const again = (await t.run({ resume: "side", prompt: "two" })).structuredContent;
	assert.equal(again.agentId, first.agentId);
	assert.equal(again.output, "second");
	assert.equal(flag(s.record().argv, "--session-id"), first.agentId);
	assert.equal(s.record().argv.includes("--system-prompt"), false);
	const sent = (
		await t.tools.SendMessage.execute("send", { to: "side", message: "three" }, undefined, undefined, t.ctx)
	).structuredContent;
	assert.equal(sent.status, "completed");
	assert.equal(sessionOf(first.agentId).length, before, "no second copy, no second injected result");
	assert.equal(readdirSync(dir).filter((f) => f.endsWith(".jsonl")).length, 1);
});

test("what a fork refuses: model, effort, schema; an in-memory session; subagent.fork: false", async () => {
	const { t } = await setup();
	for (const [extra, field] of [
		[{ model: "haiku" }, "model"],
		[{ effort: "low" }, "effort"],
		[{ schema: { type: "object" } }, "schema"],
	] as const) {
		await assert.rejects(
			t.run({ subagent_type: "fork", ...extra }),
			new RegExp(`"${field}" is not accepted on a fork: it runs as a copy of this conversation`),
		);
	}
	const off = await setup({ fork: false });
	await assert.rejects(off.t.run({ subagent_type: "fork" }), /"fork" is turned off \(subagent\.fork is false\)/);
	assert.doesNotMatch(off.t.tool.description, /- fork:/);
	const s = sandbox();
	s.scenario(ok());
	const memory = await loadTool({}, { cwd: s.repo });
	await assert.rejects(
		memory.run({ subagent_type: "fork" }),
		/a fork needs a saved session to copy: this session is in memory/,
	);
	assert.doesNotMatch(memory.tool.description, /- fork:/, "not offered where it cannot run");
	await assert.rejects(loadTool({ fork: "yes" }, { cwd: s.repo }), /subagent\.fork must be true or false/);
});

test("fork is a reserved type: listed for the model, and an agent file cannot take the name", async () => {
	const s = sandbox();
	const sessionFile = join(s.root, "main.jsonl");
	mainSession(sessionFile, s.repo);
	s.write(join(s.repo, ".pi/agents/fork.md"), agentFile("name: fork\ndescription: my own fork", "Mine."));
	s.scenario(ok());
	const t = await loadTool({}, { cwd: s.repo, sessionFile, sessionId: "fork-reserved" });
	assert.match(t.tool.description, /- fork: A copy of you, with this whole conversation and your model/);
	assert.doesNotMatch(t.tool.description, /my own fork/);
	assert.ok(
		t.notes.some((n) => /skipped agent file .*fork\.md: "fork" is a reserved agent type/.test(n)),
		t.notes.join("\n"),
	);
	await t.run({ subagent_type: "fork" });
	assert.equal(s.record().argv.includes("--system-prompt"), false, "the reserved type ran, not the file");
	await assert.rejects(t.run({ subagent_type: "nope" }), /Available: .*general-purpose.*, fork$/m);
});

test("/subtask starts a fork in the background with no model turn; its result arrives as a message", async () => {
	const { s, t } = await setup();
	await t.commands.subtask.handler("  summarise what we decided so far  ", t.ctx);
	assert.ok(
		t.notes.some((n) => /^subagent: fork \S+ started; its result arrives as a message$/.test(n)),
		t.notes.join("\n"),
	);
	for (let i = 0; i < 300 && t.messages.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
	assert.match(t.messages[0]!.message.content as string, /^Background agent \S+ fork completed[\s\S]*fork answer/);
	assert.equal(s.record().commands.find((c) => c.type === "prompt")?.message, "summarise what we decided so far");
	await t.commands.subtask.handler("   ", t.ctx);
	assert.ok(t.notes.some((n) => /\/subtask needs a task/.test(n)));
});
