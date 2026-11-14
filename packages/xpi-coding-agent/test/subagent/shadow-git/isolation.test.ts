// isolation: "worktree" in a shadow-git workspace (a sandbox `sub-<agentId>` of the shadow repo instead of a git worktree
// under .pi/worktrees), through the Agent tool on fake pi: the child's cwd and environment, the meta file, settling,
// resume, `/subagents worktrees`, and nesting refused. Real stores and sandboxes (policy backend) in tmpdir; no model.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { findWorkspace } from "../../../src/extensions/shadow-git/workspace.ts";
import { sandboxLauncher } from "../../../src/extensions/subagent/sandbox-worktree.ts";
import { subagentsCommand } from "../../../src/extensions/subagent/subagents-command.ts";
import {
	ensureWorktree,
	listWorktrees,
	planWorktree,
	removeWorktree,
	settleWorktree,
	worktreeCwd,
	worktreeSubdir,
} from "../../../src/extensions/subagent/worktree.ts";
import { agentFile, happyLines, loadTool, sandbox } from "../helpers.ts";
import { type Lab, lab, write } from "./lab.ts";

async function setup(options: { subdirFile?: boolean } = {}) {
	const l = await lab();
	const s = sandbox(); // sets HOME and the fake pi's files; the lab's environment stays
	s.write(join(s.home, ".claude/agents/x.md"), agentFile("name: x\ndescription: d"));
	if (options.subdirFile) {
		write(l.ws, "src/deep/f.txt", "f\n");
		l.git("add", "-A");
		l.git("commit", "-q", "-m", "deep");
	}
	const sessionFile = join(l.root, "sessions", "parent-id.jsonl");
	const metaOf = (id: string) =>
		JSON.parse(readFileSync(join(l.root, "sessions", "subagents", "parent-id", `${id}.json`), "utf8"));
	const trees = (id: string) => join(l.store, "demo.sbx", `sub-${id}`);
	const branches = () => l.git("for-each-ref", "--format=%(refname:short)", "refs/heads/sbx/").trim();
	return { l, s, sessionFile, metaOf, trees, branches, load: (cwd = l.ws) => loadTool({}, { cwd, sessionFile }) };
}

const branchList = (l: Lab) => l.git("for-each-ref", "--format=%(refname:short)", "refs/heads/sbx/").trim();

const savedHome = process.env.HOME;
test.after(() => {
	process.env.HOME = savedHome;
});

test("isolated and unchanged: the child runs in the sandbox with the sandbox's environment; the sandbox and its branch are gone after", async () => {
	const { l, s, load, metaOf, trees, branches } = await setup();
	try {
		s.scenario({ lines: happyLines("hi") });
		const r = (await (await load()).run({ subagent_type: "x", isolation: "worktree" })).structuredContent;
		const id = `sub-${r.agentId}`;
		const tree = join(trees(r.agentId), "tree");
		assert.equal(r.status, "completed");
		assert.deepEqual(r.worktree, { changed: false });
		const rec = s.record();
		assert.equal(rec.cwd, tree);
		assert.ok(rec.systemPromptTail!.includes(`Working directory: ${tree}`));
		assert.deepEqual(rec.env, {
			XPI_SG_SANDBOX: `demo/${id}`,
			XPI_SG_BACKEND: "policy",
			XPI_SG_STORE: l.store,
			GIT_DIR: join(l.store, "demo.git", "worktrees", id),
			GIT_WORK_TREE: tree,
		});
		assert.equal(rec.depth, "1");
		assert.deepEqual(metaOf(r.agentId).worktree, {
			kind: "shadow-git",
			root: l.ws,
			path: tree,
			branch: `sbx/${id}`,
			base: l.git("rev-parse", "main").trim(),
			repo: "demo",
			sandbox: id,
			backend: "policy",
		});
		assert.equal(existsSync(trees(r.agentId)), false, "the unchanged sandbox is gone");
		assert.equal(branches(), "");
		assert.equal(l.git("status", "--porcelain").trim(), "");
		assert.equal(existsSync(join(l.ws, ".pi")), false, "nothing is placed in the workspace");
	} finally {
		l.restore();
	}
});

