// The child's system prompt as two prompt-cache regions (cache ticket 02): the head is the same text for every agent
// type and for a worktree child, everything that names the agent, its directory, the date, its memory or its skills
// is in the tail. No model: `resolveChild` and fake pi. What the model's cache does with it is test:subagent:cache.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readConfig } from "../../../src/extensions/subagent/config.ts";
import { parseDefinition } from "../../../src/extensions/subagent/definition.ts";
import { type ParentContext, type ResolveOptions, resolveChild } from "../../../src/extensions/subagent/resolve.ts";
import { agentFile, happyLines, initRepo, loadTool, sandbox } from "../helpers.ts";

const config = readConfig(undefined);

function setup() {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "subagent-cache-")));
	const root = join(dir, "repo");
	mkdirSync(join(root, ".claude/skills/lint"), { recursive: true });
	writeFileSync(join(root, ".claude/skills/lint/SKILL.md"), "---\nname: lint\ndescription: d\n---\nLINT-SKILL-BODY\n");
	const parent: ParentContext = { cwd: root, thinking: "off", trusted: true, sessionId: "p" };
	const resolve = (name: string, fields: string, body: string, options: ResolveOptions = {}) => {
		const r = parseDefinition(`${name}.md`, agentFile(`name: ${name}\ndescription: d\n${fields}`, body));
		assert.ok(r.ok);
		return resolveChild(r.def, { description: "d", prompt: "p" }, config, parent, {
			memoryRoot: root,
			claudeDir: join(dir, "claude"),
			...options,
		});
	};
	return { root, resolve };
}

test("two agent types get the same head; body, skills, memory, cwd and date are in the tail", () => {
	const t = setup();
	const a = t.resolve("reviewer", "memory: project\nskills: lint", "REVIEWER-BODY").systemPrompt;
	const b = t.resolve("explorer", "", "EXPLORER-BODY").systemPrompt;
	assert.equal(a.head, b.head);
	assert.notEqual(a.tail, b.tail);
	const today = new Date().toISOString().slice(0, 10);
	for (const marker of [
		"REVIEWER-BODY",
		"LINT-SKILL-BODY",
		"# Persistent memory",
		`Working directory: ${t.root}`,
		`Date: ${today}`,
	]) {
		assert.ok(a.tail.includes(marker), marker);
		assert.equal(a.head.includes(marker), false, marker);
	}
	assert.equal(a.head.includes(t.root), false, "the head names no directory");
	assert.equal(a.head.includes(today), false, "the head has no date");
	assert.ok(a.head.includes("<instructions>"), "the head says where the role is");
});

test("a worktree child gets the head of a child in the main checkout; only the tail names the worktree", () => {
	const t = setup();
	const path = join(t.root, ".pi/worktrees/id1");
	const main = t.resolve("x", "", "BODY").systemPrompt;
	const isolated = t.resolve("x", "", "BODY", {
		worktree: { root: t.root, path, branch: "subagent/id1", base: "abc" },
	}).systemPrompt;
	assert.equal(isolated.head, main.head);
	assert.ok(isolated.tail.includes(`Working directory: ${path}`));
	assert.ok(main.tail.includes(`Working directory: ${t.root}\n`));
});

test("the child process is given the head as --system-prompt and the tail as --system-prompt-tail", async () => {
	const s = sandbox();
	initRepo(s.repo);
	s.write(join(s.home, ".claude/agents/x.md"), agentFile("name: x\ndescription: d", "AGENT-X-BODY"));
	s.write(join(s.home, ".claude/agents/y.md"), agentFile("name: y\ndescription: d", "AGENT-Y-BODY"));
	const t = await loadTool({}, { cwd: s.repo });
	s.scenario({ lines: happyLines() });
	await t.run({ subagent_type: "x" });
	const x = s.record();
	await t.run({ subagent_type: "y", isolation: "worktree" });
	const y = s.record();
	assert.ok(x.argv.includes("--system-prompt") && x.argv.includes("--system-prompt-tail"));
	assert.ok(x.systemPrompt && x.systemPrompt === y.systemPrompt, "one head for both children");
	assert.ok(x.systemPromptTail!.includes("AGENT-X-BODY") && !x.systemPrompt.includes("AGENT-X-BODY"));
	assert.ok(y.systemPromptTail!.includes("AGENT-Y-BODY") && y.systemPromptTail!.includes(".pi/worktrees/"));
});

test("inline MCP servers are part of the prefix key: their tools come before the system prompt", () => {
	const t = setup();
	const servers = (command: string) => `tools: Read\nmcpServers:\n  local:\n    command: ${command}`;
	const options = { mcpServers: [] };
	const a = t.resolve("a", servers("one"), "BODY", options);
	const same = t.resolve("b", servers("one"), "OTHER-BODY", options);
	const other = t.resolve("c", servers("two"), "BODY", options);
	assert.equal(a.prefixKey, same.prefixKey);
	assert.notEqual(a.prefixKey, other.prefixKey);
});

test("an agent's extensions are part of the prefix key: the tools they register come before the system prompt", () => {
	const t = setup();
	const a = t.resolve("a", "extensions: [npm:guard-one]", "BODY");
	const same = t.resolve("b", "extensions: [npm:guard-one]", "OTHER-BODY");
	const other = t.resolve("c", "extensions: [npm:guard-two]", "BODY");
	assert.equal(a.prefixKey, same.prefixKey);
	assert.notEqual(a.prefixKey, other.prefixKey);
	assert.notEqual(a.prefixKey, t.resolve("d", "", "BODY").prefixKey);
});
