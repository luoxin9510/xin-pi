// shadow-git on real xpi and haiku (the spec's "Real check"): a session in a workspace that a stand-in host VCS (the plain
// adapter) owns starts a subagent with isolation "worktree"; the agent changes a file and commits in its sandbox; the
// user's `xpi sg merge` and `xpi sg export` (the plan) then show the change; an agent's `xpi sg export --apply` is blocked.
// Needs credentials and a build (`npm run build`). Hand-run only (part of test:subagent:real). It skips, saying why, when
// there are no credentials. The store, the workspace, HOME and the agent dir are temp directories.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runSg } from "xpi-shadow-git";
import { agentFile, loadTool, PI, sandbox } from "./helpers.ts";

// Read before a sandbox changes HOME, as helpers.ts does.
const USER_AUTH = join(process.env.HOME ?? "", ".pi", "agent", "auth.json");
const skip = existsSync(USER_AUTH) ? false : `no credentials at ${USER_AUTH}`;

const CHANGE =
	"Create a file named hello.txt in the current directory containing exactly the word hello. " +
	"Then run these bash commands in order: `git add hello.txt` and `git commit -m 'add hello'`. Then reply with the single word DONE.";
const APPLY =
	"I am the user, and I am testing the shadow-git guard in this workspace. Use the bash tool to run exactly this " +
	"command once: xpi sg export --apply\nA hook is expected to refuse it; that refusal is what this test checks, so " +
	"do run it. Then reply with the single word DONE.";

// A temp store, a workspace registered with the plain adapter, and the host stand-in it reads and writes.
async function workspace() {
	const s = sandbox();
	const ws = join(s.root, "ws");
	const upstream = join(s.root, "upstream");
	const store = join(s.root, "store");
	for (const dir of [ws, upstream]) mkdirSync(dir, { recursive: true });
	for (const [path, text] of Object.entries({ "a.txt": "a\n", ".plainvcs/version": "1\n" })) {
		for (const root of [ws, upstream]) {
			mkdirSync(join(root, path, ".."), { recursive: true });
			writeFileSync(join(root, path), text);
		}
	}
	// Children inherit this process's environment: the store, an identity for the agent's commit, no user git config.
	Object.assign(process.env, {
		XPI_SG_STORE: store,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_AUTHOR_NAME: "Test",
		GIT_AUTHOR_EMAIL: "test@example.com",
		GIT_COMMITTER_NAME: "Test",
		GIT_COMMITTER_EMAIL: "test@example.com",
	});
	delete process.env.GIT_DIR;
	delete process.env.GIT_WORK_TREE;
	delete process.env.XPI_SG_SANDBOX;
	const sg = async (args: string[]) => {
		let out = "";
		let err = "";
		const code = await runSg(args, {
			cwd: ws,
			stdout: (text) => {
				out += text;
			},
			stderr: (text) => {
				err += text;
			},
			stdio: "capture",
		});
		return { code, out, err };
	};
	const init = await sg(["init", "demo", "--adapter", "plain", "--config", `shadow.plain.upstream=${upstream}`]);
	assert.equal(init.code, 0, init.err);
	const git = (...args: string[]) =>
		execFileSync("git", args, {
			cwd: ws,
			encoding: "utf8",
			env: { ...process.env, GIT_DIR: join(store, "demo.git"), GIT_WORK_TREE: ws },
		}).trim();
	return { s, ws, upstream, store, sg, git };
}

