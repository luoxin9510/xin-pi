// isolation: "worktree" through the Agent tool on fake pi (no model): the child's cwd and prompt, the meta file, the result
// fields, resume, a stopped run, and git failing. Real git on temp repos in tmpdir. What real pi and haiku do with a
// worktree is in test/real/13-worktree.test.ts.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { agentEndMessage } from "../../../src/extensions/subagent/agent-tool.ts";
import { agentFile, happyLines, initRepo, loadTool, sandbox } from "../helpers.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

// A sandbox with a real repository, a user-level agent `x` (so the repo stays clean), and a persisted parent session.
function setup(fields = "") {
	const s = sandbox();
	initRepo(s.repo);
	s.write(join(s.home, ".claude/agents/x.md"), agentFile(`name: x\ndescription: d\n${fields}`));
	const repo = realpathSync(s.repo);
	const sessionFile = join(s.root, "sessions", "parent-id.jsonl");
	const metaOf = (id: string) =>
		JSON.parse(readFileSync(join(s.root, "sessions", "subagents", "parent-id", `${id}.json`), "utf8"));
	return { s, repo, sessionFile, metaOf, load: () => loadTool({}, { cwd: s.repo, sessionFile }) };
}

test("isolated: the child runs in the worktree, the prompt says so, the meta file keeps path and base; unchanged leaves nothing", async () => {
	const { s, repo, load, metaOf } = setup();
	s.scenario({ lines: happyLines("hi") });
	const r = (await (await load()).run({ subagent_type: "x", isolation: "worktree" })).structuredContent;
	const path = join(repo, ".pi/worktrees", r.agentId);
	assert.equal(r.status, "completed");
	assert.deepEqual(r.worktree, { changed: false });
	assert.equal(s.record().cwd, path); // the fake records process.cwd(), already a real path
	assert.ok(s.record().systemPromptTail!.includes(`Working directory: ${path}`));
	assert.deepEqual(metaOf(r.agentId).worktree, {
		root: repo,
		path,
		branch: `subagent/${r.agentId}`,
		base: git(repo, "rev-parse", "HEAD"),
	});
	assert.equal(existsSync(path), false, "the unchanged worktree is gone");
	assert.equal(git(repo, "branch", "--list", "subagent/*"), "");
	assert.equal(git(repo, "status", "--porcelain"), "");
});

test("isolated and changed: kept, and the result gives path, branch, files and commits; the main checkout is untouched", async () => {
	const { s, repo, load } = setup();
	s.scenario({ lines: happyLines("hi"), writeFile: "out.txt" });
	const res = await (await load()).run({ subagent_type: "x", isolation: "worktree" });
	const r = res.structuredContent;
	const path = join(repo, ".pi/worktrees", r.agentId);
	assert.deepEqual(r.worktree, {
		changed: true,
		path,
		branch: `subagent/${r.agentId}`,
		files: ["out.txt"],
		commits: [],
	});
	assert.equal(readFileSync(join(path, "out.txt"), "utf8"), "written by the fake child\n");
	assert.equal(existsSync(join(repo, "out.txt")), false);
	assert.equal(git(repo, "status", "--porcelain"), "");
	assert.ok(res.content[0].text.includes(path), "the text main reads names the worktree");
});

test("isolation comes from the agent file; a wrong value in the call is a caller error naming it, before any child starts", async () => {
	const { s, repo, load } = setup("isolation: worktree");
	s.scenario({ lines: happyLines() });
	const t = await load();
	const r = (await t.run({ subagent_type: "x" })).structuredContent;
	assert.deepEqual(r.worktree, { changed: false }, "the file's isolation applied");
	assert.equal(
		r.warnings.some((w: string) => w.includes("isolation")),
		false,
		"isolation is no longer an inert field",
	);

	const before = readFileSync(s.root + "/record.json", "utf8");
	await assert.rejects(t.run({ subagent_type: "x", isolation: "remote" }), /isolation "remote"/);
	assert.equal(readFileSync(s.root + "/record.json", "utf8"), before, "no second child was started");
	assert.equal(git(repo, "branch", "--list", "subagent/*"), "");
});

test("not a git repository, and a repository without commits: the call throws naming the cause, no child", async () => {
	const s = sandbox(); // its repo has an empty .git directory: not a repository
	s.write(join(s.home, ".claude/agents/x.md"), agentFile("name: x\ndescription: d"));
	s.scenario({ lines: happyLines() });
	const t = await loadTool({}, { cwd: s.repo });
	await assert.rejects(t.run({ subagent_type: "x", isolation: "worktree" }), /not inside a git repository/);
	assert.equal(existsSync(s.root + "/record.json"), false);

	execFileSync("git", ["init", "-q"], { cwd: s.repo });
	await assert.rejects(t.run({ subagent_type: "x", isolation: "worktree" }), /no commits/);
	assert.equal(existsSync(s.root + "/record.json"), false);
});

test("a dirty main checkout adds a warning to the result", async () => {
	const { s, repo, load } = setup();
	writeFileSync(join(repo, "a.txt"), "dirty\n");
	s.scenario({ lines: happyLines() });
	const r = (await (await load()).run({ subagent_type: "x", isolation: "worktree" })).structuredContent;
	assert.ok(
		r.warnings.some((w: string) => w.includes("uncommitted changes")),
		r.warnings.join("|"),
	);
});

