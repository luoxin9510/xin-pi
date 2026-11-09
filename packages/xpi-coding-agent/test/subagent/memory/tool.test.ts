// Memory through the Agent tool on fake pi (no model): where the directories land (main checkout, never the agent's
// worktree; the parent's cwd outside a repo), info/exclude for local scope, user scope under the temp HOME.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { agentFile, happyLines, initRepo, loadTool, sandbox } from "../helpers.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function setup(fields: string, repo = true) {
	const s = sandbox();
	if (repo) initRepo(s.repo);
	s.write(join(s.home, ".claude/agents/x.md"), agentFile(`name: x\ndescription: d\n${fields}`));
	s.scenario({ lines: happyLines("hi") });
	return { s, root: realpathSync(s.repo) };
}

test("project memory lives under the main checkout, also when the agent runs in a worktree; the prompt names it", async () => {
	const { s, root } = setup("memory: project\nisolation: worktree");
	const t = await loadTool({}, { cwd: s.repo });
	const r = (await t.run({ subagent_type: "x" })).structuredContent;
	const dir = join(root, ".claude/agent-memory/x");
	assert.ok(existsSync(dir));
	assert.ok(s.record().systemPrompt!.includes(dir));
	assert.equal(
		r.warnings.some((w: string) => w.includes('"memory"')),
		false,
		"memory is no longer an inert field",
	);
	assert.equal(existsSync(join(root, ".pi/worktrees", r.agentId, ".claude/agent-memory")), false);
});

test("user memory lives under HOME/.claude/agent-memory", async () => {
	const { s } = setup("memory: user");
	const t = await loadTool({}, { cwd: s.repo });
	await t.run({ subagent_type: "x" });
	assert.ok(existsSync(join(realpathSync(s.home), ".claude/agent-memory/x")));
});

test("local memory appends its directory to info/exclude once, so git status stays clean", async () => {
	const { s, root } = setup("memory: local");
	const t = await loadTool({}, { cwd: s.repo });
	await t.run({ subagent_type: "x" });
	await t.run({ subagent_type: "x" });
	const exclude = readFileSync(join(root, ".git/info/exclude"), "utf8").split("\n");
	assert.equal(exclude.filter((l) => l === "/.claude/agent-memory-local/x/").length, 1);
	assert.ok(existsSync(join(root, ".claude/agent-memory-local/x")));
	assert.equal(git(root, "status", "--porcelain"), "");
});

test("outside a git repository project and local memory use the parent's cwd and write no exclude file", async () => {
	const { s } = setup("memory: local", false);
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "subagent-nogit-")));
	mkdirSync(dir, { recursive: true });
	const t = await loadTool({}, { cwd: dir });
	const r = (await t.run({ subagent_type: "x" })).structuredContent;
	assert.equal(r.status, "completed");
	assert.ok(existsSync(join(dir, ".claude/agent-memory-local/x")));
	assert.equal(existsSync(join(dir, ".git")), false);
	void s;
});

test("a read-only memory puts a warning on the result", async () => {
	const { s } = setup("memory: project\ntools: Read\ndisallowedTools: Write");
	const t = await loadTool({}, { cwd: s.repo });
	const r = (await t.run({ subagent_type: "x" })).structuredContent;
	assert.ok(r.warnings.some((w: string) => w.includes("read-only")));
});
