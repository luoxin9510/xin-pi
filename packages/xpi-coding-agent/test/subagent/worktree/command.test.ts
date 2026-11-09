// `/subagents worktrees` with a scripted ctx.ui on a temp repo: the list, the confirm that names the loss, the removal.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { worktreesCommand } from "../../../src/extensions/subagent/subagents-command.ts";
import { ensureWorktree, planWorktree } from "../../../src/extensions/subagent/worktree.ts";
import { initRepo } from "../helpers.ts";

const repo = () => initRepo(join(realpathSync(mkdtempSync(join(tmpdir(), "subagent-wtc-"))), "repo"));
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

async function create(dir: string, id: string) {
	const ref = await planWorktree(dir, id);
	await ensureWorktree(ref);
	return ref;
}

// picks[i]: the index of the row chosen at the i-th select (undefined cancels); confirms[i]: the answer at the i-th confirm.
function fakeCtx(cwd: string, picks: (number | undefined)[], confirms: boolean[]) {
	const seen = {
		selects: [] as { title: string; options: string[] }[],
		confirms: [] as { title: string; message: string }[],
		notes: [] as string[],
	};
	const ctx = {
		cwd,
		ui: {
			select: async (title: string, options: string[]) => {
				seen.selects.push({ title, options });
				const i = picks.shift();
				return i === undefined ? undefined : options[i];
			},
			confirm: async (title: string, message: string) => {
				seen.confirms.push({ title, message });
				return confirms.shift() ?? false;
			},
			notify: (message: string) => void seen.notes.push(message),
		},
	};
	return { ctx: ctx as never, seen };
}

test("no worktrees, or no repository: a notice and nothing else", async () => {
	const dir = repo();
	const { ctx, seen } = fakeCtx(dir, [], []);
	await worktreesCommand(ctx);
	assert.equal(seen.selects.length, 0);
	assert.match(seen.notes.join("|"), /no kept worktrees/);
	const plain = fakeCtx(realpathSync(mkdtempSync(join(tmpdir(), "subagent-wtc-"))), [], []);
	await worktreesCommand(plain.ctx);
	assert.match(plain.seen.notes.join("|"), /no kept worktrees/);
});

test("a changed worktree: listed with its summary, the confirm names the files and commits that would be lost, confirming removes it and its branch", async () => {
	const dir = repo();
	const ref = await create(dir, "w1");
	writeFileSync(join(ref.path, "keep.txt"), "x\n");
	git(ref.path, "add", "keep.txt");
	git(ref.path, "commit", "-q", "-m", "keep it");
	writeFileSync(join(ref.path, "loose.txt"), "y\n");
	const { ctx, seen } = fakeCtx(dir, [0], [true]);
	await worktreesCommand(ctx);
	const row = seen.selects[0]!.options[0]!;
	for (const part of ["w1", "subagent/w1", ref.path, "2 files", "1 commit"])
		assert.ok(row.includes(part), `${part} in ${row}`);
	const message = seen.confirms[0]!.message;
	for (const part of ["keep.txt", "loose.txt", "keep it", "subagent/w1", ref.path])
		assert.ok(message.includes(part), `${part} in ${message}`);
	assert.equal(existsSync(ref.path), false);
	assert.equal(git(dir, "branch", "--list", "subagent/*"), "");
	assert.match(seen.notes.join("|"), /removed/);
});

test("declining the confirm, or cancelling the picker, removes nothing; an unchanged one says so", async () => {
	const dir = repo();
	const changed = await create(dir, "c1");
	const idle = await create(dir, "i1");
	writeFileSync(join(changed.path, "u.txt"), "u\n");
	const declined = fakeCtx(dir, [0, undefined], [false]);
	await worktreesCommand(declined.ctx);
	assert.equal(declined.seen.selects.length, 2, "after a declined confirm the list comes back");
	assert.ok(existsSync(changed.path) && existsSync(idle.path));
	const rows = declined.seen.selects[0]!.options;
	const idleIndex = rows.findIndex((r) => r.includes("i1"));
	assert.match(rows[idleIndex]!, /no changes/);
	const unchanged = fakeCtx(dir, [idleIndex, undefined], [true]);
	await worktreesCommand(unchanged.ctx);
	assert.match(unchanged.seen.confirms[0]!.message, /no changes/);
	assert.equal(existsSync(idle.path), false);
	assert.ok(existsSync(changed.path));
});