test("resume re-enters a kept worktree, recreates an unchanged removed one, and ignores the call's isolation with a warning", async () => {
	const { s, repo, load } = setup();
	const t = await load();
	s.scenario({ lines: happyLines(), writeFile: "out.txt" });
	const first = (await t.run({ subagent_type: "x", isolation: "worktree" })).structuredContent;
	const path = first.worktree.path;
	s.scenario({ lines: happyLines() });
	const again = (await t.run({ resume: first.agentId, prompt: "more" })).structuredContent;
	assert.equal(s.record().cwd, path, "the kept worktree is the cwd again");
	assert.equal(again.worktree.changed, true);
	assert.deepEqual(again.worktree.files, ["out.txt"]);

	// an unchanged agent: removed after its exchange, recreated by a resume
	const { s: s2, repo: repo2, load: load2 } = setup();
	const t2 = await load2();
	s2.scenario({ lines: happyLines() });
	const plain = (await t2.run({ subagent_type: "x", isolation: "worktree" })).structuredContent;
	const path2 = join(repo2, ".pi/worktrees", plain.agentId);
	assert.equal(existsSync(path2), false);
	const back = (await t2.run({ resume: plain.agentId, prompt: "more", isolation: "worktree" })).structuredContent;
	assert.equal(s2.record().cwd, path2, "recreated at the same path");
	assert.deepEqual(back.worktree, { changed: false });
	assert.ok(
		back.warnings.some((w: string) => w.includes("isolation") && w.includes("resume")),
		back.warnings.join("|"),
	);
	assert.ok(repo);
});

test("a stopped run follows the same rule: unchanged is removed", async () => {
	const { s, repo, load } = setup();
	s.scenario({ lines: happyLines(), hang: true });
	const t = await load();
	const controller = new AbortController();
	const run = t.run({ subagent_type: "x", isolation: "worktree" }, controller.signal);
	for (let i = 0; i < 100 && !existsSync(s.root + "/record.json"); i++) await new Promise((r) => setTimeout(r, 50));
	controller.abort();
	await assert.rejects(run, /aborted/);
	assert.equal(git(repo, "worktree", "list", "--porcelain").includes(".pi/worktrees"), false);
	assert.equal(git(repo, "branch", "--list", "subagent/*"), "");
});

test("concurrent isolated agents in one repository all get their own worktree", async () => {
	const { s, repo, load } = setup();
	s.scenario({ lines: happyLines(), writeFile: "out.txt" });
	const t = await load();
	const results = await Promise.all([1, 2, 3, 4].map(() => t.run({ subagent_type: "x", isolation: "worktree" })));
	const ids = results.map((r) => r.structuredContent.agentId);
	assert.equal(new Set(ids).size, 4);
	for (const r of results) assert.equal(r.structuredContent.worktree.changed, true);
	assert.equal(git(repo, "branch", "--list", "subagent/*").split("\n").length, 4);
});

test("fault: git failing at creation makes the call throw and starts no child", async () => {
	const { s, repo, load } = setup();
	s.scenario({ lines: happyLines() });
	// a `git` that fails for `worktree add` and is the real one otherwise
	const bin = join(s.root, "bin");
	mkdirSync(bin);
	const real = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
	writeFileSync(
		join(bin, "git"),
		`#!/bin/sh\nif [ "$1" = worktree ] && [ "$2" = add ]; then echo "fatal: simulated failure" >&2; exit 128; fi\nexec ${real} "$@"\n`,
	);
	chmodSync(join(bin, "git"), 0o755);
	const t = await load();
	const oldPath = process.env.PATH;
	process.env.PATH = `${bin}:${oldPath}`;
	try {
		await assert.rejects(t.run({ subagent_type: "x", isolation: "worktree" }), /simulated failure/);
	} finally {
		process.env.PATH = oldPath;
	}
	assert.equal(existsSync(s.root + "/record.json"), false, "no child process was started");
	assert.equal(git(repo, "branch", "--list", "subagent/*"), "");
});

test("the end message of a background agent shows a kept worktree and nothing for a removed one", () => {
	const parent = { sessionFile: undefined, sessionId: "p" };
	const base = {
		agentId: "id1",
		agentType: "x",
		output: "done",
		model: "m",
		turns: 1,
		durationMs: 1,
		warnings: [],
		status: "completed" as const,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	const kept = agentEndMessage(parent as any, "id1", "x", {
		...base,
		worktree: {
			changed: true,
			path: "/r/.pi/worktrees/id1",
			branch: "subagent/id1",
			files: ["a.txt", "b.txt"],
			commits: ["abc1234 add b"],
		},
	});
	assert.ok(
		kept.includes("/r/.pi/worktrees/id1") &&
			kept.includes("subagent/id1") &&
			kept.includes("b.txt") &&
			kept.includes("abc1234 add b"),
		kept,
	);
	const removed = agentEndMessage(parent as any, "id1", "x", { ...base, worktree: { changed: false } });
	assert.equal(removed.includes("worktree"), false, removed);
});