test("a child that is not isolated gets GIT_DIR and GIT_WORK_TREE of the primary from xpi's own environment", async () => {
	const { l, s, load } = await setup();
	try {
		// what builtin:shadow-git sets in a session in the workspace
		process.env.GIT_DIR = join(l.store, "demo.git");
		process.env.GIT_WORK_TREE = l.ws;
		s.scenario({ lines: happyLines("hi") });
		await (await load()).run({ subagent_type: "x" });
		const rec = s.record();
		assert.equal(rec.env!.GIT_DIR, join(l.store, "demo.git"));
		assert.equal(rec.env!.GIT_WORK_TREE, l.ws);
		assert.equal(rec.env!.XPI_SG_SANDBOX, undefined);
		assert.equal(rec.cwd, l.ws);
	} finally {
		l.restore();
	}
});

test("isolated and changed: kept; the result names the sandbox, its branch and /sg merge; the primary is untouched; a resume re-enters it", async () => {
	const { l, s, load, trees, branches } = await setup();
	try {
		s.scenario({ lines: happyLines("hi"), writeFile: "out.txt" });
		const t = await load();
		const res = await t.run({ subagent_type: "x", isolation: "worktree" });
		const r = res.structuredContent;
		const id = `sub-${r.agentId}`;
		const tree = join(trees(r.agentId), "tree");
		assert.deepEqual(r.worktree, {
			changed: true,
			path: tree,
			branch: `sbx/${id}`,
			files: ["out.txt"],
			commits: [],
			note: `the user merges it with /sg merge sbx/${id}`,
		});
		assert.equal(readFileSync(join(tree, "out.txt"), "utf8"), "written by the fake child\n");
		assert.equal(existsSync(join(l.ws, "out.txt")), false);
		assert.ok(res.content[0].text.includes(`sbx/${id}`));
		assert.ok(res.content[0].text.includes("/sg merge"));
		assert.equal(branches(), `sbx/${id}`);

		// the resume runs in the same sandbox, whatever isolation it is asked for
		s.scenario({ lines: happyLines("again") });
		const again = (await t.run({ subagent_type: "x", resume: r.agentId })).structuredContent;
		assert.equal(s.record().cwd, tree);
		assert.equal(s.record().env!.XPI_SG_SANDBOX, `demo/${id}`);
		assert.equal(again.worktree.changed, true, "still holds the file");
	} finally {
		l.restore();
	}
});

test("settle: a commit keeps the sandbox with its commits and files; a clean one with no commits is removed with the branch", async () => {
	const { l } = await setup();
	try {
		const ref = await planWorktree(l.ws, "abc", undefined);
		assert.equal(ref.kind, "shadow-git");
		assert.equal(ref.sandbox, "sub-abc");
		assert.deepEqual(await ensureWorktree(ref), []);
		assert.equal(existsSync(ref.path), true);
		assert.deepEqual(await settleWorktree(ref), { changed: false });
		assert.equal(existsSync(ref.path), false);
		assert.equal(branchList(l), "");

		// again, with a commit in the sandbox
		await ensureWorktree(ref);
		const env = {
			...process.env,
			GIT_DIR: join(l.store, "demo.git", "worktrees", "sub-abc"),
			GIT_WORK_TREE: ref.path,
		};
		writeFileSync(join(ref.path, "c.txt"), "c\n");
		execFileSync("git", ["add", "c.txt"], { cwd: ref.path, env });
		execFileSync("git", ["commit", "-q", "-m", "add c"], { cwd: ref.path, env });
		const outcome = await settleWorktree(ref);
		assert.equal(outcome.changed, true);
		if (outcome.changed) {
			assert.deepEqual(outcome.files, ["c.txt"]);
			assert.equal(outcome.commits.length, 1);
			assert.match(outcome.commits[0], /add c$/);
		}
		assert.equal(existsSync(ref.path), true);
		assert.equal(branchList(l), "sbx/sub-abc");

		// removed whatever it holds
		await removeWorktree(ref);
		assert.equal(existsSync(ref.path), false);
		assert.equal(branchList(l), "");
	} finally {
		l.restore();
	}
});

