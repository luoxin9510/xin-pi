// Ticket 02: load Claude Code agent files. Discovery tests need no child; the ones that show what a child received
// read it from the session pi wrote.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { agentFile, childSetup, loadTool, REPLY_OK, sandbox } from "./helpers.ts";

const def = (name: string, desc: string, body = `Prompt of ${name} (${desc}).`) =>
	agentFile(`name: ${name}\ndescription: ${desc}`, body);

test("precedence across the five sources, closest project dir first, recursive scan", async () => {
	const s = sandbox();
	const sub = join(s.repo, "pkg", "app");
	mkdirSync(sub, { recursive: true });
	s.write(join(sub, ".pi/agents/a.md"), def("a", "sub-pi"));
	s.write(join(s.repo, ".pi/agents/a.md"), def("a", "root-pi"));
	s.write(join(sub, ".claude/agents/a.md"), def("a", "sub-claude"));
	s.write(join(s.home, ".pi/agent/agents/a.md"), def("a", "home-pi"));
	s.write(join(s.home, ".claude/agents/a.md"), def("a", "home-claude"));
	s.write(join(s.repo, ".claude/agents/nested/deep/b.md"), def("b", "root-claude"));
	s.write(join(s.home, ".pi/agent/agents/b.md"), def("b", "home-pi"));
	s.write(join(s.home, ".pi/agent/agents/c.md"), def("c", "home-pi"));
	s.write(join(s.home, ".claude/agents/c.md"), def("c", "home-claude"));
	s.write(join(s.home, ".claude/agents/d.md"), def("d", "home-claude"));
	s.write(join(s.home, ".claude/agents/Explore.md"), def("Explore", "mine"));
	s.write(join(s.root, ".pi/agents/outside.md"), def("outside", "beyond the repo root"));
	const t = await loadTool({}, { cwd: sub, persist: join(s.root, "sessions") });

	const want: Record<string, string> = {
		a: "Prompt of a (sub-pi).",
		b: "Prompt of b (root-claude).",
		c: "Prompt of c (home-pi).",
		d: "Prompt of d (home-claude).",
		Explore: "Prompt of Explore (mine).", // a user file overrides a built-in
	};
	const names = [...Object.keys(want), "Plan"];
	const results = await Promise.all(names.map((n) => t.result({ subagent_type: n, prompt: REPLY_OK })));
	results.forEach((r, i) => {
		assert.equal(r.status, "completed", `${names[i]}: ${r.error}`);
		const prompt = childSetup(t.sessionDir!, r.agentId).prompt;
		if (want[names[i]!]) assert.ok(prompt.startsWith(want[names[i]!]!), `${names[i]}: ${prompt.slice(0, 80)}`);
		else assert.match(prompt, /software architect/, "built-in Plan");
	});
	await assert.rejects(
		t.run({ subagent_type: "outside" }),
		/unknown subagent_type "outside"\. Available: .*general-purpose/,
	);

	assert.match(t.tool.description, /- a: sub-pi\n/);
	assert.match(t.tool.description, /- Plan: Read-only architect/);
});

test("without a repo only cwd is scanned", async () => {
	const s = sandbox();
	const dir = join(s.root, "plain", "child");
	mkdirSync(dir, { recursive: true });
	s.write(join(s.root, "plain/.claude/agents/up.md"), def("up", "parent dir"));
	s.write(join(dir, ".claude/agents/here.md"), def("here", "cwd"));
	const t = await loadTool({}, { cwd: dir });
	assert.match(t.tool.description, /- here: cwd/);
	assert.doesNotMatch(t.tool.description, /- up:/);
});

test("definitions are re-read on every call", async () => {
	const s = sandbox();
	const t = await loadTool({}, { cwd: s.repo, persist: join(s.root, "sessions") });
	s.write(join(s.repo, ".pi/agents/late.md"), def("late", "added after session start", "Version 1."));
	const one = await t.result({ subagent_type: "late", prompt: REPLY_OK });
	assert.ok(childSetup(t.sessionDir!, one.agentId).prompt.startsWith("Version 1."));
	s.write(join(s.repo, ".pi/agents/late.md"), def("late", "edited", "Version 2."));
	const two = await t.result({ subagent_type: "late", prompt: REPLY_OK });
	assert.ok(childSetup(t.sessionDir!, two.agentId).prompt.startsWith("Version 2."));
});

