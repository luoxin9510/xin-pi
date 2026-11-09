// Review fixes M1-M3 and W4 (child cwd) at resolveChild: temp dirs only, no model.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readConfig } from "../../../src/extensions/subagent/config.ts";
import { parseDefinition } from "../../../src/extensions/subagent/definition.ts";
import { type ParentContext, resolveChild } from "../../../src/extensions/subagent/resolve.ts";
import { agentFile } from "../helpers.ts";

const config = readConfig(undefined);

function setup(fields = "memory: project") {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "subagent-memfix-")));
	const root = join(dir, "repo");
	const claudeDir = join(dir, "claude");
	mkdirSync(root, { recursive: true });
	const r = parseDefinition("x.md", agentFile(`name: x\ndescription: d\n${fields}`));
	assert.ok(r.ok);
	const parent: ParentContext = { cwd: root, thinking: "off", trusted: false, sessionId: "p" };
	return {
		root,
		def: r.def,
		memDir: join(root, ".claude/agent-memory/x"),
		resolve: (p = parent, worktree?: any) =>
			resolveChild(r.def, { description: "d", prompt: "p" }, config, p, { memoryRoot: root, claudeDir, worktree }),
	};
}
const toolsOf = (args: string[]) => args[args.indexOf("--tools") + 1].split(",").sort();
const excludedOf = (args: string[]) => args[args.indexOf("--exclude-tools") + 1].split(",");

test("M1: a MEMORY.md that cannot be read (a directory) is treated as empty with a warning, not a failure", () => {
	const t = setup();
	mkdirSync(join(t.memDir, "MEMORY.md"), { recursive: true });
	const spec = t.resolve();
	assert.ok(spec.systemPrompt.includes("MEMORY.md does not exist yet."));
	assert.ok(spec.warnings.some((w) => w.includes("could not read") && w.includes("MEMORY.md")));
});

test("M2: a deny on Write or Edit removes both, even from an explicit tools list or the default set", () => {
	for (const denied of ["Write", "Edit"]) {
		const listed = toolsOf(
			setup(`memory: project\ntools: Read, Write, Edit\ndisallowedTools: ${denied}`).resolve().args,
		);
		assert.ok(!listed.includes("write") && !listed.includes("edit"), `${denied} listed: ${listed}`);
		const excluded = excludedOf(setup(`memory: project\ndisallowedTools: ${denied}`).resolve().args);
		assert.ok(excluded.includes("write") && excluded.includes("edit"), `${denied} default: ${excluded}`);
	}
	const user = toolsOf(setup("memory: project\ntools: Read, Write\ndisallowedTools: Edit").resolve().args);
	assert.ok(!user.includes("write"));
});

test("M3: a parameterised deny is widened to the whole tool and the warning says so", () => {
	const spec = setup("memory: project\ntools: Read, Write\ndisallowedTools: Write(*.md)").resolve();
	assert.ok(
		spec.warnings.some((w) => w.includes("Write(*.md)") && w.includes("whole tool")),
		spec.warnings.join("|"),
	);
});

test("W4: the child's cwd is the same subdirectory inside the worktree", () => {
	const t = setup("");
	const parent: ParentContext = { cwd: join(t.root, "pkg/sub"), thinking: "off", trusted: false, sessionId: "p" };
	const worktree = {
		root: t.root,
		path: join(t.root, ".pi/worktrees/a1"),
		branch: "subagent/a1",
		base: "x",
		subdir: "pkg/sub",
	};
	const spec = t.resolve(parent, worktree);
	assert.equal(spec.cwd, join(t.root, ".pi/worktrees/a1/pkg/sub"));
	assert.ok(spec.systemPrompt.includes(`Working directory: ${spec.cwd}`));
});