test("a sandbox whose directory vanished is reported gone; one removed while its branch stays cannot be silently recreated", async () => {
	const { l } = await setup();
	try {
		const ref = await planWorktree(l.ws, "gone1", undefined);
		await ensureWorktree(ref);
		const env = {
			...process.env,
			GIT_DIR: join(l.store, "demo.git", "worktrees", "sub-gone1"),
			GIT_WORK_TREE: ref.path,
		};
		writeFileSync(join(ref.path, "c.txt"), "c\n");
		execFileSync("git", ["add", "c.txt"], { cwd: ref.path, env });
		execFileSync("git", ["commit", "-q", "-m", "x"], { cwd: ref.path, env });
		await settleWorktree(ref);
		const removed = await l.sg(["sbx", "rm", "sub-gone1"]); // the branch stays
		assert.equal(removed.code, 0, removed.err);
		await assert.rejects(ensureWorktree(ref), /was removed but its branch sbx\/sub-gone1 still exists/);
		assert.deepEqual(await settleWorktree(ref), { changed: false, gone: true });
		// a second agent cannot take the id of a sandbox that is still there
		await assert.rejects(planWorktree(l.ws, "gone1", undefined), /exists already/);
	} finally {
		l.restore();
	}
});

test("the child starts in the sandbox at the parent's subdirectory when the commit has it; else at the root, with a warning", async () => {
	const { l, s, load } = await setup({ subdirFile: true });
	try {
		s.scenario({ lines: happyLines("hi") });
		const r = (await (await load(join(l.ws, "src", "deep"))).run({ subagent_type: "x", isolation: "worktree" }))
			.structuredContent;
		assert.equal(s.record().cwd, join(l.store, "demo.sbx", `sub-${r.agentId}`, "tree", "src", "deep"));

		write(l.ws, "newdir/x.txt", "untracked\n");
		const r2 = (await (await load(join(l.ws, "newdir"))).run({ subagent_type: "x", isolation: "worktree" }))
			.structuredContent;
		assert.equal(s.record().cwd, join(l.store, "demo.sbx", `sub-${r2.agentId}`, "tree"));
		assert.ok(r2.warnings.some((w: string) => w.includes("is not in the sandbox")));
		const ref = await planWorktree(l.ws, "q", undefined);
		assert.deepEqual(await worktreeSubdir(ref, join(l.ws, "src")), { subdir: "src" });
	} finally {
		l.restore();
	}
});

test("a dirty primary adds a warning: the sandbox starts from the committed state", async () => {
	const { l, s, load } = await setup();
	try {
		write(l.ws, "a.txt", "edited in the primary\n");
		s.scenario({ lines: happyLines("hi") });
		const r = (await (await load()).run({ subagent_type: "x", isolation: "worktree" })).structuredContent;
		assert.ok(r.warnings.some((w: string) => w.includes("uncommitted changes")));
	} finally {
		l.restore();
	}
});

// `/subagents worktrees` with a scripted picker: the first row, then "no".
function worktreesCtx(l: Lab, answers: { confirm: boolean }) {
	const notes: string[] = [];
	const rows: string[][] = [];
	const picks: string[] = [];
	return {
		notes,
		rows,
		picks,
		ctx: {
			cwd: l.ws,
			ui: {
				notify: (message: string) => notes.push(message),
				select: async (_title: string, items: string[]) => {
					rows.push(items);
					if (picks.length > 0) return undefined; // second round: leave
					picks.push(items[0]);
					return items[0];
				},
				confirm: async (_title: string, text: string) => {
					notes.push(`confirm: ${text}`);
					return answers.confirm;
				},
			},
			sessionManager: { getSessionId: () => "parent-id" },
		} as any,
	};
}

