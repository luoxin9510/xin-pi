// `mcpServers` in an agent file (spec 05, spec 08): names of servers configured in mcp.json and inline definitions. The
// agent gets those servers' tools and no other server's; an unknown name warns. Inline servers reach the child through
// --mcp-config, by the trust rule of the file's scope.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { parseDefinition } from "../../../src/extensions/subagent/definition.ts";
import { discoverAgents, setCliAgents } from "../../../src/extensions/subagent/discovery.ts";
import { agentFile, ev, flag, loadTool, sandbox } from "../helpers.ts";

const def = (extra: string, scope?: "project" | "user") => {
	const r = parseDefinition("f", `---\nname: a\ndescription: d\n${extra}\n---\nbody`, scope);
	assert.ok(r.ok, JSON.stringify(r));
	return r.def;
};

test("parsing: a list or a comma string of names; no longer inert", () => {
	assert.deepEqual(def("mcpServers: [docs, slack, docs]").mcpServers, ["docs", "slack"]);
	assert.deepEqual(def("mcpServers: docs, slack").mcpServers, ["docs", "slack"]);
	assert.equal(def("model: x").mcpServers, undefined);
	assert.deepEqual(def("mcpServers: [docs]").inert, []);
	const bad = parseDefinition("f", "---\nname: a\ndescription: d\nmcpServers: 5\n---\nbody");
	assert.ok(!bad.ok && /"mcpServers" must be a list of server names or inline definitions/.test(bad.reason));
});

test("parsing inline definitions: a mapping or list entries, validated as mcp.json entries", () => {
	const mixed = def("mcpServers:\n  - docs\n  - local:\n      command: node\n      args: [server.js]");
	assert.deepEqual(mixed.mcpServers, ["docs", "local"]);
	assert.deepEqual(mixed.inlineMcpServers, { local: { command: "node", args: ["server.js"] } });
	assert.deepEqual(mixed.warnings, []);
	const mapping = def(
		"mcpServers:\n  local:\n    command: node\n  web:\n    type: http\n    url: https://web.example/mcp",
	);
	assert.deepEqual(mapping.mcpServers, ["local", "web"]);
	assert.deepEqual(Object.keys(mapping.inlineMcpServers!), ["local", "web"]);
	// What the mcp.json validator rejects is skipped with its message: ws, sse, a bad field.
	const rejected = def(
		"mcpServers:\n  live:\n    type: ws\n    url: wss://x.example\n  old:\n    type: sse\n    url: https://x.example/sse\n  odd:\n    command: 5\n  ok:\n    command: node",
	);
	assert.deepEqual(rejected.mcpServers, ["ok"]);
	assert.deepEqual(rejected.warnings, [
		'mcpServers: inline server skipped: server "live": type "ws" is not supported (use stdio, http or streamable-http)',
		'mcpServers: inline server skipped: server "old": legacy SSE transport is not supported; use the streamable HTTP URL',
		'mcpServers: inline server skipped: server "odd" needs either "command" (stdio) or "url" (streamable HTTP)',
	]);
	assert.match(def("mcpServers:\n  - docs\n  - docs:\n      command: node").warnings[0]!, /"docs" is listed twice/);
});

test("parsing: a project agent file's inline server may not use auth; a user agent file's may", () => {
	const fields = "mcpServers:\n  corp:\n    url: https://corp.example/mcp\n    auth:\n      provider: anthropic";
	const project = def(fields, "project");
	assert.equal(project.scope, "project");
	assert.deepEqual(project.mcpServers, []);
	assert.match(project.warnings[0]!, /inline server "corp" skipped: auth is not allowed in a project agent file/);
	const user = def(fields, "user");
	assert.deepEqual(user.mcpServers, ["corp"]);
	assert.deepEqual(user.warnings, []);
});

