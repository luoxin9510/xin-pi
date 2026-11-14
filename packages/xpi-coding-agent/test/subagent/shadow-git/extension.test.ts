// builtin:shadow-git in the primary workspace: what it registers, GIT_DIR for the children, the live session entry, a
// stopped import, the `/sg` commands and their refusals, and the bash block list. Real stores and workspaces in tmpdir
// with the plain adapter; no model.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { beginCodemodeScript } from "../../../src/extensions/codemode/scripts.ts";
import { builtInExtensions } from "../../../src/extensions/index.ts";
import { blockReason, compilePatterns } from "../../../src/extensions/shadow-git/guard.ts";
import { createShadowGitExtension, parseSgArgs } from "../../../src/extensions/shadow-git/index.ts";
import { scripts } from "../../../src/extensions/subagent/background.ts";
import { registry } from "../../../src/extensions/subagent/registry.ts";
import { fakeApi, fakeCtx, type Lab, lab, write } from "./lab.ts";

const here = dirname(fileURLToPath(import.meta.url));

async function started(l: Lab, cwd = l.ws) {
	const api = fakeApi();
	createShadowGitExtension()(api.pi);
	const c = fakeCtx(cwd);
	await api.emit("session_start", { type: "session_start", reason: "startup" }, c.ctx);
	const bash = (command: string) =>
		api.emit("tool_call", { type: "tool_call", toolName: "bash", input: { command } }, c.ctx);
	return { api, c, bash, sessions: join(l.store, "demo.sessions") };
}

test("outside a workspace the handlers are inert: no environment, no entry, no block, and /sg says so", async () => {
	const l = await lab();
	try {
		delete process.env.GIT_DIR;
		delete process.env.GIT_WORK_TREE;
		const { api, c, bash } = await started(l, l.root);
		assert.equal(process.env.GIT_DIR, undefined);
		assert.equal(process.env.GIT_WORK_TREE, undefined);
		assert.equal(existsSync(join(l.store, "demo.sessions")), false);
		assert.equal(await bash("xpi sg import"), undefined);
		const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
		await api.emit("before_agent_start", event, c.ctx);
		assert.deepEqual(event.systemPromptOptions.sections, {});
		await api.commands.sg.handler("status", c.ctx);
		assert.match(c.notes.at(-1)!.message, /not in a registered shadow-git workspace/);
	} finally {
		l.restore();
	}
});

test("the session's cwd decides, at each session start: leaving a workspace restores the environment, entering one sets it", async () => {
	const l = await lab();
	try {
		process.env.GIT_DIR = "/prior/dir.git";
		process.env.GIT_WORK_TREE = "/prior/tree";
		const entry = join(l.store, "demo.sessions", String(process.pid));
		// started in the workspace
		const first = await started(l);
		assert.equal(process.env.GIT_DIR, join(l.store, "demo.git"));
		assert.ok(existsSync(entry));
		assert.equal((await first.bash("xpi sg import")).block, true);
		// /resume of a session from another directory: the old runtime shuts down, a new one starts with that cwd
		await first.api.emit("session_shutdown", { type: "session_shutdown", reason: "resume" }, first.c.ctx);
		const away = await started(l, l.root);
		assert.equal(process.env.GIT_DIR, "/prior/dir.git", "git elsewhere no longer reaches the shadow repo");
		assert.equal(process.env.GIT_WORK_TREE, "/prior/tree");
		assert.equal(existsSync(entry), false, "the live entry moved away with the session");
		assert.equal(await away.bash("xpi sg import"), undefined, "no blocks outside a workspace");
		// and back into a workspace, from a runtime that started elsewhere
		await away.api.emit("session_start", { type: "session_start", reason: "resume" }, fakeCtx(l.ws).ctx);
		assert.equal(process.env.GIT_DIR, join(l.store, "demo.git"));
		assert.equal(process.env.GIT_WORK_TREE, l.ws);
		assert.ok(existsSync(entry), "the entry is written on entering");
		assert.equal((await away.bash("xpi sg import")).block, true, "the blocks apply");
		await away.api.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, away.c.ctx);
		assert.equal(process.env.GIT_DIR, "/prior/dir.git");
		assert.equal(existsSync(entry), false);
	} finally {
		l.restore();
	}
});

test("a session that starts elsewhere and is resumed into a workspace gets the environment, the entry and the blocks (reloaded runtime)", async () => {
	const l = await lab();
	try {
		await started(l, l.root);
		assert.equal(process.env.GIT_DIR, undefined);
		const next = await started(l); // the runtime rebuilt for the resumed session
		assert.equal(process.env.GIT_DIR, join(l.store, "demo.git"));
		assert.ok(existsSync(join(l.store, "demo.sessions", String(process.pid))));
		assert.equal((await next.bash("xpi sg merge x")).block, true);
	} finally {
		l.restore();
	}
});