test("/subagents worktrees lists a kept sandbox, removes it with its branch on confirm, and a resume then says it was removed", async () => {
	const { l, s, load, trees, branches } = await setup();
	try {
		s.scenario({ lines: happyLines("hi"), writeFile: "out.txt" });
		const t = await load();
		const r = (await t.run({ subagent_type: "x", isolation: "worktree" })).structuredContent;
		const id = `sub-${r.agentId}`;
		const listed = await listWorktrees(l.ws);
		assert.deepEqual(
			listed.map((w) => w.agentId),
			[r.agentId],
		);
		assert.equal(listed[0].ref.kind, "shadow-git");

		// not confirmed: still there
		const no = worktreesCtx(l, { confirm: false });
		await subagentsCommand(no.ctx, "worktrees");
		assert.match(no.rows[0][0], new RegExp(`${r.agentId} · sbx/${id} · 1 file, 0 commits · `));
		assert.ok(no.notes.some((n) => n.startsWith("confirm: ") && n.includes("will be lost") && n.includes("out.txt")));
		assert.equal(existsSync(trees(r.agentId)), true);

		const yes = worktreesCtx(l, { confirm: true });
		await subagentsCommand(yes.ctx, "worktrees");
		assert.equal(existsSync(trees(r.agentId)), false);
		assert.equal(branches(), "");
		assert.ok(yes.notes.some((n) => n.includes(`removed worktree`) && n.includes(`sbx/${id}`)));
		s.scenario({ lines: happyLines("again") });
		await assert.rejects(t.run({ subagent_type: "x", resume: r.agentId }), /was removed by the user/);
	} finally {
		l.restore();
	}
});

test("/subagents worktrees lists only the sandboxes xpi made for agents, not the user's own", async () => {
	const { l } = await setup();
	try {
		await l.sg(["sbx", "create", "mine"]);
		assert.deepEqual(await listWorktrees(l.ws), []);
	} finally {
		l.restore();
	}
});

test("inside a sandbox, isolation worktree is refused with the reason, before anything is made or started", async () => {
	const { l, s, load } = await setup();
	try {
		await l.sg(["sbx", "create", "w1"]);
		process.env.XPI_SG_SANDBOX = "demo/w1";
		s.scenario({ lines: happyLines("hi") });
		const t = await load(join(l.store, "demo.sbx", "w1", "tree"));
		await assert.rejects(t.run({ subagent_type: "x", isolation: "worktree" }), /sandboxes do not nest/);
		assert.equal(existsSync(join(s.root, "record.json")), false, "no child was started");
		assert.equal(branchList(l), "sbx/w1");
	} finally {
		l.restore();
	}
});

test("a registry that cannot be read means not a workspace: plain worktrees are used and nothing throws", async () => {
	const { l } = await setup();
	try {
		rmSync(join(l.store, "registry"));
		mkdirSync(join(l.store, "registry")); // reading it fails with EISDIR, not with a core error
		assert.equal(findWorkspace(l.ws), undefined);
		await assert.rejects(planWorktree(l.ws, "x1", undefined), /needs a git repository/);
	} finally {
		l.restore();
	}
});

test("the launcher follows the backend that is used now: the ref's recorded backend and so the child's cwd", async () => {
	const { l } = await setup();
	try {
		const ref = await planWorktree(l.ws, "bk", undefined);
		await ensureWorktree(ref);
		ref.backend = "namespace"; // recorded when it was planned; this machine has no namespace backend now
		assert.equal(worktreeCwd(ref), l.ws);
		await sandboxLauncher(ref);
		assert.equal(ref.backend, "policy");
		assert.equal(worktreeCwd(ref), ref.path);
		await settleWorktree(ref);
	} finally {
		l.restore();
	}
});