// The agent dir's mcp.json is the temp HOME's: three configured servers. The agent file is the project's unless `user`.
async function run(fields: string, options: { trusted?: boolean; user?: boolean } = {}) {
	const s = sandbox();
	s.write(
		join(s.home, ".pi/agent/mcp.json"),
		JSON.stringify({
			mcpServers: {
				docs: { command: "true" },
				"my-slack": { command: "true" },
				jira: { command: "true" },
			},
		}),
	);
	const dir = options.user ? join(s.home, ".pi/agent/agents") : join(s.repo, ".pi/agents");
	s.write(join(dir, "x.md"), agentFile(`name: x\ndescription: d\n${fields}`));
	s.scenario({ lines: [ev.session(), ev.assistant("ok"), ev.turnEnd(), ev.settled()] });
	const t = await loadTool({}, { cwd: s.repo, trusted: options.trusted ?? true });
	const r = (await t.run({ subagent_type: "x" })).structuredContent;
	const argv = s.record().argv;
	const mcpConfig = flag(argv, "--mcp-config");
	return {
		warnings: r.warnings as string[],
		tools: flag(argv, "--tools"),
		exclude: flag(argv, "--exclude-tools"),
		inline: mcpConfig === undefined ? undefined : JSON.parse(mcpConfig).mcpServers,
	};
}

test("with a tools list: the named servers' tools join it, so no other MCP tool is offered", async () => {
	const r = await run("tools: Read\nmcpServers: [docs, my-slack]");
	assert.equal(r.tools, "codemode,read,mcp__docs__*,mcp__my_slack__*");
	assert.equal(r.exclude, undefined);
	assert.deepEqual(r.warnings, []);
});

test("without a tools list: the servers it does not name are taken away", async () => {
	const r = await run("mcpServers: [docs]");
	assert.equal(r.tools, "+codemode");
	assert.equal(r.exclude, "mcp__my_slack__*,mcp__jira__*");
});

test("an empty list means no MCP at all; without the field nothing changes", async () => {
	assert.equal((await run("mcpServers: []")).exclude, "mcp__*");
	assert.equal((await run("tools: Read\nmcpServers: []")).exclude, "mcp__*");
	const plain = await run("model: haiku");
	assert.equal(plain.exclude, undefined);
	assert.equal(plain.tools, "+codemode");
});

test("a name that is not configured warns and is left out", async () => {
	const r = await run("tools: Read\nmcpServers: [docs, ghost]");
	assert.equal(r.tools, "codemode,read,mcp__docs__*");
	assert.deepEqual(r.warnings, ['mcpServers: server "ghost" is not configured in mcp.json']);
});

test("a direct-tools agent: codemode is taken out, and left to MCP only when the child has servers", async () => {
	// Servers configured: MCP may turn codemode on again, for tools reachable only from scripts.
	const direct = await run("codemode: false");
	assert.equal(direct.tools, "-codemode");
	assert.equal(direct.exclude, undefined);
	const named = await run("codemode: false\nmcpServers: [docs]");
	assert.equal(named.tools, "-codemode");
	assert.equal(named.exclude, "mcp__my_slack__*,mcp__jira__*");
	// No servers for this child: excluded, so nothing turns it on.
	const none = await run("codemode: false\nmcpServers: []");
	assert.equal(none.tools, undefined);
	assert.equal(none.exclude, "codemode,mcp__*");
	// A tools list never contains codemode, so MCP cannot turn it on there.
	const listed = await run("codemode: false\ntools: Read\nmcpServers: []");
	assert.equal(listed.tools, "read");
	assert.equal(listed.exclude, "mcp__*");
	const codemodeOnly = await run("model: haiku");
	assert.equal(codemodeOnly.tools, "+codemode");
});

test('childCodemode "inherit": a child without a tools list gets direct tools and no codemode', async () => {
	const s = sandbox();
	s.scenario({ lines: [ev.session(), ev.assistant("ok"), ev.turnEnd(), ev.settled()] });
	const t = await loadTool({ childCodemode: "inherit" }, { cwd: s.repo });
	await t.run({});
	assert.equal(flag(s.record().argv, "--tools"), undefined);
	assert.equal(flag(s.record().argv, "--exclude-tools"), "codemode");
});

const INLINE = "mcpServers:\n  - docs\n  - local:\n      command: node\n      args: [server.js]";

