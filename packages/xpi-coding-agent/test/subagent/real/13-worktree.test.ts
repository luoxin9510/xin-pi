// Worktree isolation on real pi and haiku (v3b ticket 01): an isolated agent that writes a file leaves a kept worktree and
// an untouched main checkout; one that only reads leaves nothing; a stopped run follows the same rule.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { registry } from "../../../src/extensions/subagent/registry.ts";
import { initRepo } from "../helpers.ts";
import { agentFile, loadTool, sandbox } from "./helpers.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const WRITE =
	"Create a file named x.txt in the current directory containing exactly the word hello. Then reply with the single word DONE.";
const READ =
	"Read the file a.txt in the current directory, then reply with the single word DONE. Do not change anything.";

// A sandbox whose repo is a real repository; the agent file lives in HOME so the checkout stays clean.
function setup(fields: string) {
	const s = sandbox();
	initRepo(s.repo);
	s.write(join(s.home, ".claude/agents/x.md"), agentFile(`name: x\ndescription: d\n${fields}`));
	return { s, repo: realpathSync(s.repo) };
}

test("an isolated agent that writes a file: worktree kept with the right fields, main checkout untouched", async () => {
	const { s, repo } = setup("isolation: worktree");
	const t = await loadTool({}, { cwd: s.repo, persist: join(s.root, "sessions") });
	const r = await t.result({ subagent_type: "x", prompt: WRITE });
	assert.equal(r.status, "completed", r.error ?? "");
	const path = join(repo, ".pi/worktrees", r.agentId);
	assert.deepEqual(r.worktree, {
		changed: true,
		path,
		branch: `subagent/${r.agentId}`,
		files: ["x.txt"],
		commits: [],
	});
	assert.equal(readFileSync(join(path, "x.txt"), "utf8").trim(), "hello");
	assert.equal(existsSync(join(repo, "x.txt")), false, "the main checkout has no such file");
	assert.equal(git(repo, "status", "--porcelain"), "");
	assert.equal(git(repo, "branch", "--list", `subagent/${r.agentId}`).includes(r.agentId), true);
	assert.equal(registry.get(r.agentId)!.worktree!.path, path);
});

test("an isolated read-only agent leaves nothing behind", async () => {
	const { s, repo } = setup("tools: Read");
	const t = await loadTool({}, { cwd: s.repo });
	const r = await t.result({ subagent_type: "x", prompt: READ, isolation: "worktree" });
	assert.equal(r.status, "completed", r.error ?? "");
	assert.deepEqual(r.worktree, { changed: false });
	assert.equal(git(repo, "worktree", "list", "--porcelain").includes(".pi/worktrees"), false);
	assert.equal(git(repo, "branch", "--list", "subagent/*"), "");
	assert.equal(existsSync(join(repo, ".pi/worktrees", r.agentId)), false);
});

test("a stopped isolated run follows the same rule: changed is kept, unchanged is removed", async () => {
	for (const changed of [false, true]) {
		const { s, repo } = setup("");
		const t = await loadTool({}, { cwd: s.repo, persist: join(s.root, "sessions") });
		const prompt = `${changed ? "Create a file named x.txt containing hello, then " : ""}run the bash command 'sleep 60' with the codemode tool, then reply DONE.`;
		const run = t.result({ subagent_type: "x", prompt, isolation: "worktree" });
		const waitFor = async (what: string, ok: () => boolean) => {
			for (let i = 0; !ok(); i++) {
				if (i > 1200) throw new Error(`timed out waiting for ${what}`);
				await new Promise((r) => setTimeout(r, 50));
			}
		};
		await waitFor("the child to run its sleep", () => {
			const rec = registry.list(t.sessionId)[0];
			return (
				rec?.lastTool !== undefined &&
				registry.handle(rec.id) !== undefined &&
				(!changed || existsSync(join(repo, ".pi/worktrees", rec.id, "x.txt")))
			);
		});
		const id = registry.list(t.sessionId)[0]!.id;
		registry.stop(id);
		const r = await run;
		assert.equal(r.status, "failed");
		assert.equal(r.error, "stopped by user");
		if (changed) {
			assert.equal(r.worktree?.changed, true);
			assert.deepEqual(r.worktree?.files, ["x.txt"]);
			assert.equal(existsSync(join(repo, ".pi/worktrees", id)), true);
		} else {
			assert.deepEqual(r.worktree, { changed: false });
			assert.equal(existsSync(join(repo, ".pi/worktrees", id)), false);
			assert.equal(git(repo, "branch", "--list", "subagent/*"), "");
		}
	}
});

test("resume runs in the same worktree: the file written before is read back and a second is added; the unchanged case recreates it", async () => {
	const { s, repo } = setup("isolation: worktree");
	const t = await loadTool({}, { cwd: s.repo, persist: join(s.root, "sessions") });
	const first = await t.result({ subagent_type: "x", prompt: WRITE });
	assert.equal(first.status, "completed", first.error ?? "");
	const path = join(repo, ".pi/worktrees", first.agentId);
	const second = await t.result({
		resume: first.agentId,
		isolation: "worktree",
		prompt:
			"Read the file x.txt in the current directory. Then create a file y.txt in the current directory containing exactly the contents of x.txt. Then reply with the single word DONE.",
	});
	assert.equal(second.status, "completed", second.error ?? "");
	assert.equal(readFileSync(join(path, "y.txt"), "utf8").trim(), "hello");
	assert.deepEqual([...(second.worktree?.files ?? [])].sort(), ["x.txt", "y.txt"]);
	assert.equal(existsSync(join(repo, "y.txt")), false);

	// an agent that changed nothing has no worktree after its run; a resume recreates it at the same path and branch
	const idle = await t.result({
		subagent_type: "x",
		prompt: "Reply with the single word OK. Do not call any tool.",
		isolation: "worktree",
	});
	const idlePath = join(repo, ".pi/worktrees", idle.agentId);
	assert.equal(existsSync(idlePath), false);
	const back = await t.result({
		resume: idle.agentId,
		prompt: "Run `pwd` in bash and reply with its output only.",
		isolation: "worktree",
	});
	assert.equal(back.status, "completed", back.error ?? "");
	assert.match(back.output, new RegExp(idle.agentId));
	assert.ok(
		back.warnings.some((w: string) => w.includes("isolation")),
		"isolation on a resume is ignored with a warning",
	);
});