test("in a workspace GIT_DIR and GIT_WORK_TREE reach bash, and git there is the shadow repo", async () => {
	const l = await lab();
	try {
		const { api } = await started(l);
		assert.ok(api.commands.sg);
		assert.equal(process.env.GIT_DIR, join(l.store, "demo.git"));
		assert.equal(process.env.GIT_WORK_TREE, l.ws);
		// what a bash child (or an MCP server, or a subagent) inherits
		const out = execFileSync("sh", ["-c", 'echo "$GIT_DIR"; git log --format=%s -n 1'], {
			cwd: join(l.ws, "src"),
			encoding: "utf8",
			env: process.env,
		});
		assert.equal(out, `${join(l.store, "demo.git")}\nsg: baseline\n`);
	} finally {
		l.restore();
	}
});

test("a top-level session writes <name>.sessions/<pid> and removes it at shutdown; a reload leaves one entry", async () => {
	const l = await lab();
	try {
		const first = await started(l);
		const entry = join(first.sessions, String(process.pid));
		assert.ok(existsSync(entry));
		await first.api.emit("session_shutdown", { type: "session_shutdown", reason: "reload" }, first.c.ctx);
		assert.equal(existsSync(entry), false);
		// /reload: a new runtime, the same process
		const second = await started(l);
		const third = await started(l);
		assert.deepEqual(readdirSync(first.sessions), [String(process.pid)]);
		await third.api.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, third.c.ctx);
		assert.deepEqual(readdirSync(first.sessions), []);
		// an entry that went missing is written again by the next turn
		await second.api.emit("before_agent_start", { systemPromptOptions: { sections: {} } }, second.c.ctx);
		assert.ok(existsSync(entry));
	} finally {
		l.restore();
	}
});

test("a process that exits without a shutdown event removes its entry", async () => {
	const l = await lab();
	try {
		const run = spawnSync(process.execPath, ["--experimental-strip-types", join(here, "exit-worker.ts"), l.ws], {
			encoding: "utf8",
			env: process.env,
		});
		assert.equal(run.status, 0, run.stderr);
		const entry = join(l.store, "demo.sessions", run.stdout.trim());
		assert.notEqual(run.stdout.trim(), "");
		assert.equal(existsSync(entry), false, "the exit hook removed it");
	} finally {
		l.restore();
	}
});

test("a subagent child (XPI_SUBAGENT_DEPTH) writes no entry and has no /sg, but gets the guard and the git environment", async () => {
	const l = await lab();
	try {
		process.env.XPI_SUBAGENT_DEPTH = "1";
		const { api, c, bash, sessions } = await started(l);
		assert.equal(existsSync(sessions), false);
		assert.equal(api.commands.sg, undefined);
		assert.equal(process.env.GIT_DIR, join(l.store, "demo.git"));
		assert.match((await bash("xpi sg import")).reason, /agents do not run "xpi sg import"/);
		await api.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, c.ctx);
	} finally {
		l.restore();
	}
});

test("a stopped import: an error notice, every tool call blocked with the way out, no live entry; settled, it works again", async () => {
	const l = await lab();
	try {
		const sha = l.git("rev-parse", "host").trim();
		writeFileSync(join(l.store, "demo.git", "SG_IMPORT"), `old ${sha}\n`);
		const { c, bash, api, sessions } = await started(l);
		assert.equal(c.notes.length, 1);
		assert.equal(c.notes[0].level, "error");
		assert.match(c.notes[0].message, /xpi sg import --abort/);
		await api.emit("before_agent_start", { systemPromptOptions: { sections: {} } }, c.ctx);
		assert.equal(existsSync(sessions), false, "a blocked session does not hold the workspace");
		for (const tool of ["bash", "read", "write", "Agent"]) {
			const result = await api.emit(
				"tool_call",
				{ type: "tool_call", toolName: tool, input: { command: "ls", path: "a.txt" } },
				c.ctx,
			);
			assert.equal(result.block, true, tool);
			assert.match(result.reason, /xpi sg import --abort/);
		}
		// the user aborts it in another terminal
		const aborted = await l.sg(["import", "--abort"]);
		assert.equal(aborted.code, 0, aborted.err);
		assert.equal(await bash("ls"), undefined);
		assert.ok(existsSync(join(sessions, String(process.pid))), "the entry is written once the import is settled");
	} finally {
		l.restore();
	}
});

