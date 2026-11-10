// Spec 06 on real haiku: a running agent is restarted; it starts over with the same task and the call that waits for
// it gets the second start's result, with the first start's session kept aside.
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { registry } from "../../../src/extensions/subagent/registry.ts";
import { loadTool, sandbox } from "./helpers.ts";

test("restart: the agent starts over and its call gets the result of the second start", async () => {
	const s = sandbox();
	const t = await loadTool({}, { cwd: s.repo, persist: join(s.root, "sessions") });
	const call = t.result({
		description: "slow job",
		prompt: "Run the bash command `sleep 15; echo finished`. After it ends, reply with exactly the word DONE.",
	});
	// Wait until the model is at work (a turn has ended and the sleep runs), then restart it.
	let id: string | undefined;
	for (const end = Date.now() + 90_000; ; ) {
		id = registry.list(t.sessionId).find((r) => r.turns >= 1 && registry.handle(r.id) !== undefined)?.id;
		if (id) break;
		if (Date.now() > end) throw new Error("timed out waiting for the agent's first turn");
		await new Promise((r) => setTimeout(r, 50));
	}
	assert.equal(registry.restart(id), undefined);
	const r = await call;
	assert.equal(r.status, "completed", r.error ?? "");
	assert.equal(r.agentId, id);
	assert.match(r.output, /DONE/);
	assert.ok(r.turns >= 3, `turns of both starts are counted, got ${r.turns}`);
	const files = readdirSync(t.sessionDir!);
	assert.ok(files.includes(`${id}.restart-1.jsonl.bak`), files.join(", "));
	assert.equal(
		files.filter((f) => f.endsWith(`_${id}.jsonl`)).length,
		1,
		`and one live session: ${readdirSync(t.sessionDir!).join(", ")}`,
	);
});
