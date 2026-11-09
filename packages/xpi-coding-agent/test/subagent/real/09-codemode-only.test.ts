// Ticket v2-03: children see only `codemode` by default, tool limits hold inside scripts, MCP tools need listing.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { agentFile, childSetup, loadTool, REPLY_OK, sandbox, sessionEntries, toolCalls } from "./helpers.ts";

// A project extension (loaded by every trusted child) that records the tool names each provider request offers
// and registers a fake MCP tool.
const PROBE = (out: string) => `import { appendFileSync } from "node:fs";
export default function (pi) {
  pi.on("before_provider_request", (event) => {
    appendFileSync(${JSON.stringify(out)}, JSON.stringify((event.payload.tools ?? []).map((t) => t.name ?? t.function?.name)) + "\\n");
  });
  pi.registerTool({
    name: "mcp__fake__ping", label: "ping", description: "Fake MCP tool.",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [{ type: "text", text: "pong" }], details: {} }),
  });
}
`;

async function run(fields: string, settings: Record<string, unknown> = {}, prompt = REPLY_OK) {
	const s = sandbox();
	const offered = join(s.root, "offered.jsonl");
	s.write(join(s.repo, ".pi/extensions/probe.ts"), PROBE(offered));
	s.write(join(s.repo, ".pi/agents/x.md"), agentFile(`name: x\ndescription: d\n${fields}`));
	const t = await loadTool(settings, { cwd: s.repo, persist: join(s.root, "sessions") });
	const r = await t.result({ subagent_type: "x", prompt });
	assert.equal(r.status, "completed", r.error ?? "");
	const requests = existsSync(offered)
		? readFileSync(offered, "utf8")
				.trim()
				.split("\n")
				.map((l) => JSON.parse(l) as string[])
		: [];
	const setup = childSetup(t.sessionDir!, r.agentId);
	const entries = sessionEntries(t.sessionDir!, r.agentId);
	// Real tool names offered to the model (pi adds a placeholder for deferred tools).
	const offeredTools = [...new Set(requests.flat())]
		.filter((n) => !n.startsWith("__pi"))
		.map((n) => n.toLowerCase())
		.sort(); // the provider may capitalise names
	return { s, r, setup, entries, offeredTools };
}

test("by default the model is offered only codemode; a tools list is still the script's allowlist", async () => {
	const { s, setup, offeredTools, entries } = await run(
		"tools: Read",
		{},
		'Call the codemode tool once, with exactly this script, then reply DONE:\ntry { await tools.write({ path: "created.txt", content: "hi" }); console.log("wrote"); } catch (e) { console.log("blocked"); }',
	);
	assert.deepEqual(offeredTools, ["codemode"]);
	assert.deepEqual(setup.tools, ["codemode", "read"]);
	assert.ok(toolCalls(entries).includes("codemode"));
	assert.equal(existsSync(join(s.repo, "created.txt")), false, "write is not callable from the script");
});

test("without tools the child gets the user's defaults plus codemode, minus disallowedTools; the prompt ends with the codemode line", async () => {
	const { setup, offeredTools } = await run("disallowedTools: Write");
	assert.deepEqual(offeredTools, ["codemode"]);
	assert.ok(
		["bash", "codemode", "edit", "read"].every((n) => setup.tools.includes(n)),
		setup.tools.join(),
	);
	assert.equal(setup.tools.includes("write"), false);
	assert.match(
		setup.prompt.trim().split("\n").at(-1)!,
		/^Use the `codemode` tool.*independent calls in one script\.$/,
	);
});

test('childCodemode "inherit" and `codemode: false` give v1 behaviour: direct tools, no codemode line', async () => {
	for (const [fields, settings] of [
		["tools: Read, Grep", { childCodemode: "inherit" }],
		["tools: Read, Grep\ncodemode: false", {}],
	] as const) {
		const { setup, offeredTools } = await run(fields, settings);
		assert.deepEqual(offeredTools, ["grep", "read"]);
		assert.deepEqual(setup.tools, ["grep", "read"]);
		assert.doesNotMatch(setup.prompt, /`codemode` tool/);
	}
});

test("a tools list without mcp__ entries excludes MCP tools; listing one keeps it", async () => {
	assert.equal((await run("tools: Read")).setup.tools.includes("mcp__fake__ping"), false);
	assert.equal((await run("tools: Read, mcp__fake__ping")).setup.tools.includes("mcp__fake__ping"), true);
	assert.equal((await run("")).setup.tools.includes("mcp__fake__ping"), true, "no tools list: MCP tools stay");
	assert.equal(
		(await run("tools: Read", { childCodemode: "inherit" })).setup.tools.includes("mcp__fake__ping"),
		false,
	);
});