test("every skip reason is reported at session start, naming the file", async () => {
	const s = sandbox();
	const bad: [string, string, RegExp][] = [
		["nofm", "no frontmatter\n---\nname: x\n---", /does not start with --- frontmatter/],
		["unclosed", "---\nname: x\ndescription: d\n", /frontmatter is not closed/],
		["yaml", "---\nname: [x\ndescription: d\n---\n", /invalid YAML/],
		["noname", "---\ndescription: d\n---\n", /missing "name"/],
		["numname", "---\nname: 5\ndescription: d\n---\n", /"name" must be a string/],
		["longname", `---\nname: ${"a".repeat(257)}\ndescription: d\n---\n`, /1-256 characters/],
		["colon", '---\nname: "a:b"\ndescription: d\n---\n', /must not contain ":"/],
		["dash", '---\nname: "-a"\ndescription: d\n---\n', /must not start with "-"/],
		["nodesc", "---\nname: a\n---\n", /missing "description"/],
		["turns", "---\nname: a\ndescription: d\nmaxTurns: ten\n---\n", /"maxTurns" must be a positive integer/],
		["effort", "---\nname: a\ndescription: d\neffort: huge\n---\n", /"effort" must be low/],
		["tools", "---\nname: a\ndescription: d\ntools: 3\n---\n", /"tools" must be/],
		["omit", "---\nname: a\ndescription: d\nomitClaudeMd: maybe\n---\n", /"omitClaudeMd" must be true or false/],
		["codemode", "---\nname: a\ndescription: d\ncodemode: no\n---\n", /"codemode" must be true or false/],
		["model", "---\nname: a\ndescription: d\nmodel: 7\n---\n", /"model" must be a string/],
		["skills", "---\nname: a\ndescription: d\nskills: {x: 1}\n---\n", /"skills" must be/],
	];
	for (const [file, text] of bad) s.write(join(s.repo, `.pi/agents/${file}.md`), text);
	const t = await loadTool({}, { cwd: s.repo });
	for (const [file, , reason] of bad) {
		const note = t.notes.find((n) => n.includes(`${file}.md:`));
		assert.ok(note, `no warning for ${file}`);
		assert.match(note, /^subagent: skipped agent file /);
		assert.match(note, reason, file);
	}
	assert.doesNotMatch(t.tool.description, /- a:/);
});

