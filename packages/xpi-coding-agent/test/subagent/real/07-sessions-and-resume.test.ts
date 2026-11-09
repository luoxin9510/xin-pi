// Ticket 07: child sessions and resume, on real pi.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { childSetup, loadTool, sandbox, sessionEntries } from "./helpers.ts";

test("first run stores the session under subagents/<parent id>/, records the agent type, and resume continues it", async () => {
	const s = sandbox();
	const sessions = join(s.root, "sessions");
	const t = await loadTool({}, { cwd: s.repo, persist: sessions });

	const first = await t.result({
		subagent_type: "Explore",
		prompt: "Remember this codeword: PINEAPPLE-42. Reply with the single word OK. Do not call any tool.",
	});
	assert.equal(first.status, "completed", first.error ?? "");
	assert.deepEqual(
		readdirSync(t.sessionDir!).sort(),
		[`${first.agentId}.json`, readdirSync(t.sessionDir!).find((f) => f.endsWith(".jsonl"))!].sort(),
	);
	assert.equal(JSON.parse(readFileSync(join(t.sessionDir!, `${first.agentId}.json`), "utf8")).agentType, "Explore");
	assert.equal(
		sessionEntries(t.sessionDir!, first.agentId)[0]!.id,
		first.agentId,
		"pi named the session with the agent id",
	);

	const second = await t.result({
		resume: first.agentId,
		prompt: "What codeword did I tell you? Reply with only the codeword. Do not call any tool.",
	});
	assert.equal(second.status, "completed", second.error ?? "");
	assert.equal(second.agentId, first.agentId);
	assert.equal(second.agentType, "Explore", "no subagent_type: the stored type");
	assert.match(second.output, /PINEAPPLE-42/, "the resumed child remembers the first run");
	const users = sessionEntries(t.sessionDir!, first.agentId).filter(
		(e) => e.type === "message" && e.message.role === "user",
	);
	assert.equal(users.length, 2, "both prompts are in the one session");
	assert.match(childSetup(t.sessionDir!, first.agentId).prompt, /file search specialist/, "the Explore definition");

	const same = await t.result({
		resume: first.agentId,
		subagent_type: "Explore",
		prompt: "Reply with the single word OK. Do not call any tool.",
	});
	assert.equal(same.agentType, "Explore", "naming the same type is fine");
	assert.equal(same.status, "completed", same.error ?? "");
});

test("resume errors: different type, unknown id, invalid id", async () => {
	const s = sandbox();
	const t = await loadTool({}, { cwd: s.repo, persist: join(s.root, "sessions") });
	const first = await t.result({
		subagent_type: "Explore",
		prompt: "Reply with the single word OK. Do not call any tool.",
	});
	await assert.rejects(t.run({ resume: first.agentId, subagent_type: "Plan" }), /is a "Explore" agent/);
	await assert.rejects(t.run({ resume: "unknownid123" }), /no subagent session "unknownid123" to resume/);
	await assert.rejects(t.run({ resume: "../evil" }), /invalid resume id/);
});

test("in-memory parent: children are in memory and cannot be resumed", async () => {
	const s = sandbox();
	const t = await loadTool({}, { cwd: s.repo });
	const r = await t.result({ prompt: "Reply with the single word OK. Do not call any tool." });
	assert.equal(r.status, "completed", r.error ?? "");
	assert.equal(existsSync(join(s.agentDir, "sessions")), false, "the child wrote no session file");
	await assert.rejects(t.run({ resume: r.agentId }), /resume needs a persisted parent session/);
});
