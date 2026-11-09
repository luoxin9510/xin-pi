// v3b ticket 02: `/subagents worktrees` in real interactive pi (pty + headless xterm). No model turn is needed: the
// worktree is made with git before the command runs, so this only needs pi's credentials to start.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ensureWorktree, planWorktree } from "../../../src/extensions/subagent/worktree.ts";
import { initRepo } from "../helpers.ts";
import { withPi } from "./harness.ts";

test("/subagents worktrees shows a kept worktree with its changes, and removes it after a confirm that names the loss", async () => {
	await withPi({}, async (pi) => {
		await pi.waitFor("claude-haiku");
		const repo = realpathSync(initRepo(pi.repo));
		const ref = await planWorktree(repo, "wt01");
		await ensureWorktree(ref);
		writeFileSync(join(ref.path, "precious.txt"), "work\n");

		pi.submit("/subagents worktrees");
		await pi.waitFor("Kept worktrees");
		const list = await pi.waitFor("subagent/wt01");
		assert.match(list, /wt01 · subagent\/wt01 · 1 file, 0 commits/);
		pi.press("enter");
		const confirm = await pi.waitFor("Remove worktree?");
		assert.match(confirm, /precious\.txt/);
		assert.match(confirm, /will be lost/);
		pi.press("enter"); // the first choice is Yes
		await pi.waitFor("removed worktree");
		assert.equal(existsSync(ref.path), false);
		assert.equal(execFileSync("git", ["branch", "--list", "subagent/*"], { cwd: repo, encoding: "utf8" }).trim(), "");
	});
});