test("unsupported Claude Code fields warn; unknown keys are ignored; same-folder duplicates warn", async () => {
	const s = sandbox();
	s.write(
		join(s.repo, ".pi/agents/inert.md"),
		agentFile("name: inert\ndescription: d\npermissionMode: plan\nhooks: {}\ncolor: mauve\nwhatever: 1"),
	);
	s.write(join(s.home, ".claude/agents/x1.md"), def("dup", "first"));
	s.write(join(s.home, ".claude/agents/x2.md"), def("dup", "second"));
	const t = await loadTool({}, { cwd: s.repo });
	assert.ok(
		t.notes.includes(
			'subagent: inert: field "permissionMode" has no effect in subagent: xpi has no permission modes',
		),
	);
	assert.equal(t.notes.filter((n) => n.includes("unknown color")).length, 1, "an unknown colour warns once");
	assert.ok(!t.notes.some((n) => n.includes('"color" has no effect')));
	assert.ok(
		t.notes.includes(
			'subagent: inert: field "hooks" has no effect in subagent: xpi has no hooks; extensions do that work',
		),
	);
	assert.ok(!t.notes.some((n) => n.includes("whatever")));
	assert.ok(t.notes.some((n) => /dup" is defined twice: .*x1\.md wins over .*x2\.md/.test(n)));
	assert.match(t.tool.description, /- dup: first/);
	const r = await t.result({ subagent_type: "inert", prompt: REPLY_OK });
	assert.equal(r.status, "completed", r.error ?? "");
	assert.deepEqual(r.warnings, [
		'field "permissionMode" has no effect in subagent: xpi has no permission modes',
		'field "hooks" has no effect in subagent: xpi has no hooks; extensions do that work',
	]);
});

test("every supported field of a Claude Code file reaches the child; comma and list tools both work", async () => {
	const s = sandbox();
	s.write(
		join(s.repo, ".claude/agents/full.md"),
		agentFile(
			[
				"name: full",
				"description: All fields",
				"tools: Read, Grep,Glob",
				"disallowedTools:",
				"  - Grep",
				"model: haiku",
				"effort: high",
				"omitClaudeMd: true",
			].join("\n"),
			"\nBody line 1\nBody line 2\n",
		),
	);
	s.write(
		join(s.repo, ".claude/agents/listed.md"),
		agentFile("name: listed\ndescription: d\ntools:\n  - Read\n  - Bash"),
	);
	s.write(join(s.repo, "AGENTS.md"), "Project context file.\n");
	const t = await loadTool({}, { cwd: s.repo, persist: join(s.root, "sessions") });
	const [full, listed] = await Promise.all([
		t.result({ subagent_type: "full", prompt: REPLY_OK }),
		t.result({ subagent_type: "listed", prompt: REPLY_OK }),
	]);
	assert.equal(full.status, "completed", full.error ?? "");
	const f = childSetup(t.sessionDir!, full.agentId);
	assert.deepEqual(f.tools, ["codemode", "find", "read"], "tools list minus disallowedTools");
	assert.equal(f.model, "anthropic/claude-haiku-5-5");
	assert.equal(f.thinking, "high");
	assert.equal(f.hasContextFiles, false, "omitClaudeMd");
	assert.match(f.prompt, /^Body line 1\nBody line 2\n\n# Environment/);
	assert.equal(listed.status, "completed", listed.error ?? "");
	const l = childSetup(t.sessionDir!, listed.agentId);
	assert.deepEqual(l.tools, ["bash", "codemode", "read"]);
	assert.equal(l.hasContextFiles, true, "context files are kept by default");
});

test("the code-reviewer example from the Claude Code docs loads unchanged", async () => {
	const s = sandbox();
	s.write(
		join(s.repo, ".claude/agents/code-reviewer.md"),
		`---
name: code-reviewer
description: Expert code review specialist. Proactively reviews code for quality, security, and maintainability. Use immediately after writing or modifying code.
tools: Read, Grep, Glob, Bash
model: inherit
---

You are a senior code reviewer ensuring high standards of code quality and security.

When invoked:
1. Run git diff to see recent changes
2. Focus on modified files
3. Begin review immediately
`,
	);
	const t = await loadTool({}, { cwd: s.repo, persist: join(s.root, "sessions") });
	assert.deepEqual(t.notes, []);
	const r = await t.result({ subagent_type: "code-reviewer", prompt: REPLY_OK });
	assert.equal(r.status, "completed", r.error ?? "");
	assert.deepEqual(r.warnings, []);
	const c = childSetup(t.sessionDir!, r.agentId);
	assert.deepEqual(c.tools, ["bash", "codemode", "find", "grep", "read"]);
	assert.match(c.prompt, /^You are a senior code reviewer/);
});

test("an unreadable directory inside an agents folder is skipped with a warning", async () => {
	const s = sandbox();
	s.write(join(s.repo, ".pi/agents/ok.md"), def("ok", "readable"));
	const locked = join(s.repo, ".pi/agents/locked");
	s.write(join(locked, "hidden.md"), def("hidden", "unreachable"));
	chmodSync(locked, 0o000);
	try {
		const notes: string[] = [];
		const t = await loadTool({}, { cwd: s.repo, notes });
		assert.match(t.tool.description, /- ok: readable/);
		assert.doesNotMatch(t.tool.description, /- hidden:/);
		assert.ok(
			notes.some((n) => n.includes(`cannot read agent directory ${locked}: EACCES`)),
			notes.join("\n"),
		);
	} finally {
		chmodSync(locked, 0o755);
	}
});

test("symlinked subdirectories of an agents folder are followed; a symlink loop is harmless", async () => {
	const s = sandbox();
	s.write(join(s.root, "shared/linked.md"), def("linked", "from a symlinked dir"));
	const agents = join(s.repo, ".claude/agents");
	mkdirSync(agents, { recursive: true });
	symlinkSync(join(s.root, "shared"), join(agents, "team"));
	symlinkSync(agents, join(agents, "loop"));
	s.write(join(agents, "plain.md"), def("plain", "regular"));
	const notes: string[] = [];
	const t = await loadTool({}, { cwd: s.repo, notes });
	assert.match(t.tool.description, /- linked: from a symlinked dir/);
	assert.match(t.tool.description, /- plain: regular/);
	assert.deepEqual(notes, []);
});

test("a project agent overriding a built-in warns; a user-dir override does not", async () => {
	const s = sandbox();
	s.write(join(s.repo, ".claude/agents/Explore.md"), def("Explore", "project explore"));
	s.write(join(s.home, ".claude/agents/Plan.md"), def("Plan", "user plan"));
	const notes: string[] = [];
	const t = await loadTool({}, { cwd: s.repo, notes });
	assert.match(t.tool.description, /- Explore: project explore/);
	const path = join(s.repo, ".claude/agents/Explore.md");
	assert.ok(notes.includes(`subagent: project agent "Explore" overrides the built-in (${path})`), notes.join("\n"));
	assert.equal(notes.filter((n) => /overrides the built-in/.test(n)).length, 1);
});

test("a self-referencing symlink in an agents folder warns and the other agents still load", async () => {
	const s = sandbox();
	const agents = join(s.repo, ".claude/agents");
	s.write(join(agents, "ok.md"), def("ok", "fine"));
	symlinkSync("loop", join(agents, "loop"));
	const t = await loadTool({}, { cwd: s.repo });
	assert.ok(t.registered);
	assert.match(t.tool.description, /- ok: fine/);
	assert.ok(
		t.notes.some((n) => n.includes("loop")),
		`no warning naming the loop: ${t.notes}`,
	);
});

test("agent scan skips dot directories and node_modules, and goes at most 6 levels deep", async () => {
	const s = sandbox();
	const agents = join(s.repo, ".claude/agents");
	s.write(join(agents, "a/b/c/d/e/f/six.md"), def("six", "level 6"));
	s.write(join(agents, "a/b/c/d/e/f/g/seven.md"), def("seven", "level 7"));
	s.write(join(agents, ".hidden/h.md"), def("h", "hidden"));
	s.write(join(agents, "node_modules/n.md"), def("n", "modules"));
	const t = await loadTool({}, { cwd: s.repo });
	assert.match(t.tool.description, /- six: level 6/);
	assert.doesNotMatch(t.tool.description, /- seven:/);
	assert.doesNotMatch(t.tool.description, /- h:/);
	assert.doesNotMatch(t.tool.description, /- n:/);
});

test("a source with more than 5000 entries stops with a warning", async () => {
	const s = sandbox();
	const agents = join(s.repo, ".claude/agents");
	s.write(join(agents, "ok.md"), def("ok", "fine"));
	for (let i = 0; i < 5001; i++) mkdirSync(join(agents, `d${i}`));
	const t = await loadTool({}, { cwd: s.repo });
	assert.ok(
		t.notes.some((n) => n.includes("more than 5000 entries")),
		`no cap warning: ${t.notes}`,
	);
});

test("the project walk never includes the home directory", async () => {
	const s = sandbox();
	s.write(join(s.home, ".claude/agents/Explore.md"), def("Explore", "user explore"));
	s.write(join(s.home, ".claude/agents/c.md"), def("c", "home-claude"));
	s.write(join(s.home, ".pi/agent/agents/c.md"), def("c", "home-pi"));
	const t = await loadTool({}, { cwd: s.home });
	assert.match(t.tool.description, /- Explore: user explore/);
	assert.match(t.tool.description, /- c: home-pi/);
	assert.equal(
		t.notes.some((n) => n.includes("overrides the built-in")),
		false,
		`${t.notes}`,
	);
});

test("home is recognised through a trailing slash or a symlinked HOME, also when home is a git repo", async () => {
	for (const variant of ["slash", "symlink"] as const) {
		const s = sandbox();
		mkdirSync(join(s.home, ".git"), { recursive: true }); // a dotfiles repo at ~
		const proj = join(s.home, "proj");
		mkdirSync(proj, { recursive: true });
		s.write(join(s.home, ".claude/agents/Explore.md"), def("Explore", "user explore"));
		if (variant === "slash") {
			process.env.HOME = `${s.home}/`;
		} else {
			symlinkSync(s.home, join(s.root, "linkhome"));
			process.env.HOME = join(s.root, "linkhome");
		}
		for (const cwd of [proj, s.home]) {
			const t = await loadTool({}, { cwd });
			assert.match(t.tool.description, /- Explore: user explore/, `${variant} ${cwd}`);
			assert.equal(
				t.notes.some((n) => n.includes("overrides the built-in")),
				false,
				`${variant} ${cwd}: ${t.notes}`,
			);
		}
	}
});
