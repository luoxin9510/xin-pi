// Worktree isolation and agent memory inside a checkout of xin-pi itself (a local clone in tmpdir, never this checkout):
// the repo has its own `.pi/` (extensions, prompts, skills) and gitignores `.claude/`, and its developers work in linked
// git worktrees, where `.git` is a file. The kept worktree must land in `.pi/worktrees/` without making the checkout
// dirty, from the clone and from a linked worktree of it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { agentFile, loadTool, ROOT, sandbox } from "./helpers.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const WRITE =
	"Create a file named x.txt in the current directory containing exactly the word hello. Then reply with the single word DONE.";
const MEMO =
	"Save to your memory: the release day is always TUESDAY-5521. Write it into MEMORY.md in your memory directory, then reply DONE.";

// A clone of the xin-pi checkout this suite runs from, with an identity set in its own config.
function clone(into: string) {
	const top = git(ROOT, "rev-parse", "--show-toplevel");
	const dir = join(into, "xin-pi");
	execFileSync("git", ["clone", "-q", "--local", "--no-hardlinks", top, dir], { stdio: "pipe" });
	git(dir, "config", "user.name", "Test");
	git(dir, "config", "user.email", "test@example.com");
	return realpathSync(dir);
}

test("isolation: worktree in a clone of xin-pi and in a linked worktree of it; the checkout stays clean", async () => {
	const s = sandbox();
	const repo = clone(s.root);
	s.write(join(s.home, ".claude/agents/x.md"), agentFile("name: x\ndescription: d\nisolation: worktree"));
	for (const cwd of [repo, join(s.root, "linked")]) {
		if (cwd !== repo) git(repo, "worktree", "add", "-q", "-b", "dev", cwd);
		const here = realpathSync(cwd);
		const t = await loadTool({}, { cwd: here, persist: join(s.root, "sessions") });
		const r = await t.result({ subagent_type: "x", prompt: WRITE });
		assert.equal(r.status, "completed", r.error ?? "");
		const path = join(here, ".pi/worktrees", r.agentId);
		assert.deepEqual(r.worktree, {
			changed: true,
			path,
			branch: `subagent/${r.agentId}`,
			files: ["x.txt"],
			commits: [],
		});
		assert.equal(readFileSync(join(path, "x.txt"), "utf8").trim(), "hello");
		assert.equal(existsSync(join(here, "x.txt")), false);
		assert.equal(git(here, "status", "--porcelain"), "", `${cwd} stays clean: .pi/worktrees is excluded`);
		const exclude = join(git(here, "rev-parse", "--path-format=absolute", "--git-common-dir"), "info", "exclude");
		assert.match(readFileSync(exclude, "utf8"), /^\/\.pi\/worktrees\/$/m);
	}
});

test("memory: project in a clone of xin-pi (where .claude/ is gitignored) is written and read back", async () => {
	const s = sandbox();
	const repo = clone(s.root);
	s.write(join(s.home, ".claude/agents/m.md"), agentFile("name: m\ndescription: d\nmemory: project"));
	const t = await loadTool({}, { cwd: repo });
	const w = await t.result({ subagent_type: "m", prompt: MEMO });
	assert.equal(w.status, "completed", w.error ?? "");
	const file = join(repo, ".claude/agent-memory/m/MEMORY.md");
	assert.ok(
		existsSync(file) && readFileSync(file, "utf8").includes("TUESDAY-5521"),
		"the note is in the memory directory",
	);
	assert.equal(git(repo, "status", "--porcelain"), "", "ignored by the checkout's own .gitignore");
	const r = await t.result({
		subagent_type: "m",
		prompt:
			"What is the release day according to your memory? Reply with the exact token only. Do not call any tool.",
	});
	assert.match(r.output, /TUESDAY-5521/);
});
