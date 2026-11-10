// Spec 05 on real haiku: `mcpServers` in an agent file narrows the child's MCP tools to the named servers, and
// `background: true` makes a plain call return at once with the result arriving as a message.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { agentFile, childSetup, loadTool, REPLY_OK, sandbox } from "./helpers.ts";

// A project extension (every trusted child loads it) that registers one tool for each of two "servers", named as the
// MCP extension names them. The servers themselves are in mcp.json, disabled, so nothing is started.
const FAKE_TOOLS = `export default function (pi) {
  for (const server of ["docs", "slack"]) {
    pi.registerTool({
      name: "mcp__" + server + "__ping", label: "ping", description: "Fake MCP tool of " + server + ".",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ content: [{ type: "text", text: "pong" }], details: {} }),
    });
  }
}
`;

async function tools(fields: string) {
	const s = sandbox();
	s.write(
		join(s.agentDir, "mcp.json"),
		JSON.stringify({
			mcpServers: {
				docs: { command: "true", enabled: false },
				slack: { command: "true", enabled: false },
			},
		}),
	);
	s.write(join(s.repo, ".pi/extensions/fake-mcp.ts"), FAKE_TOOLS);
	s.write(join(s.repo, ".pi/agents/x.md"), agentFile(`name: x\ndescription: d\n${fields}`));
	const t = await loadTool({}, { cwd: s.repo, persist: join(s.root, "sessions") });
	const r = await t.result({ subagent_type: "x", prompt: REPLY_OK });
	assert.equal(r.status, "completed", r.error ?? "");
	assert.deepEqual(r.warnings, []);
	return childSetup(t.sessionDir!, r.agentId).tools.filter((name: string) => name.startsWith("mcp__"));
}

test("mcpServers: the child has the named server's tools and not the other's, with or without a tools list", async () => {
	assert.deepEqual(await tools("mcpServers: [docs]"), ["mcp__docs__ping"]);
	assert.deepEqual(await tools("tools: Read\nmcpServers: [slack]"), ["mcp__slack__ping"]);
	assert.deepEqual(await tools("mcpServers: []"), []);
	assert.deepEqual((await tools("model: haiku")).sort(), ["mcp__docs__ping", "mcp__slack__ping"]);
});

test("background: true returns at once; the result arrives as a message", async () => {
	const s = sandbox();
	s.write(join(s.repo, ".pi/agents/bg.md"), agentFile("name: bg\ndescription: d\nbackground: true"));
	const t = await loadTool({}, { cwd: s.repo, persist: join(s.root, "sessions") });
	const r = await t.result({ subagent_type: "bg", prompt: "Reply with exactly the word PLUM. Do not call any tool." });
	assert.equal(r.status, "running");
	for (const end = Date.now() + 90_000; t.messages.length === 0; ) {
		if (Date.now() > end) throw new Error("timed out waiting for the end message");
		await new Promise((res) => setTimeout(res, 50));
	}
	assert.match(t.messages[0]!.message.content as string, /Background agent .* bg completed[\s\S]*PLUM/);
});
