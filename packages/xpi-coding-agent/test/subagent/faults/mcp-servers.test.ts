// `mcpServers` in an agent file (spec 05): names of servers configured in mcp.json. The agent gets those servers' tools
// and no other server's; an unknown name and an inline definition warn.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { parseDefinition } from "../../../src/extensions/subagent/definition.ts";
import { agentFile, ev, flag, loadTool, sandbox } from "../helpers.ts";

const def = (extra: string) => {
	const r = parseDefinition("f", `---\nname: a\ndescription: d\n${extra}\n---\nbody`);
	assert.ok(r.ok, JSON.stringify(r));
	return r.def;
};

test("parsing: a list or a comma string of names; inline definitions are skipped with a warning; no longer inert", () => {
	assert.deepEqual(def("mcpServers: [docs, slack, docs]").mcpServers, ["docs", "slack"]);
	assert.deepEqual(def("mcpServers: docs, slack").mcpServers, ["docs", "slack"]);
	assert.equal(def("model: x").mcpServers, undefined);
	assert.deepEqual(def("mcpServers: [docs]").inert, []);
	const mixed = def("mcpServers:\n  - docs\n  - local:\n      command: node\n      args: [server.js]");
	assert.deepEqual(mixed.mcpServers, ["docs"]);
	assert.equal(mixed.warnings.length, 1);
	assert.match(mixed.warnings[0]!, /inline definition of "local" is not supported and was skipped/);
	const mapping = def("mcpServers:\n  local:\n    command: node");
	assert.deepEqual(mapping.mcpServers, []);
	assert.match(mapping.warnings[0]!, /inline definition of "local"/);
	const bad = parseDefinition("f", "---\nname: a\ndescription: d\nmcpServers: 5\n---\nbody");
	assert.ok(!bad.ok && /"mcpServers" must be a list of server names/.test(bad.reason));
});

// The agent dir's mcp.json is the temp HOME's: three configured servers.
async function run(fields: string) {
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
	s.write(join(s.repo, ".pi/agents/x.md"), agentFile(`name: x\ndescription: d\n${fields}`));
	s.scenario({ lines: [ev.session(), ev.assistant("ok"), ev.turnEnd(), ev.settled()] });
	const t = await loadTool({}, { cwd: s.repo });
	const r = (await t.run({ subagent_type: "x" })).structuredContent;
	const argv = s.record().argv;
	return { warnings: r.warnings as string[], tools: flag(argv, "--tools"), exclude: flag(argv, "--exclude-tools") };
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

test("a direct-tools agent without a tools list takes codemode out of the child's default tools", async () => {
	const direct = await run("codemode: false");
	assert.equal(direct.tools, "-codemode");
	const codemodeOnly = await run("model: haiku");
	assert.equal(codemodeOnly.tools, "+codemode");
});

test('childCodemode "inherit": a child without a tools list gets direct tools and no codemode', async () => {
	const s = sandbox();
	s.scenario({ lines: [ev.session(), ev.assistant("ok"), ev.turnEnd(), ev.settled()] });
	const t = await loadTool({ childCodemode: "inherit" }, { cwd: s.repo });
	await t.run({});
	assert.equal(flag(s.record().argv, "--tools"), "-codemode");
});
