// `permissionMode` in an agent file (spec 08, decision 3). `plan` makes the agent read-only: an allowlist of reading
// tools (narrowed by `tools`), the write, shell and MCP tools excluded so nothing reaches them (codemode scripts
// included), read-only memory and a line in the prompt tail. Every other Claude Code mode changes nothing.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { parseDefinition } from "../../../src/extensions/subagent/definition.ts";
import { agentFile, ev, flag, loadTool, sandbox } from "../helpers.ts";

const parse = (fields: string) => parseDefinition("f", agentFile(`name: a\ndescription: d\n${fields}`));

test("parsing: the seven Claude Code values are accepted; an unknown one skips the file; no longer inert", () => {
	for (const mode of ["default", "manual", "acceptEdits", "auto", "dontAsk", "bypassPermissions", "plan"]) {
		const r = parse(`permissionMode: ${mode}`);
		assert.ok(r.ok, mode);
		assert.equal(r.def.permissionMode, mode);
		assert.deepEqual(r.def.inert, []);
	}
	const bad = parse("permissionMode: readonly");
	assert.ok(!bad.ok && /"permissionMode" must be default \| manual \| acceptEdits/.test(bad.reason));
});

test("parsing: a mode other than plan warns once (at discovery); plan ignores mcpServers with a warning", () => {
	const accept = parse("permissionMode: acceptEdits");
	assert.ok(accept.ok);
	assert.deepEqual(accept.def.warnings, [
		'permissionMode "acceptEdits" has no effect: xpi never asks for permission; runs as bypassPermissions',
	]);
	const plan = parse("permissionMode: plan\nmcpServers:\n  - docs\n  - local:\n      command: node");
	assert.ok(plan.ok);
	assert.equal(plan.def.mcpServers, undefined);
	assert.equal(plan.def.inlineMcpServers, undefined);
	assert.deepEqual(plan.def.warnings, [
		'mcpServers is ignored with permissionMode "plan": MCP tools can change things',
	]);
	const quiet = parse("permissionMode: plan");
	assert.ok(quiet.ok);
	assert.deepEqual(quiet.def.warnings, []);
	// An empty list asks for no MCP anyway: nothing to warn about.
	const empty = parse("permissionMode: plan\nmcpServers: []");
	assert.ok(empty.ok);
	assert.deepEqual(empty.def.warnings, []);
});

async function run(fields: string, settings: Record<string, unknown> = {}, params: Record<string, unknown> = {}) {
	const s = sandbox();
	s.write(join(s.home, ".pi/agent/mcp.json"), JSON.stringify({ mcpServers: { docs: { command: "true" } } }));
	s.write(join(s.repo, ".pi/agents/x.md"), agentFile(`name: x\ndescription: d\n${fields}`));
	s.scenario({ lines: [ev.session(), ev.assistant("ok"), ev.turnEnd(), ev.settled()] });
	const t = await loadTool(settings, { cwd: s.repo });
	const r = (await t.run({ subagent_type: "x", ...params })).structuredContent;
	const record = s.record();
	return {
		r,
		tools: flag(record.argv, "--tools"),
		exclude: flag(record.argv, "--exclude-tools"),
		mcpConfig: flag(record.argv, "--mcp-config"),
		noMcp: record.argv.includes("--no-mcp"),
		tail: record.systemPromptTail ?? "",
	};
}

const EXCLUDED = "write,edit,bash,powershell,mcp__*";

test("plan without a tools list: the reading tools only; write, shell and MCP tools are excluded", async () => {
	const codemodeOnly = await run("permissionMode: plan");
	assert.equal(codemodeOnly.tools, "codemode,read,grep,find,ls");
	assert.equal(codemodeOnly.exclude, EXCLUDED);
	// No MCP server starts (mcp.json configures one), so no MCP or resource tool exists in the child.
	assert.ok(codemodeOnly.noMcp);
	assert.ok(!(await run("model: haiku")).noMcp);
	const direct = await run("permissionMode: plan\ncodemode: false");
	assert.equal(direct.tools, "read,grep,find,ls");
	// Without codemode in the selection the MCP extension must not turn it on: it is excluded too.
	assert.equal(direct.exclude, `${EXCLUDED},codemode`);
	assert.match(codemodeOnly.tail, /You are a read-only planning agent \(permission mode plan\)/);
	assert.doesNotMatch((await run("model: haiku")).tail, /read-only planning agent/);
});

test("plan with a tools list: its intersection with the reading tools; none left is the no-usable-tools error", async () => {
	const narrowed = await run("permissionMode: plan\ntools: Read, Write, Bash, Grep");
	assert.equal(narrowed.tools, "codemode,read,grep");
	assert.equal(narrowed.exclude, EXCLUDED);
	const s = sandbox();
	s.write(
		join(s.repo, ".pi/agents/x.md"),
		agentFile("name: x\ndescription: d\npermissionMode: plan\ntools: Write, Bash"),
	);
	const t = await loadTool({}, { cwd: s.repo });
	await assert.rejects(t.run({ subagent_type: "x" }), /agent "x" has no usable tools/);
});

test("plan: disallowedTools still applies; mcpServers gives no --mcp-config; a schema adds StructuredOutput", async () => {
	const denied = await run("permissionMode: plan\ndisallowedTools: Grep, Bash");
	assert.equal(denied.tools, "codemode,read,find,ls");
	assert.equal(denied.exclude, `grep,${EXCLUDED}`);
	const servers = await run("permissionMode: plan\nmcpServers:\n  local:\n    command: node");
	assert.equal(servers.mcpConfig, undefined);
	assert.equal(servers.exclude, EXCLUDED);
	const schema = { type: "object", properties: { plan: { type: "string" } }, required: ["plan"] };
	const structured = await run("permissionMode: plan", {}, { schema });
	assert.equal(structured.tools, "codemode,read,grep,find,ls,StructuredOutput");
});

test("plan: agent memory is read-only, in plan mode's words, and no write tool comes with it", async () => {
	const r = await run("permissionMode: plan\nmemory: project");
	assert.equal(r.tools, "codemode,read,grep,find,ls");
	assert.equal(r.exclude, EXCLUDED);
	assert.match(r.tail, /This memory is read-only in plan mode: read it, do not change it\./);
	assert.doesNotMatch(r.tail, /Save what a later run would want to know/);
	assert.deepEqual(r.r.warnings, []);
	// Memory brings `read` to a tools list without it, as a read-only memory does elsewhere.
	assert.equal((await run("permissionMode: plan\nmemory: project\ntools: Grep")).tools, "codemode,read,grep");
});

test("a mode other than plan changes nothing in the child", async () => {
	const plain = await run("tools: Read, Write");
	const accept = await run("tools: Read, Write\npermissionMode: bypassPermissions");
	assert.equal(accept.tools, plain.tools);
	assert.equal(accept.exclude, plain.exclude);
	assert.deepEqual(accept.r.warnings, []);
});
