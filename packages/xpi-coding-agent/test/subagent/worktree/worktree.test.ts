// The worktree module on temp repos in tmpdir: real git, no model, no child.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	ensureWorktree,
	planWorktree,
	removeWorktree,
	settleWorktree,
} from "../../../src/extensions/subagent/worktree.ts";
import { initRepo } from "../helpers.ts";

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "subagent-wt-")));
const repo = () => initRepo(join(tmp(), "repo"));
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const branches = (cwd: string) => git(cwd, "branch", "--list", "subagent/*");
const write = (path: string, text: string) => {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, text);
};

async function create(dir: string, id: string) {
	const ref = await planWorktree(dir, id);
	const warnings = await ensureWorktree(ref);
	return { ref, warnings };
}

test("create: worktree at <repo>/.pi/worktrees/<id> on subagent/<id>, based on HEAD, /.pi/worktrees/ excluded once", async () => {
	const dir = repo();
	const { ref, warnings } = await create(dir, "abc");
	assert.equal(ref.root, dir);
	assert.equal(ref.path, join(dir, ".pi/worktrees/abc"));
	assert.equal(ref.branch, "subagent/abc");
	assert.equal(ref.base, git(dir, "rev-parse", "HEAD"));
	assert.deepEqual(warnings, []);
	assert.equal(git(ref.path, "rev-parse", "--abbrev-ref", "HEAD"), "subagent/abc");
	assert.equal(readFileSync(join(ref.path, "a.txt"), "utf8"), "a\n");
	assert.equal(git(dir, "status", "--porcelain"), "", "the worktree is not an untracked file of the main checkout");

	await create(dir, "def");
	const exclude = readFileSync(join(dir, ".git/info/exclude"), "utf8");
	assert.equal(exclude.split("\n").filter((l) => l === "/.pi/worktrees/").length, 1);
});

test("create from a repo that is itself a linked worktree uses the shared info/exclude", async () => {
	const dir = repo();
	const linked = join(tmp(), "linked");
	git(dir, "worktree", "add", "-q", "-b", "other", linked);
	const { ref } = await create(linked, "xyz");
	assert.equal(ref.root, linked);
	assert.equal(ref.path, join(linked, ".pi/worktrees/xyz"));
	assert.match(readFileSync(join(dir, ".git/info/exclude"), "utf8"), /^\/\.pi\/worktrees\/$/m);
	assert.equal(git(linked, "status", "--porcelain"), "");
});

test("a dirty main checkout adds a warning; the worktree has HEAD's content only", async () => {
	const dir = repo();
	write(join(dir, "a.txt"), "changed\n");
	const { ref, warnings } = await create(dir, "dirty");
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /uncommitted changes/);
	assert.equal(readFileSync(join(ref.path, "a.txt"), "utf8"), "a\n");
});

test("changed detection: unchanged is removed with its branch", async () => {
	const dir = repo();
	const { ref } = await create(dir, "same");
	assert.deepEqual(await settleWorktree(ref), { changed: false });
	assert.equal(existsSync(ref.path), false);
	assert.equal(branches(dir), "");
	assert.equal(git(dir, "worktree", "list", "--porcelain").includes(".pi/worktrees"), false);
});

test("changed detection: an uncommitted tracked change keeps it", async () => {
	const dir = repo();
	const { ref } = await create(dir, "mod");
	write(join(ref.path, "a.txt"), "edited\n");
	const out = await settleWorktree(ref);
	assert.deepEqual(out, { path: ref.path, branch: "subagent/mod", changed: true, files: ["a.txt"], commits: [] });
	assert.equal(existsSync(ref.path), true);
	assert.match(branches(dir), /subagent\/mod/);
});

test("changed detection: an untracked file keeps it", async () => {
	const dir = repo();
	const { ref } = await create(dir, "new");
	write(join(ref.path, "sub/n.txt"), "n\n");
	const out = await settleWorktree(ref);
	assert.equal(out.changed, true);
	assert.deepEqual(out.files, ["sub/n.txt"]);
	assert.deepEqual(out.commits, []);
});

test("changed detection: a new commit keeps it, with its files and commits", async () => {
	const dir = repo();
	const { ref } = await create(dir, "commit");
	write(join(ref.path, "b.txt"), "b\n");
	git(ref.path, "add", "b.txt");
	git(ref.path, "commit", "-q", "-m", "add b");
	const out = await settleWorktree(ref);
	assert.equal(out.changed, true);
	assert.deepEqual(out.files, ["b.txt"]);
	assert.equal(out.commits?.length, 1);
	assert.match(out.commits![0], /^[0-9a-f]+ add b$/);
});

