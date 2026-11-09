// Review fixes for worktree isolation and memory (no model, fake pi, real git on temp repos): a user-removed changed
// worktree, an aborted foreground call, a running agent's worktree, branches already gone, a throw before the child
// starts, and a failing .worktreeinclude check.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { registry } from "../../../src/extensions/subagent/registry.ts";
import { storedAgent } from "../../../src/extensions/subagent/sessions.ts";
import { worktreesCommand } from "../../../src/extensions/subagent/subagents-command.ts";
import { talkTo } from "../../../src/extensions/subagent/talk.ts";
import {
	ensureWorktree,
	planWorktree,
	removeWorktree,
	settleWorktree,
} from "../../../src/extensions/subagent/worktree.ts";
import { agentFile, happyLines, initRepo, loadTool, sandbox } from "../helpers.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function setup(fields = "") {
	const s = sandbox();
	initRepo(s.repo);
	s.write(join(s.home, ".claude/agents/x.md"), agentFile(`name: x\ndescription: d\n${fields}`));
	const repo = realpathSync(s.repo);
	const sessionFile = join(s.root, "sessions", "parent-id.jsonl");
	const metaOf = (id: string) =>
		JSON.parse(readFileSync(join(s.root, "sessions", "subagents", "parent-id", `${id}.json`), "utf8"));
	return { s, repo, sessionFile, metaOf, load: (cwd = s.repo) => loadTool({}, { cwd, sessionFile }) };
}

function fakeCtx(cwd: string, picks: (number | undefined)[], confirms: boolean[]) {
	const seen = { options: [] as string[][], confirms: 0, notes: [] as string[] };
	const ctx = {
		cwd,
		ui: {
			select: async (_t: string, options: string[]) => {
				seen.options.push(options);
				const i = picks.shift();
				return i === undefined ? undefined : options[i];
			},
			confirm: async () => (seen.confirms++, confirms.shift() ?? false),
			notify: (m: string) => void seen.notes.push(m),
		},
	};
	return { ctx: ctx as never, seen };
}

const waitRecord = async (root: string) => {
	for (let i = 0; i < 100 && !existsSync(root + "/record.json"); i++) await new Promise((r) => setTimeout(r, 50));
	await new Promise((r) => setTimeout(r, 200)); // the fake child writes its file when the prompt arrives
};

test("a changed worktree the user removed makes a resume throw naming the path; the meta says who removed it", async () => {
	const { s, repo, metaOf, load } = setup();
	const t = await load();
	s.scenario({ lines: happyLines(), writeFile: "out.txt" });
	const first = (await t.run({ subagent_type: "x", isolation: "worktree" })).structuredContent;
	const { ctx } = fakeCtx(repo, [0], [true]);
	await worktreesCommand(ctx);
	assert.equal(existsSync(first.worktree.path), false);
	assert.equal(metaOf(first.agentId).worktree.removed, "user");
	s.scenario({ lines: happyLines() });
	await assert.rejects(
		t.run({ resume: first.agentId, prompt: "more" }),
		(e: Error) => e.message.includes(first.worktree.path) && /removed/.test(e.message),
	);
	assert.equal(git(repo, "branch", "--list", "subagent/*"), "");
});

test("an aborted foreground call names the kept worktree in its error", async () => {
	const { s, load } = setup();
	s.scenario({ lines: happyLines(), hang: true, writeFile: "out.txt" });
	const t = await load();
	const controller = new AbortController();
	const run = t.run({ subagent_type: "x", isolation: "worktree" }, controller.signal);
	await waitRecord(s.root);
	controller.abort();
	await assert.rejects(
		run,
		(e: Error) =>
			/aborted/.test(e.message) && e.message.includes(".pi/worktrees/") && e.message.includes("subagent/"),
	);
});

test("/subagents worktrees: a running agent's worktree is shown as running and is not removed", async () => {
	const { s, repo, load } = setup();
	s.scenario({ lines: happyLines(), hang: true, writeFile: "out.txt" });
	const t = await load();
	const controller = new AbortController();
	const run = t.run({ subagent_type: "x", isolation: "worktree" }, controller.signal);
	await waitRecord(s.root);
	const { ctx, seen } = fakeCtx(repo, [0, undefined], [true]);
	await worktreesCommand(ctx);
	assert.match(seen.options[0][0], /running/);
	assert.equal(seen.confirms, 0, "no confirm for a running agent");
	assert.match(seen.notes.join("|"), /still running/);
	assert.match(git(repo, "worktree", "list", "--porcelain"), /\.pi\/worktrees/);
	controller.abort();
	await run.catch(() => {});
});