test("inline servers go to the child as --mcp-config JSON; their tools are handled like a named server's", async () => {
	const listed = await run(`tools: Read\n${INLINE}`);
	assert.deepEqual(listed.inline, { local: { command: "node", args: ["server.js"] } });
	assert.equal(listed.tools, "codemode,read,mcp__docs__*,mcp__local__*");
	assert.equal(listed.exclude, undefined);
	assert.deepEqual(listed.warnings, []);
	const unlisted = await run(INLINE);
	assert.equal(unlisted.tools, "+codemode");
	assert.equal(unlisted.exclude, "mcp__my_slack__*,mcp__jira__*");
	// No inline servers: no flag.
	assert.equal((await run("mcpServers: [docs]")).inline, undefined);
});

test("a project agent file's inline servers load only in a trusted project; a user agent file's always", async () => {
	const untrusted = await run(`tools: Read\n${INLINE}`, { trusted: false });
	assert.equal(untrusted.inline, undefined);
	assert.equal(untrusted.tools, "codemode,read,mcp__docs__*");
	assert.deepEqual(untrusted.warnings, ['mcpServers: inline server "local" skipped: the project is not trusted']);
	const user = await run(`tools: Read\n${INLINE}`, { trusted: false, user: true });
	assert.deepEqual(Object.keys(user.inline), ["local"]);
	assert.equal(user.tools, "codemode,read,mcp__docs__*,mcp__local__*");
	assert.deepEqual(user.warnings, []);
});

test("an inline name equal to a configured server's replaces it; one that clashes only in the tool namespace is skipped", async () => {
	const same = await run("tools: Read\nmcpServers:\n  docs:\n    command: my-docs");
	assert.deepEqual(same.inline, { docs: { command: "my-docs" } });
	assert.equal(same.tools, "codemode,read,mcp__docs__*");
	assert.deepEqual(same.warnings, []);
	const clash = await run("tools: Read\nmcpServers:\n  my_slack:\n    command: other\n  ok:\n    command: x");
	assert.deepEqual(Object.keys(clash.inline), ["ok"]);
	assert.equal(clash.tools, "codemode,read,mcp__ok__*");
	assert.deepEqual(clash.warnings, ['mcpServers: inline server "my_slack" skipped: it conflicts with "my-slack"']);
});

test("discovery sets the scope: project files, user files, --agents and built-ins", async () => {
	const s = sandbox();
	s.write(join(s.repo, ".claude/agents/p.md"), agentFile("name: p\ndescription: d"));
	s.write(join(s.home, ".claude/agents/u.md"), agentFile("name: u\ndescription: d"));
	setCliAgents(JSON.stringify({ c: { description: "d", prompt: "" } }), s.repo);
	try {
		const { agents } = discoverAgents(s.repo);
		assert.equal(agents.get("p")!.scope, "project");
		assert.equal(agents.get("u")!.scope, "user");
		assert.equal(agents.get("c")!.scope, "cli");
		assert.equal(agents.get("reviewer")!.scope, "builtin");
	} finally {
		setCliAgents(undefined, s.repo);
	}
});

test("without the built-in MCP extension the child could not take --mcp-config: inline servers are skipped with a warning", async () => {
	const s = sandbox();
	s.write(join(s.repo, ".pi/agents/x.md"), agentFile(`name: x\ndescription: d\ntools: Read\n${INLINE}`));
	s.scenario({ lines: [ev.session(), ev.assistant("ok"), ev.turnEnd(), ev.settled()] });
	const t = await loadTool({}, { cwd: s.repo, noBuiltinMcp: true });
	const r = (await t.run({ subagent_type: "x" })).structuredContent;
	assert.equal(r.status, "completed");
	assert.equal(flag(s.record().argv, "--mcp-config"), undefined);
	assert.deepEqual(r.warnings, [
		'mcpServers: inline server "local" skipped: the built-in MCP extension is not loaded',
		'mcpServers: server "docs" is not configured in mcp.json',
	]);
});

test("server names that are Object.prototype keys are ordinary names", async () => {
	const unknown = await run("tools: Read\nmcpServers: [toString]");
	assert.equal(unknown.tools, "codemode,read");
	assert.deepEqual(unknown.warnings, ['mcpServers: server "toString" is not configured in mcp.json']);
	const inline = await run("tools: Read\nmcpServers:\n  __proto__:\n    command: x");
	assert.deepEqual(Object.keys(inline.inline), ["__proto__"]);
	assert.equal(inline.tools, "codemode,read,mcp____proto____*");
});
