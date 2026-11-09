// Listing and removing kept worktrees (`/subagents worktrees`) on temp repos: real git, no model, no child.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	ensureWorktree,
	listWorktrees,
	planWorktree,
	removeWorktree,
} from "../../../src/extensions/subagent/worktree.ts";
import { initRepo } from "../helpers.ts";

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "subagent-wtl-")));
const repo = () => initRepo(join(tmp(), "repo"));
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const write = (path: string, text: string) => {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, text);
};

async function create(dir: string, id: string) {
	const ref = await planWorktree(dir, id);
	await ensureWorktree(ref);
	return ref;
}

test("listWorktrees: subagent/* worktrees of the main checkout with a change summary, also from inside a worktree; other worktrees ignored", async () => {
	const dir = repo();
	const a = await create(dir, "aaa");
	const b = await create(dir, "bbb");
	git(dir, "worktree", "add", "-q", "-b", "other", join(tmp(), "elsewhere"));
	write(join(a.path, "u.txt"), "u\n");
	write(join(b.path, "c.txt"), "c\n");
	git(b.path, "add", "c.txt");
	git(b.path, "commit", "-q", "-m", "add c");
	for (const from of [dir, b.path]) {
		const list = await listWorktrees(from);
		assert.deepEqual(list.map((w) => w.agentId).sort(), ["aaa", "bbb"]);
		const la = list.find((w) => w.agentId === "aaa")!;
		assert.deepEqual([la.ref.branch, la.ref.path, la.ref.root], ["subagent/aaa", a.path, dir]);
		assert.deepEqual(la.outcome, {
			changed: true,
			path: a.path,
			branch: "subagent/aaa",
			files: ["u.txt"],
			commits: [],
		});
		const lb = list.find((w) => w.agentId === "bbb")!;
		assert.deepEqual(lb.outcome.changed && lb.outcome.files, ["c.txt"]);
		assert.equal(lb.outcome.changed && lb.outcome.commits.length, 1);
	}
});

test("listWorktrees: an unchanged worktree reads as unchanged; none, or outside a repository, gives an empty list", async () => {
	const dir = repo();
	assert.deepEqual(await listWorktrees(dir), []);
	assert.deepEqual(await listWorktrees(tmp()), []);
	const ref = await create(dir, "idle");
	const [w] = await listWorktrees(dir);
	assert.deepEqual(w.outcome, { changed: false });
	assert.equal(w.ref.base, ref.base);
});

test("listWorktrees then removeWorktree: changed and unchanged both go, with their branches", async () => {
	const dir = repo();
	const changed = await create(dir, "rm1");
	const plain = await create(dir, "rm2");
	write(join(changed.path, "u.txt"), "u\n");
	for (const w of await listWorktrees(dir)) await removeWorktree(w.ref);
	assert.equal(existsSync(changed.path), false);
	assert.equal(existsSync(plain.path), false);
	assert.equal(git(dir, "branch", "--list", "subagent/*"), "");
	assert.deepEqual(await listWorktrees(dir), []);
});