test("bash: import, merge, export --apply, sbx create|rm, adapters and shadow.blockCommand are blocked with one line; the rest passes", async () => {
	const l = await lab();
	try {
		l.git("config", "--add", "shadow.blockCommand", "\\bhostvcs (submit|sync)\\b");
		l.git("config", "--add", "shadow.blockCommand", "(");
		const { bash, api, c } = await started(l);
		const blocked = [
			"xpi sg import",
			"xpi sg import --abort",
			"xpi sg --repo demo merge sbx/x",
			"xpi sg export --apply",
			"cd /tmp && xpi sg export --apply; echo done",
			"sg import",
			'bash -c "xpi sg sbx create x"',
			"xpi sg sbx rm x --force",
			"sg-adapter-plain update",
			"sh /x/adapters/sg-adapter-template checkin",
			"hostvcs submit -m x",
		];
		for (const command of blocked) {
			const result = await bash(command);
			assert.equal(result?.block, true, command);
			assert.ok(!result.reason.includes("\n"), `one line: ${command}`);
		}
		const passed = [
			"xpi sg status",
			"xpi sg export",
			"xpi sg sbx ls",
			"xpi sg sbx run x -- ls",
			"xpi sg diff host..main",
			"xpi sg commit -m 'import notes'",
			"git status",
			"hostvcs status",
			"echo sgx import",
		];
		for (const command of passed) assert.equal(await bash(command), undefined, command);
		// a command that runs another xpi sg: the inner one is seen too
		for (const command of [
			"xpi sg sbx run s -- xpi sg merge sbx/s",
			"xpi sg --repo demo sbx run s -- sh -c 'sg import'",
		]) {
			assert.equal((await bash(command))?.block, true, command);
		}
		// any tool with a shell command is held, not only bash
		const power = await api.emit(
			"tool_call",
			{ type: "tool_call", toolName: "powershell", input: { command: "xpi sg import" } },
			c.ctx,
		);
		assert.equal(power?.block, true);
	} finally {
		l.restore();
	}
});

test("blockReason names what was blocked; compilePatterns keeps the bad regex apart", () => {
	assert.match(blockReason("xpi sg export --apply", [])!, /"xpi sg export --apply"/);
	assert.match(blockReason("x", [/x/])!, /shadow\.blockCommand/);
	assert.deepEqual(compilePatterns(["a+", "("]).invalid, ["("]);
});

test("the prompt paragraph says who owns the workspace, never to call it, xpi sg export and xpi sg", async () => {
	const l = await lab();
	try {
		const { api, c } = await started(l);
		const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
		await api.emit("before_agent_start", event, c.ctx);
		const text = event.systemPromptOptions.sections["shadow-git"];
		assert.match(text, /host version control system owns the workspace/);
		assert.match(text, /Never call the host VCS to write/);
		assert.match(text, /`xpi sg export` shows the user what is pending/);
		assert.match(text, /never bare `sg`/);
	} finally {
		l.restore();
	}
});

test("parseSgArgs accepts the documented forms only", () => {
	assert.deepEqual(parseSgArgs("import"), { args: ["import"], writes: true });
	assert.deepEqual(parseSgArgs("export"), { args: ["export"], writes: false });
	assert.deepEqual(parseSgArgs("export --apply"), { args: ["export", "--apply"], writes: true });
	assert.deepEqual(parseSgArgs("merge sbx/x"), { args: ["merge", "sbx/x"], writes: true });
	assert.deepEqual(parseSgArgs("merge --abort"), { args: ["merge", "--abort"], writes: true });
	assert.deepEqual(parseSgArgs("sbx ls"), { args: ["sbx", "ls"], writes: false });
	for (const bad of [
		"",
		"sbx create x",
		"sbx",
		"export --force",
		"import --abort --abort",
		"merge",
		"merge -x",
		"status x",
		"config a b",
	]) {
		assert.equal(typeof parseSgArgs(bad), "string", bad);
	}
});

test("/sg: status, a host import, the plan, a merge and the sandbox list run the core in process and print its output", async () => {
	const l = await lab();
	try {
		const { api, c } = await started(l);
		const sg = async (args: string) => {
			c.notes.length = 0;
			await api.commands.sg.handler(args, c.ctx);
			return c.notes.map((note) => `${note.level}: ${note.message}`).join("\n");
		};
		assert.match(await sg("status"), /^info: .*main/s);
		assert.match(await sg("bogus"), /^warning: usage: \/sg import/);

		l.hostCommit({ "new.txt": "n\n" });
		const imported = await sg("import");
		assert.match(imported, /^info: /);
		assert.equal(readFileSync(join(l.ws, "new.txt"), "utf8"), "n\n");
		assert.match(l.git("log", "--format=%s", "host"), /sg: import/);

		write(l.ws, "a.txt", "changed\n");
		l.git("add", "-A");
		l.git("commit", "-q", "-m", "change a");
		const plan = await sg("export");
		assert.match(plan, /^info: /s);
		assert.match(plan, /a\.txt/);
		assert.match(plan, /change a/);

		await l.sg(["sbx", "create", "w1"]);
		assert.match(await sg("sbx ls"), /w1 {2}sbx\/w1 {2}0 commit\(s\) ahead of main/);
		const tree = join(l.store, "demo.sbx", "w1", "tree");
		write(tree, "w1.txt", "from the sandbox\n");
		execFileSync("git", ["add", "w1.txt"], {
			cwd: tree,
			env: { ...process.env, GIT_DIR: join(l.store, "demo.git", "worktrees", "w1"), GIT_WORK_TREE: tree },
		});
		execFileSync("git", ["commit", "-q", "-m", "work in w1"], {
			cwd: tree,
			env: { ...process.env, GIT_DIR: join(l.store, "demo.git", "worktrees", "w1"), GIT_WORK_TREE: tree },
		});
		const merged = await sg("merge sbx/w1");
		assert.match(merged, /^info: /);
		assert.equal(readFileSync(join(l.ws, "w1.txt"), "utf8"), "from the sandbox\n");
	} finally {
		l.restore();
	}
});