test("removeWorktree: a branch that is already gone is not an error", async () => {
	const { repo } = setup();
	const ref = await planWorktree(repo, "gone1");
	await ensureWorktree(ref);
	git(repo, "worktree", "remove", "--force", ref.path);
	git(repo, "branch", "-D", ref.branch);
	await removeWorktree(ref);
});

test("settle: a worktree whose path vanished is reported gone, not kept", async () => {
	const { repo } = setup();
	const ref = await planWorktree(repo, "vanish");
	await ensureWorktree(ref);
	rmSync(ref.path, { recursive: true });
	assert.deepEqual(await settleWorktree(ref), { changed: false, gone: true });
});

test("a throw between worktree creation and the child settles the worktree", async () => {
	const { s, repo, load } = setup();
	s.scenario({ lines: happyLines(), writeFile: "out.txt" });
	const t = await load();
	const begin = registry.begin;
	registry.begin = () => {
		throw new Error("registry exploded");
	};
	try {
		await assert.rejects(t.run({ subagent_type: "x", isolation: "worktree" }), /registry exploded/);
	} finally {
		registry.begin = begin;
	}
	assert.equal(existsSync(s.root + "/record.json"), false);
	assert.equal(git(repo, "branch", "--list", "subagent/*"), "");
	assert.equal(git(repo, "worktree", "list", "--porcelain").includes(".pi/worktrees"), false);
});

test(".worktreeinclude: a git check-ignore failure other than 'no match' is an error", async () => {
	const { s, repo } = setup();
	writeFileSync(join(repo, ".gitignore"), ".env\n");
	writeFileSync(join(repo, ".env"), "K=1\n");
	writeFileSync(join(repo, ".worktreeinclude"), ".env\n");
	const bin = join(s.root, "bin");
	mkdirSync(bin);
	const real = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
	writeFileSync(
		join(bin, "git"),
		`#!/bin/sh\nif [ "$1" = check-ignore ]; then echo "fatal: simulated failure" >&2; exit 128; fi\nexec ${real} "$@"\n`,
	);
	chmodSync(join(bin, "git"), 0o755);
	const ref = await planWorktree(repo, "inc1");
	const old = process.env.PATH;
	process.env.PATH = `${bin}:${old}`;
	try {
		await assert.rejects(ensureWorktree(ref), /simulated failure/);
	} finally {
		process.env.PATH = old;
	}
	assert.equal(existsSync(ref.path), false, "the half-made worktree is gone");
});

test("continuing from the subagent screen computes memory like the Agent tool: main checkout root and info/exclude", async () => {
	const { s, repo, sessionFile, load } = setup("memory: local");
	mkdirSync(join(repo, "sub"));
	const t = await load(join(repo, "sub"));
	s.scenario({ lines: happyLines("hi") });
	const first = (await t.run({ subagent_type: "x" })).structuredContent;
	const excludeFile = join(repo, ".git/info/exclude");
	writeFileSync(excludeFile, "");
	s.scenario({ lines: happyLines("hi") });
	const parent = { cwd: join(repo, "sub"), thinking: "off", trusted: false, sessionFile, sessionId: "parent-id" };
	await talkTo(parent, first.agentId, "more").done;
	const prompt = s.record().systemPromptTail!;
	assert.ok(prompt.includes(join(repo, ".claude/agent-memory-local/x")), prompt);
	assert.ok(!prompt.includes(join(repo, "sub", ".claude")), "not under the parent's subdirectory");
	assert.match(readFileSync(excludeFile, "utf8"), /agent-memory-local\/x/);
});

test("a resume id made only of dots is rejected", () => {
	const parent = { cwd: "/", thinking: "off", trusted: false, sessionFile: "/tmp/none/p.jsonl", sessionId: "p" };
	for (const id of ["..", ".", "..."]) assert.throws(() => storedAgent(parent, id), /invalid resume id/);
});
