// W4 through the Agent tool on fake pi: the child starts in the parent's subdirectory inside the worktree.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { happyLines, initRepo, loadTool, sandbox } from "../helpers.ts";

test("isolation worktree from a tracked subdirectory: the child's cwd is that subdirectory in the worktree; an untracked one falls back with a warning", async () => {
	const s = sandbox();
	const repo = realpathSync(initRepo(s.repo));
	mkdirSync(join(repo, "pkg/sub"), { recursive: true });
	writeFileSync(join(repo, "pkg/sub/f.txt"), "f\n");
	execFileSync("git", ["add", "."], { cwd: repo });
	execFileSync("git", ["commit", "-q", "-m", "sub"], { cwd: repo });
	mkdirSync(join(repo, "scratch"));
	s.scenario({ lines: happyLines("hi") });

	const t = await loadTool({}, { cwd: join(repo, "pkg/sub") });
	const r = (await t.run({ isolation: "worktree", subagent_type: "general-purpose" })).structuredContent;
	assert.equal(s.record().cwd, join(repo, ".pi/worktrees", r.agentId, "pkg/sub"));

	const u = await loadTool({}, { cwd: join(repo, "scratch") });
	const r2 = (await u.run({ isolation: "worktree", subagent_type: "general-purpose" })).structuredContent;
	assert.equal(s.record().cwd, join(repo, ".pi/worktrees", r2.agentId));
	assert.ok(r2.warnings.some((w: string) => w.includes("not in the worktree")));
});