test("/sg import, export --apply and merge are refused while the main agent works, an agent without a sandbox runs, or another session is live; reading commands still run", async () => {
	const l = await lab();
	try {
		const { api, c, sessions } = await started(l);
		const sg = async (args: string) => {
			c.notes.length = 0;
			await api.commands.sg.handler(args, c.ctx);
			return c.notes.map((note) => `${note.level}: ${note.message}`).join("\n");
		};
		l.hostCommit({ "new.txt": "n\n" });

		c.state.idle = false;
		assert.match(await sg("import"), /^error: sg: import needs the workspace to itself: the main agent is working/);
		assert.match(await sg("export --apply"), /^error: .*main agent is working/);
		assert.match(await sg("merge sbx/x"), /^error: .*main agent is working/);
		assert.match(await sg("status"), /^info: /, "reading is always allowed");
		assert.match(await sg("export"), /^info: /);
		c.state.idle = true;

		const parent = { cwd: l.ws, thinking: "off", trusted: true, sessionId: "s1" };
		const start = { id: "agent-a", type: "general-purpose", description: "d", model: "m", thinking: "off" };
		registry.begin(parent as any, { ...start, name: "worker" });
		assert.match(
			await sg("import"),
			/^error: .*1 agent\(s\) of this session are working in the workspace without a sandbox \(worker\)/,
		);
		registry.finish("agent-a", "completed");
		// a background codemode script of the session may run agents that write the primary
		const off = scripts.connect({
			sessionId: () => "s1",
			enabled: () => true,
			deliver: () => {},
			parent: () => ({ sessionFile: undefined, sessionId: "s1" }),
		});
		const script = beginCodemodeScript("cm-busy", "s1", undefined);
		assert.match(await sg("import"), /^error: .*1 background script\(s\) of this session are running/);
		script.end({ result: { content: [{ type: "text", text: "x" }], details: undefined } });
		off();
		// a sandboxed agent does not write the primary
		registry.begin(parent as any, {
			...start,
			id: "agent-b",
			worktree: { kind: "shadow-git", root: l.ws, path: "/x", branch: "sbx/x", base: "b" },
		});
		assert.match(await sg("import"), /^info: /, "an agent in a sandbox does not count");
		registry.finish("agent-b", "completed");

		// another live session (this test's parent process stands in for it)
		l.hostCommit({ "other.txt": "o\n" });
		mkdirSync(sessions, { recursive: true });
		writeFileSync(join(sessions, String(process.ppid)), "");
		const refused = await sg("import");
		assert.match(refused, /^error: .*no other xpi session in .*live: pid \d+/s);
		assert.equal(existsSync(join(l.ws, "other.txt")), false, "nothing was imported");
		assert.match(await sg("status"), /^info: /);
	} finally {
		l.restore();
	}
});

test("shadow-git loads first, so the session_start of later built-ins (mcp, codemode, subagent) already sees GIT_DIR", async () => {
	const names = builtInExtensions.map((extension) => (typeof extension === "function" ? "" : extension.name));
	assert.equal(names[0], "shadow-git");
	for (const later of ["mcp", "codemode", "tool-search", "subagent", "roost"]) {
		assert.ok(names.indexOf(later) > names.indexOf("shadow-git"), later);
	}
	const l = await lab();
	try {
		const api = fakeApi();
		const seen: (string | undefined)[] = [];
		const shadow = builtInExtensions[0];
		assert.ok(typeof shadow !== "function");
		await shadow.factory(api.pi);
		api.pi.on("session_start", () => seen.push(process.env.GIT_DIR)); // what a later extension's start does
		await api.emit("session_start", { type: "session_start", reason: "startup" }, fakeCtx(l.ws).ctx);
		assert.deepEqual(seen, [join(l.store, "demo.git")]);
	} finally {
		l.restore();
	}
});
