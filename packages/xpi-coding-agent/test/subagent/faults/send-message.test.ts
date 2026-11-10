// SendMessage (spec 03): a running agent is steered and the call returns at once; a finished one is continued like a
// resume; an unknown target throws with the session's agents; main's own steer is not noted back to main.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { registry } from "../../../src/extensions/subagent/registry.ts";
import { ev, flag, loadTool, sandbox } from "../helpers.ts";

const ok = (text = "done") => [ev.session(), ev.assistant(text), ev.turnEnd(), ev.settled()];
const until = async (what: string, pred: () => boolean, ms = 8000) => {
	const t0 = Date.now();
	while (!pred()) {
		if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 20));
	}
};

async function setup(sessionId: string) {
	const s = sandbox();
	const t = await loadTool({}, { cwd: s.repo, sessionFile: join(s.root, "parent.jsonl"), sessionId });
	const send = async (params: Record<string, unknown>) =>
		(await t.tools.SendMessage.execute("send-1", params, undefined, undefined, t.ctx)).structuredContent;
	return { s, t, send };
}

test("to a running agent: delivered as a steer, returns at once, and nothing is noted back to main", async () => {
	const { s, t, send } = await setup("send-1");
	// Slow enough to be running when the message comes, and it ends by itself.
	s.scenario({
		lines: [ev.session(), ev.tool("read"), ev.assistant("final"), ev.turnEnd(), ev.settled()],
		delayMs: 250,
	});
	const started = (await t.run({ name: "worker", run_in_background: true })).structuredContent;
	assert.equal(started.status, "running");
	await until("the child", () => registry.handle(started.agentId) !== undefined);
	const t0 = Date.now();
	const r = await send({ to: "worker", message: "also check the tests", summary: "more work" });
	assert.deepEqual(r, { status: "running", agentId: started.agentId, delivered: "steer" });
	assert.ok(Date.now() - t0 < 200, "it did not wait for the agent");
	await until("the agent's end", () => t.messages.length > 0);
	assert.deepEqual(
		s
			.record()
			.commands.filter((c) => c.type === "steer")
			.map((c) => c.message),
		["also check the tests"],
	);
	await new Promise((res) => setTimeout(res, 50));
	const texts = t.messages.map((m) => m.message.content as string);
	assert.equal(texts.length, 1, texts.join("\n---\n"));
	assert.match(texts[0]!, /^Background agent .* completed/);
	assert.ok(!texts.some((x) => /said to/.test(x)), "no note for main's own steer");
});

test("to a finished agent: continued from its session with the message, by name or by id", async () => {
	const { s, send, t } = await setup("send-2");
	s.scenario({ lines: ok("first") });
	const first = (await t.run({ name: "reviewer", description: "review" })).structuredContent;
	s.scenario({ lines: ok("second") });
	const byName = await send({ to: "reviewer", message: "one more thing" });
	assert.equal(byName.status, "completed");
	assert.equal(byName.agentId, first.agentId);
	assert.equal(byName.output, "second");
	const rec = s.record();
	assert.equal(rec.commands.find((c) => c.type === "prompt")?.message, "one more thing");
	assert.equal(flag(rec.argv, "--session-id"), first.agentId, "it continued the stored session");
	s.scenario({ lines: ok("third") });
	assert.equal((await send({ to: first.agentId, message: "and another" })).output, "third");
	assert.equal(registry.get(first.agentId)!.name, "reviewer");
	assert.equal(registry.get(first.agentId)!.description, "review");
});

test("to nobody: throws with the session's agents by name and id", async () => {
	const { s, send, t } = await setup("send-3");
	await assert.rejects(
		send({ to: "ghost", message: "hi" }),
		/no agent "ghost" in this session\. It has started none\./,
	);
	s.scenario({ lines: ok() });
	const a = (await t.run({ name: "alpha" })).structuredContent;
	const b = (await t.run({})).structuredContent;
	await assert.rejects(send({ to: "ghost", message: "hi" }), (e: Error) => {
		assert.match(e.message, /no agent "ghost" in this session\. Agents: /);
		assert.ok(e.message.includes(`alpha (${a.agentId})`) && e.message.includes(b.agentId), e.message);
		return true;
	});
});

test("the tool is offered next to Agent, to codemode scripts only", async () => {
	const { t } = await setup("send-4");
	assert.equal(t.tools.SendMessage.exposure, "codemode");
	assert.match(t.tools.SendMessage.description, /by name .* or agentId/);
	assert.match(t.tools.Agent.description, /SendMessage\(\{ to: name, message \}\)/);
});
