// Ticket 05: preload skills. The system prompt the child ran with is read from the session pi wrote.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { agentFile, childSetup, loadTool, REPLY_OK, sandbox } from "./helpers.ts";

const skill = (name: string | undefined, body: string) =>
	name ? `---\nname: ${name}\ndescription: x\n---\n${body}\n` : `${body}\n`;

test("skills are found in order, recursively, through symlinks, and preloaded after the body", async () => {
	const s = sandbox();
	const sub = join(s.repo, "app");
	mkdirSync(sub, { recursive: true });
	s.write(join(s.repo, ".claude/skills/tdd/SKILL.md"), skill("tdd", "Red green refactor."));
	s.write(join(s.home, ".claude/skills/tdd/SKILL.md"), skill("tdd", "LOWER PRIORITY"));
	s.write(join(sub, ".pi/skills/notes/SKILL.md"), skill("notes", "Closest project dir."));
	s.write(join(s.home, ".pi/agent/skills/group/deep/folder-name/SKILL.md"), skill("review", "Review carefully."));
	s.write(join(s.home, ".agents/skills/nested/SKILL.md"), skill("outer", "Outer skill."));
	s.write(join(s.home, ".agents/skills/nested/inner/SKILL.md"), skill("inner", "Inside another skill: not a skill."));
	s.write(join(s.root, "elsewhere/linked/SKILL.md"), skill(undefined, "Linked skill, matched by folder name."));
	mkdirSync(join(s.repo, ".agents/skills"), { recursive: true });
	symlinkSync(join(s.root, "elsewhere/linked"), join(s.repo, ".agents/skills/linked"));
	s.write(
		join(sub, ".pi/agents/x.md"),
		agentFile("name: x\ndescription: d\nskills: tdd, notes, review, linked, outer, inner, ghost", "AGENT BODY"),
	);

	const t = await loadTool({}, { cwd: sub, persist: join(s.root, "sessions") });
	const r = await t.result({ subagent_type: "x", prompt: REPLY_OK });
	const prompt = childSetup(t.sessionDir!, r.agentId).prompt;

	const order = [
		"AGENT BODY",
		"# Skill: tdd",
		"# Skill: notes",
		"# Skill: review",
		"# Skill: linked",
		"# Skill: outer",
		"# Environment",
	];
	const at = order.map((h) => prompt.indexOf(h));
	assert.ok(
		at.every((i, k) => i >= 0 && (k === 0 || i > at[k - 1]!)),
		`sections out of order: ${at}`,
	);
	assert.ok(
		prompt.startsWith("AGENT BODY\n\n# Skill: tdd\n\n---\nname: tdd"),
		"full SKILL.md text, frontmatter included",
	);
	assert.match(prompt, /Red green refactor\./);
	assert.doesNotMatch(prompt, /LOWER PRIORITY/);
	assert.match(prompt, /Closest project dir\./);
	assert.match(prompt, /Review carefully\./);
	assert.match(prompt, /Linked skill, matched by folder name\./);
	assert.doesNotMatch(prompt, /Inside another skill/);
	assert.match(
		prompt,
		/\n# Environment\nWorking directory: .*app\nPlatform: \w+\nDate: \d{4}-\d{2}-\d{2}\n\nUse the `codemode` tool[^\n]*$/,
	);
	assert.deepEqual(r.warnings, ['skill "inner" not found', 'skill "ghost" not found']);
	assert.equal(r.status, "completed", "missing skills do not stop the run");
});

test("a preloaded skill's content is available to the child", async () => {
	const s = sandbox();
	s.write(join(s.repo, ".claude/skills/codeword/SKILL.md"), skill("codeword", "The codeword is PINEAPPLE-42."));
	s.write(
		join(s.repo, ".pi/agents/x.md"),
		agentFile("name: x\ndescription: d\nskills: codeword", "Answer from your instructions."),
	);
	const t = await loadTool({}, { cwd: s.repo });
	const r = await t.result({
		subagent_type: "x",
		prompt: "What is the codeword? Reply with only the codeword. Do not call any tool.",
	});
	assert.equal(r.status, "completed", r.error ?? "");
	assert.match(r.output, /PINEAPPLE-42/);
});

test("the system prompt replaces pi's default", async () => {
	const s = sandbox();
	const t = await loadTool({}, { cwd: s.repo, persist: join(s.root, "sessions") });
	const r = await t.result({ prompt: REPLY_OK });
	const prompt = childSetup(t.sessionDir!, r.agentId).prompt;
	assert.match(prompt, /^[\s\S]+\n\n# Environment\nWorking directory: /);
	assert.doesNotMatch(prompt, /pi documentation|Pi documentation|Available tools:/);
});

test("an unreadable skills directory counts as empty: the skill is reported not found", async () => {
	const s = sandbox();
	s.write(join(s.repo, ".pi/skills/locked/SKILL.md"), skill("hidden", "Secret."));
	s.write(join(s.repo, ".pi/agents/x.md"), agentFile("name: x\ndescription: d\nskills: hidden"));
	const t = await loadTool({}, { cwd: s.repo });
	chmodSync(join(s.repo, ".pi/skills/locked"), 0o000);
	try {
		const r = await t.result({ subagent_type: "x", prompt: REPLY_OK });
		assert.deepEqual(r.warnings, ['skill "hidden" not found']);
		assert.equal(r.status, "completed", r.error ?? "");
	} finally {
		chmodSync(join(s.repo, ".pi/skills/locked"), 0o755);
	}
});

test("a looping or dangling symlink in a skills directory does not break the call", async () => {
	const s = sandbox();
	const skills = join(s.repo, ".pi/skills");
	s.write(join(skills, "good/SKILL.md"), skill("good", "Fine."));
	symlinkSync("loop", join(skills, "loop"));
	symlinkSync(join(s.root, "nowhere"), join(skills, "dangling"));
	s.write(join(s.repo, ".pi/agents/x.md"), agentFile("name: x\ndescription: d\nskills: good, ghost"));
	const t = await loadTool({}, { cwd: s.repo, persist: join(s.root, "sessions") });
	const r = await t.result({ subagent_type: "x", prompt: REPLY_OK });
	assert.equal(r.status, "completed", r.error ?? "");
	assert.match(childSetup(t.sessionDir!, r.agentId).prompt, /Fine\./);
	assert.deepEqual(r.warnings, ['skill "ghost" not found']);
});
