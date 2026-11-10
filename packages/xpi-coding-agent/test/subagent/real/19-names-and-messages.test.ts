// Names and SendMessage on real haiku: a named agent is continued by name with what it learned; a running one takes
// main's message as a steer and its result shows it.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { registry } from "../../../src/extensions/subagent/registry.ts";
import { loadTool, sandbox } from "./helpers.ts";

const waitUntil = async (what: string, ready: () => boolean, ms = 90_000) => {
	for (const end = Date.now() + ms; !ready(); ) {
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 50));
	}
};

test("a finished named agent is continued by name and still knows what it was told", async () => {
	const s = sandbox();
	const t = await loadTool({}, { cwd: s.repo, persist: join(s.root, "sessions") });
	const first = await t.result({
		name: "keeper",
		description: "keep a word",
		prompt: "The code word is MANGO-17. Remember it. Reply with exactly OK. Do not call any tool.",
	});
	assert.equal(first.status, "completed", first.error ?? "");
	assert.equal(registry.get(first.agentId)!.name, "keeper");
	const send = t.tools.SendMessage;
	const second = (
		await send.execute(
			"send-1",
			{ to: "keeper", message: "What is the code word? Reply with it alone. Do not call any tool." },
			undefined,
			undefined,
			t.ctx,
		)
	).structuredContent;
	assert.equal(second.status, "completed", second.error ?? "");
	assert.equal(second.agentId, first.agentId);
	assert.match(second.output, /MANGO-17/);
});

test("a running agent takes main's message as a steer; no note comes back to main", async () => {
	const s = sandbox();
	const t = await loadTool({}, { cwd: s.repo, persist: join(s.root, "sessions") });
	const started = await t.result({
		name: "worker",
		description: "slow job",
		run_in_background: true,
		prompt: "Run the bash command `sleep 6`. After it ends, reply with exactly the word DONE.",
	});
	assert.equal(started.status, "running");
	// Steer once the model is at work (its first turn has ended and the sleep runs).
	await waitUntil("the first turn", () => (registry.get(started.agentId)?.turns ?? 0) >= 1);
	const r = (
		await t.tools.SendMessage.execute(
			"send-2",
			{ to: "worker", message: "Change of plan: reply with exactly the word PINEAPPLE instead of DONE." },
			undefined,
			undefined,
			t.ctx,
		)
	).structuredContent;
	assert.deepEqual(r, { status: "running", agentId: started.agentId, delivered: "steer" });
	await waitUntil("the end message", () => t.messages.length > 0);
	const texts = t.messages.map((m) => m.message.content as string);
	assert.match(texts[0]!, /Background agent .* completed/);
	assert.match(texts[0]!, /PINEAPPLE/);
	assert.ok(!texts.some((x) => /said to/.test(x)), "no note for main's own steer");
});
