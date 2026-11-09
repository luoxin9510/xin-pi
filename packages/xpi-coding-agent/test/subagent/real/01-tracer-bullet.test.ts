// Ticket 01: run the built-in general-purpose agent end to end on real pi.
import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadTool, sandbox, sessionEntries, toolCalls } from "./helpers.ts";

test("the Agent tool is codemode-only and declares an output schema", async () => {
	const s = sandbox();
	const t = await loadTool({}, { cwd: s.repo });
	assert.equal(t.tool.name, "Agent");
	assert.equal(t.tool.exposure, "codemode");
	assert.equal(t.tool.outputSchema.type, "object");
	assert.ok(t.tool.outputSchema.properties.agentId);
});

test("a default call runs general-purpose, reads a file and returns a completed AgentResult", async () => {
	const s = sandbox();
	s.write(join(s.repo, "secret.txt"), "TOKEN-7431\n");
	const t = await loadTool({}, { cwd: s.repo, persist: join(s.root, "sessions") });
	const res = await t.run({
		prompt: "Read the file secret.txt with the read tool. Reply with only the token it contains.",
	});
	const r = res.structuredContent;

	assert.deepEqual(Object.keys(r).sort(), [
		"agentId",
		"agentType",
		"durationMs",
		"model",
		"output",
		"status",
		"turns",
		"usage",
		"warnings",
	]);
	assert.equal(r.status, "completed");
	assert.equal(r.agentType, "general-purpose");
	assert.match(r.agentId, /^[a-z0-9]{12}$/);
	assert.match(r.output, /TOKEN-7431/);
	assert.equal(r.model, "anthropic/claude-haiku-5-5");
	assert.ok(r.turns >= 2, "one turn to call read, one to answer");
	assert.ok(r.usage.cost.total > 0 && r.usage.output > 0);
	assert.deepEqual(r.warnings, []);
	assert.deepEqual(res.usage, r.usage, "usage is reported to pi for session totals");
	assert.deepEqual(res.details, r);
	assert.equal(res.isError, false);
	assert.match(res.content[0].text, /^general-purpose completed \(agentId [a-z0-9]{12}, \d+ turns, [\d.]+s\)\n\n/);
	assert.ok(
		t.updates.some((u) => u.endsWith(", read")),
		`progress names the tool: ${t.updates}`,
	);
	assert.ok(
		toolCalls(sessionEntries(t.sessionDir!, r.agentId)).includes("codemode"),
		"children are codemode-only by default: read is called from a script",
	);
	const sessionCost = sessionEntries(t.sessionDir!, r.agentId)
		.filter((e) => e.type === "message" && e.message.role === "assistant")
		.reduce((sum, e) => sum + e.message.usage.cost.total, 0);
	assert.ok(
		Math.abs(sessionCost - r.usage.cost.total) < 1e-9,
		"usage is the sum over the session's assistant messages",
	);
});

test("the child gets XPI_SUBAGENT_DEPTH=1 and the parent's cwd, and runs without a stdin", async () => {
	const s = sandbox();
	const t = await loadTool({}, { cwd: s.repo });
	const r = await t.result({
		prompt:
			'Run this one bash command and then reply OK: printf "%s" "$XPI_SUBAGENT_DEPTH" > depth.txt && pwd -P > cwd.txt && (cat > stdin.txt < /dev/stdin; true)',
	});
	assert.equal(r.status, "completed", r.error ?? "");
	assert.equal(readFileSync(join(s.repo, "depth.txt"), "utf8"), "1");
	assert.equal(readFileSync(join(s.repo, "cwd.txt"), "utf8").trim(), realpathSync(s.repo));
	assert.equal(readFileSync(join(s.repo, "stdin.txt"), "utf8"), "", "stdin was closed");
});

test("with XPI_SUBAGENT_DEPTH set the extension registers nothing", async () => {
	const s = sandbox();
	process.env.XPI_SUBAGENT_DEPTH = "1";
	try {
		const t = await loadTool({}, { cwd: s.repo });
		assert.equal(t.registered, false);
	} finally {
		delete process.env.XPI_SUBAGENT_DEPTH;
	}
});