test("removeWorktree removes a changed worktree and its branch", async () => {
	const dir = repo();
	const { ref } = await create(dir, "gone");
	write(join(ref.path, "u.txt"), "u\n");
	await removeWorktree(ref);
	assert.equal(existsSync(ref.path), false);
	assert.equal(branches(dir), "");
});

test("errors name the cause: not a repository, no commits", async () => {
	const plain = tmp();
	await assert.rejects(
		planWorktree(plain, "x"),
		(e: Error) => e.message.includes("not inside a git repository") && e.message.includes(plain),
	);
	const empty = tmp();
	git(empty, "init", "-q");
	await assert.rejects(
		planWorktree(empty, "x"),
		(e: Error) => e.message.includes("no commits") && e.message.includes(empty),
	);
});

test(".worktreeinclude: only files that match a pattern and are gitignored are copied, directories recursively", async () => {
	const dir = repo();
	write(join(dir, ".gitignore"), ".env\nnode_modules/\nother.txt\n");
	write(join(dir, ".env"), "SECRET=1\n");
	write(join(dir, "node_modules/p/i.js"), "x\n");
	write(join(dir, "other.txt"), "not listed\n");
	write(join(dir, "untracked-not-ignored.txt"), "u\n");
	write(join(dir, ".worktreeinclude"), ".env\nnode_modules/\nuntracked-not-ignored.txt\na.txt\n");
	git(dir, "add", ".gitignore", ".worktreeinclude");
	git(dir, "commit", "-q", "-m", "setup");
	const { ref } = await create(dir, "inc");
	assert.equal(readFileSync(join(ref.path, ".env"), "utf8"), "SECRET=1\n");
	assert.equal(readFileSync(join(ref.path, "node_modules/p/i.js"), "utf8"), "x\n");
	assert.equal(existsSync(join(ref.path, "other.txt")), false, "ignored but not listed");
	assert.equal(existsSync(join(ref.path, "untracked-not-ignored.txt")), false, "listed but not ignored");
	// the copies are ignored files: they do not make the worktree changed
	assert.deepEqual(await settleWorktree(ref), { changed: false });
});

test("a missing .worktreeinclude copies nothing; a catch-all pattern never copies other worktrees", async () => {
	const dir = repo();
	write(join(dir, ".gitignore"), "*.log\n");
	write(join(dir, "x.log"), "log\n");
	write(join(dir, ".worktreeinclude"), "*\n");
	git(dir, "add", ".gitignore", ".worktreeinclude");
	git(dir, "commit", "-q", "-m", "setup");
	const first = await create(dir, "one");
	const second = await create(dir, "two");
	assert.equal(readFileSync(join(first.ref.path, "x.log"), "utf8"), "log\n");
	assert.equal(existsSync(join(second.ref.path, ".pi/worktrees/one")), false);
});

test("recreate: an unchanged worktree removed after an exchange comes back at the same path and branch from the current HEAD", async () => {
	const dir = repo();
	const { ref } = await create(dir, "again");
	await settleWorktree(ref);
	write(join(dir, "c.txt"), "c\n");
	git(dir, "add", "c.txt");
	git(dir, "commit", "-q", "-m", "second");
	await ensureWorktree(ref);
	assert.equal(ref.base, git(dir, "rev-parse", "HEAD"), "the stored base is updated");
	assert.equal(readFileSync(join(ref.path, "c.txt"), "utf8"), "c\n");
	assert.equal(git(ref.path, "rev-parse", "--abbrev-ref", "HEAD"), "subagent/again");
});

test("a kept worktree is re-entered as it is; one removed by the user while its branch remains is an error naming the path", async () => {
	const dir = repo();
	const { ref } = await create(dir, "kept");
	write(join(ref.path, "k.txt"), "k\n");
	const base = ref.base;
	await settleWorktree(ref);
	await ensureWorktree(ref);
	assert.equal(ref.base, base);
	assert.equal(readFileSync(join(ref.path, "k.txt"), "utf8"), "k\n");

	git(dir, "worktree", "remove", "--force", ref.path);
	await assert.rejects(
		ensureWorktree(ref),
		(e: Error) => e.message.includes(ref.path) && e.message.includes("subagent/kept"),
	);
});

test("concurrent creates in one repo all succeed", async () => {
	const dir = repo();
	const ids = Array.from({ length: 8 }, (_, i) => `c${i}`);
	await Promise.all(ids.map((id) => create(dir, id)));
	assert.equal(branches(dir).split("\n").length, 8);
	for (const id of ids) assert.equal(existsSync(join(dir, ".pi/worktrees", id, "a.txt")), true);
});