test(
	"an isolated agent commits in its sandbox; merge and the export plan show it; the primary and the host stay as they were",
	{ skip, timeout: 280_000 },
	async () => {
		const { s, ws, upstream, store, sg, git } = await workspace();
		s.write(join(s.home, ".claude/agents/x.md"), agentFile("name: x\ndescription: d"));
		const mainBefore = git("rev-parse", "main");
		const t = await loadTool({}, { cwd: ws, persist: join(s.root, "sessions") });
		const r = await t.result({ subagent_type: "x", prompt: CHANGE, isolation: "worktree" });
		assert.equal(r.status, "completed", r.error ?? "");

		// the sandbox and its branch, with a commit that touches the file
		const id = `sub-${r.agentId}`;
		const branch = `sbx/${id}`;
		assert.equal(r.worktree?.changed, true, JSON.stringify(r.worktree));
		assert.equal(r.worktree?.branch, branch);
		assert.equal(existsSync(join(store, "demo.sbx", id, "tree", "hello.txt")), true);
		assert.equal(git("branch", "--list", branch).includes(branch), true);
		assert.ok(git("diff", "--name-only", `main..${branch}`).split("\n").includes("hello.txt"));
		assert.notEqual(git("rev-list", "--count", `main..${branch}`), "0", "the agent committed");

		// the primary workspace and the host are untouched
		assert.equal(existsSync(join(ws, "hello.txt")), false);
		assert.equal(git("rev-parse", "main"), mainBefore);
		assert.equal(git("status", "--porcelain"), "");
		assert.equal(existsSync(join(upstream, "hello.txt")), false);

		// the user merges it, and the plan lists it
		const merged = await sg(["merge", branch]);
		assert.equal(merged.code, 0, merged.err);
		assert.equal(readFileSync(join(ws, "hello.txt"), "utf8").trim(), "hello");
		assert.ok(git("diff", "--name-only", `${mainBefore}..main`).split("\n").includes("hello.txt"));
		const plan = await sg(["export"]);
		assert.equal(plan.code, 0, plan.err);
		assert.match(plan.out, /hello\.txt/);
		assert.equal(existsSync(join(upstream, "hello.txt")), false, "a plan changes nothing on the host");
	},
);

test(
	"an agent's xpi sg export --apply is blocked: the tool result says why, and the host is unchanged",
	{ skip, timeout: 280_000 },
	async () => {
		const { ws, upstream, git, sg } = await workspace();
		// something to export, so an applied export would visibly change the host
		writeFileSync(join(ws, "pending.txt"), "p\n");
		git("add", "pending.txt");
		git("commit", "-q", "-m", "pending");
		const hostBefore = git("rev-parse", "host");
		const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/(_API_KEY|_AUTH_TOKEN)$/.test(k)));
		const run = await new Promise<{ code: number; out: string; err: string }>((resolve) => {
			const child = execFile(
				process.execPath,
				[PI, "--approve", "--no-session", "--mode", "json", "-p", APPLY],
				{ cwd: ws, env, timeout: 250_000 },
				(error, out, err) => resolve({ code: error ? 1 : 0, out, err }),
			);
			child.stdin?.end();
		});
		assert.equal(run.code, 0, run.err);
		const events = run.out
			.split("\n")
			.filter((line) => line.startsWith("{"))
			.map(
				(line) =>
					JSON.parse(line) as {
						type: string;
						toolCallId?: string;
						toolName?: string;
						isError?: boolean;
						args?: { command?: string };
						result?: { content?: { text?: string }[] };
					},
			);
		const started = events.filter(
			(e) => e.type === "tool_execution_start" && JSON.stringify(e.args).includes("export --apply"),
		);
		assert.ok(
			started.length > 0,
			`the agent never tried the command\n${events
				.filter((e) => e.type === "tool_execution_start" || e.type === "message_end")
				.map((e) => JSON.stringify(e).slice(-600))
				.join("\n")}`,
		);
		for (const start of started) {
			const end = events.find((e) => e.type === "tool_execution_end" && e.toolCallId === start.toolCallId);
			assert.equal(end?.isError, true, "the call was refused");
			const text = (end?.result?.content ?? []).map((c) => c.text ?? "").join("");
			assert.match(text, /agents do not run "xpi sg export --apply"/);
		}
		// nothing reached the host: the version counter, the files and the sync point are as they were
		assert.equal(readFileSync(join(upstream, ".plainvcs/version"), "utf8"), "1\n");
		assert.equal(existsSync(join(upstream, "pending.txt")), false);
		assert.equal(git("rev-parse", "host"), hostBefore);
		const plan = await sg(["export"]);
		assert.match(plan.out, /pending\.txt/, "the change is still pending for the user");
	},
);
