// Ticket 04: tool mapping and permission flags, read off the child's active tools and from what it can do.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { agentFile, childSetup, loadTool, REPLY_OK, sandbox } from "./helpers.ts";

async function runAgent(
	fields: string,
	settings: Record<string, unknown> = {},
	trusted = true,
	params: Record<string, unknown> = {},
	files: Record<string, string> = {},
) {
	const s = sandbox();
	s.write(join(s.repo, ".pi/agents/x.md"), agentFile(`name: x\ndescription: d\n${fields}`));
	for (const [path, text] of Object.entries(files)) s.write(join(s.repo, path), text);
	const t = await loadTool(settings, { cwd: s.repo, trusted, persist: join(s.root, "sessions") });
	const r = await t.result({ subagent_type: "x", prompt: REPLY_OK, ...params });
	assert.equal(r.status, "completed", r.error ?? "");
	return { setup: childSetup(t.sessionDir!, r.agentId), warnings: r.warnings, repo: s.repo, root: s.root };
}

test("Claude names map to pi names; deny first; Bash(...) removes bash; mcp and pi names pass; unmapped warns", async () => {
	const { setup, warnings } = await runAgent(
		"tools: Read, Grep, Glob, LS, Bash, WebFetch, mcp__gh__search, Agent, Task, Edit, custom_tool\ndisallowedTools: Bash(git push *), Edit",
	);
	// mcp__gh__search and custom_tool are passed to pi by name; no such tool exists here, so pi activates nothing for them.
	assert.deepEqual(setup.tools, ["codemode", "find", "grep", "ls", "read"]);
	assert.deepEqual(warnings, ['tool "WebFetch" has no pi equivalent'], "Agent and Task are dropped silently");
});

test("toolMap from settings extends the map", async () => {
	const { setup, warnings } = await runAgent("tools: Read, WebFetch", { toolMap: { WebFetch: "grep" } });
	assert.deepEqual(setup.tools, ["codemode", "grep", "read"]);
	assert.deepEqual(warnings, []);
});

test("without tools the child gets pi's defaults minus the denied tools", async () => {
	const { setup } = await runAgent("disallowedTools: Write");
	assert.ok(setup.tools.includes("read") && setup.tools.includes("bash") && setup.tools.includes("edit"));
	assert.equal(setup.tools.includes("write"), false);
});

test("a read-only agent cannot change files", async () => {
	const { repo } = await runAgent("tools: Read", {}, true, {
		prompt:
			"Create a file named created.txt in the current directory containing the word hi. If you cannot, reply CANNOT.",
	});
	assert.equal(existsSync(join(repo, "created.txt")), false);
});

test("a tools list that ends up empty throws", async () => {
	const s = sandbox();
	for (const fields of ["tools: Bash\ndisallowedTools: Bash", "tools: WebFetch"]) {
		s.write(join(s.repo, ".pi/agents/x.md"), agentFile(`name: x\ndescription: d\n${fields}`));
		const t = await loadTool({}, { cwd: s.repo });
		await assert.rejects(t.run({ subagent_type: "x" }), /agent "x" has no usable tools/);
	}
});

test("omitClaudeMd drops context files; trust decides whether project extensions load", async () => {
	const files = { "AGENTS.md": "Project context.\n" };
	assert.equal((await runAgent("", {}, true, {}, files)).setup.hasContextFiles, true);
	assert.equal((await runAgent("omitClaudeMd: true", {}, true, {}, files)).setup.hasContextFiles, false);

	for (const trusted of [true, false]) {
		const s = sandbox();
		s.write(
			join(s.repo, ".pi/extensions/marker.ts"),
			`import { writeFileSync } from "node:fs";\nexport default function () { writeFileSync(${JSON.stringify(join(s.root, "loaded"))}, "yes"); }\n`,
		);
		const t = await loadTool({}, { cwd: s.repo, trusted });
		assert.equal((await t.result({ prompt: REPLY_OK })).status, "completed");
		assert.equal(
			existsSync(join(s.root, "loaded")),
			trusted,
			`trusted=${trusted}: a trusted project's extensions load in the child, an untrusted one's do not`,
		);
	}
});

test("name is accepted without a warning", async () => {
	const { warnings } = await runAgent("", {}, true, { name: "bob" });
	assert.deepEqual(warnings, []);
});
