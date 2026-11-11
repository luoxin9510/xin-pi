// Spec 05 on real haiku: `mcpServers` in an agent file narrows the child's MCP tools to the named servers, and
// `background: true` makes a plain call return at once with the result arriving as a message.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
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

// Spec 08: an inline stdio server in the agent file (the xpi-mcp echo fixture) is started by the child alone.
const ECHO_SERVER = fileURLToPath(new URL("../../../../xpi-mcp/test/fixtures/stdio-server.mjs", import.meta.url));

test("an inline mcpServers definition: the child starts the server and the agent answers from its tool", async () => {
	const s = sandbox();
	const fields = [
		"name: x",
		"description: d",
		"mcpServers:",
		"  probe:",
		`    command: ${JSON.stringify(process.execPath)}`,
		`    args: [${JSON.stringify(ECHO_SERVER)}]`,
	].join("\n");
	s.write(join(s.repo, ".pi/agents/x.md"), agentFile(fields));
	const t = await loadTool({}, { cwd: s.repo, persist: join(s.root, "sessions") });
	const r = await t.result({
		subagent_type: "x",
		prompt:
			'Call the MCP tool echo of server "probe" with {"text": "zebra-4417"} and reply with exactly what it returned, nothing else.',
	});
	assert.equal(r.status, "completed", r.error ?? "");
	assert.deepEqual(r.warnings, []);
	assert.match(r.output, /zebra-4417/);
});

// Spec 08: permissionMode plan leaves the child no tool that writes, from a script either.
test("permissionMode plan: asked to write a file, the agent cannot, and says so", async () => {
	const s = sandbox();
	s.write(join(s.repo, ".pi/agents/x.md"), agentFile("name: x\ndescription: d\npermissionMode: plan"));
	const t = await loadTool({}, { cwd: s.repo, persist: join(s.root, "sessions") });
	const r = await t.result({
		subagent_type: "x",
		prompt:
			"Create the file out.txt in the working directory with the content hi. If you have no way to create it, reply with the single word CANNOT.",
	});
	assert.equal(r.status, "completed", r.error ?? "");
	assert.ok(!existsSync(join(s.repo, "out.txt")), "the file was not written");
	assert.match(r.output, /CANNOT/);
	const tools = childSetup(t.sessionDir!, r.agentId).tools;
	for (const name of ["write", "edit", "bash"]) assert.ok(!tools.includes(name), `${name} in ${tools}`);
});

// Spec 08: an agent's own extension is its hook. This one blocks bash in the child (from a codemode script too).
const BASH_GUARD = `export default function (pi) {
  pi.on("tool_call", (event) => {
    if (event.toolName === "bash") return { block: true, reason: "bash is blocked by the guard extension" };
  });
}
`;

test("extensions: the agent's guard extension blocks bash in its child, and the agent reports the block", async () => {
	const s = sandbox();
	s.write(join(s.repo, ".pi/agents/guards/no-bash.js"), BASH_GUARD);
	s.write(join(s.repo, ".pi/agents/x.md"), agentFile("name: x\ndescription: d\nextensions: [./guards/no-bash.js]"));
	const t = await loadTool({}, { cwd: s.repo, persist: join(s.root, "sessions") });
	const r = await t.result({
		subagent_type: "x",
		prompt:
			"Run the shell command `echo hi` with the bash tool. If the call is refused, reply with BLOCKED followed by the reason you were given.",
	});
	assert.equal(r.status, "completed", r.error ?? "");
	assert.match(r.output, /BLOCKED/);
	assert.match(r.output, /guard extension/);
});

test("extensions: one that throws while loading stops the child; the result is failed with the error", async () => {
	const s = sandbox();
	s.write(
		join(s.repo, ".pi/agents/broken.js"),
		'export default function () { throw new Error("guard-broke-4471"); }\n',
	);
	s.write(join(s.repo, ".pi/agents/x.md"), agentFile("name: x\ndescription: d\nextensions: [./broken.js]"));
	const t = await loadTool({}, { cwd: s.repo, persist: join(s.root, "sessions") });
	const r = await t.result({ subagent_type: "x", prompt: REPLY_OK });
	assert.equal(r.status, "failed");
	assert.match(r.error ?? "", /guard-broke-4471/);
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
