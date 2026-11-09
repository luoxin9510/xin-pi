// Review fixes W1-W5, M4 on temp repos: real git, no model, no child.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	addExclude,
	ensureWorktree,
	gitRoot,
	listWorktrees,
	planWorktree,
	removeWorktree,
	settleWorktree,
	worktreeSubdir,
} from "../../../src/extensions/subagent/worktree.ts";
import { initRepo } from "../helpers.ts";

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "subagent-wtb-")));
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

test("W1: a worktree that only holds new gitignored files is kept and lists them", async () => {
	const dir = repo();
	write(join(dir, ".gitignore"), "dist/\n.env\n");
	git(dir, "add", ".gitignore");
	git(dir, "commit", "-q", "-m", "ignore");
	const ref = await create(dir, "ign");
	write(join(ref.path, "dist/out.js"), "x\n");
	write(join(ref.path, ".env"), "SECRET=1\n");
	const outcome = await settleWorktree(ref);
	assert.equal(outcome.changed, true);
	assert.deepEqual(outcome.changed && outcome.files.sort(), [".env", "dist/out.js"]);
	assert.ok(existsSync(ref.path), "kept");
});

test("W1: ignored files copied by .worktreeinclude and untouched, and .pi/, do not count", async () => {
	const dir = repo();
	write(join(dir, ".gitignore"), ".env\n.pi/\n");
	write(join(dir, ".worktreeinclude"), ".env\n");
	git(dir, "add", ".gitignore", ".worktreeinclude");
	git(dir, "commit", "-q", "-m", "ignore");
	write(join(dir, ".env"), "SECRET=1\n");
	const ref = await create(dir, "inc");
	assert.equal(readFileSync(join(ref.path, ".env"), "utf8"), "SECRET=1\n");
	write(join(ref.path, ".pi/state.json"), "{}\n");
	assert.deepEqual(await settleWorktree(ref), { changed: false });
	const ref2 = await create(dir, "inc2");
	write(join(ref2.path, ".env"), "SECRET=2\n"); // modified copy counts
	const outcome = await settleWorktree(ref2);
	assert.deepEqual(outcome.changed && outcome.files, [".env"]);
});

test("W2: detached HEAD, another branch checked out, or a stash made in the worktree keep it with a note", async () => {
	const dir = repo();
	const a = await create(dir, "det");
	git(a.path, "checkout", "-q", "--detach");
	const oa = await settleWorktree(a);
	assert.equal(oa.changed, true);
	assert.match(oa.changed ? oa.note! : "", /not on branch subagent\/det/);

	const b = await create(dir, "oth");
	git(b.path, "checkout", "-q", "-b", "feature");
	const ob = await settleWorktree(b);
	assert.equal(ob.changed, true);
	assert.match(ob.changed ? ob.note! : "", /feature/);

	const c = await create(dir, "stash");
	write(join(c.path, "a.txt"), "edited\n");
	git(c.path, "stash");
	const oc = await settleWorktree(c);
	assert.equal(oc.changed, true);
	assert.match(oc.changed ? oc.note! : "", /stash/);
	git(dir, "stash", "drop"); // tidy the shared stack of this temp repo
});

test("W3: listWorktrees finds worktrees under .pi/worktrees whatever their branch; removal tolerates a missing subagent branch", async () => {
	const dir = repo();
	const a = await create(dir, "ren");
	git(a.path, "branch", "-m", "renamed");
	const b = await create(dir, "dtc");
	git(b.path, "checkout", "-q", "--detach");
	git(dir, "worktree", "add", "-q", "-b", "elsewhere", join(tmp(), "elsewhere"));
	const list = await listWorktrees(dir);
	assert.deepEqual(list.map((w) => w.agentId).sort(), ["dtc", "ren"]);
	for (const w of list) {
		assert.equal(w.outcome.changed, true, `${w.agentId} is not on subagent/${w.agentId}`);
		await removeWorktree(w.ref);
		assert.equal(existsSync(w.ref.path), false);
	}
});

test("W4: the child's directory is the parent's subdirectory inside the worktree; an untracked one falls back with a warning", async () => {
	const dir = repo();
	write(join(dir, "pkg/sub/f.txt"), "f\n");
	git(dir, "add", ".");
	git(dir, "commit", "-q", "-m", "sub");
	mkdirSync(join(dir, "untracked"));
	const ref = await planWorktree(join(dir, "pkg/sub"), "sd");
	assert.deepEqual(await worktreeSubdir(ref, join(dir, "pkg/sub")), { subdir: "pkg/sub" });
	await ensureWorktree(ref);
	assert.ok(existsSync(join(ref.path, "pkg/sub")));
	assert.deepEqual(await worktreeSubdir(ref, dir), { subdir: "" });
	const bad = await worktreeSubdir(ref, join(dir, "untracked"));
	assert.equal(bad.subdir, "");
	assert.match(bad.warning!, /untracked.*not in the worktree/);
});

test("W5: addExclude recognises its line in a CRLF exclude file", async () => {
	const dir = repo();
	const file = join(dir, ".git/info/exclude");
	writeFileSync(file, "# c\r\n/.pi/worktrees/\r\n");
	await addExclude(dir, "/.pi/worktrees/");
	assert.equal(readFileSync(file, "utf8"), "# c\r\n/.pi/worktrees/\r\n");
});

test("M4: gitRoot from a linked worktree is the main checkout; a plain repo and a subdirectory are unchanged", async () => {
	const dir = repo();
	mkdirSync(join(dir, "sub"));
	const linked = join(tmp(), "linked");
	git(dir, "worktree", "add", "-q", "-b", "other", linked);
	assert.equal(await gitRoot(linked), dir);
	assert.equal(await gitRoot(dir), dir);
	assert.equal(await gitRoot(join(dir, "sub")), dir);
	assert.equal(await gitRoot(tmp()), undefined);
});
