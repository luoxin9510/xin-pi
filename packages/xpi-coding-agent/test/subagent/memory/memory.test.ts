// Agent memory (v3b ticket 03) without a model: the `memory` field, the directories, the prompt section and its
// truncation, the tools, read-only. Temp dirs only; the user scope base is passed in, never ~/.claude.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readConfig } from "../../../src/extensions/subagent/config.ts";
import { type AgentDefinition, parseDefinition } from "../../../src/extensions/subagent/definition.ts";
import { type ParentContext, resolveChild } from "../../../src/extensions/subagent/resolve.ts";
import { agentFile } from "../helpers.ts";

const parse = (fields: string) => parseDefinition("x.md", agentFile(`name: x\ndescription: d\n${fields}`));
const config = readConfig(undefined);
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "subagent-mem-")));

function setup(fields = "memory: project") {
	const dir = tmp();
	const root = join(dir, "repo");
	const claudeDir = join(dir, "claude");
	mkdirSync(root, { recursive: true });
	const r = parse(fields);
	assert.ok(r.ok);
	const parent: ParentContext = { cwd: root, thinking: "off", trusted: false, sessionId: "p" };
	const resolve = (def: AgentDefinition = r.def) =>
		resolveChild(def, { description: "d", prompt: "p" }, config, parent, { memoryRoot: root, claudeDir });
	return { dir, root, claudeDir, def: r.def, resolve, memDir: join(root, ".claude/agent-memory/x") };
}

const toolsOf = (args: string[]) => args[args.indexOf("--tools") + 1].split(",").sort();

test("memory is parsed and no longer inert; a wrong value skips the file naming the field", () => {
	const ok = parse("memory: local\nhooks: {}");
	assert.ok(ok.ok);
	assert.equal(ok.def.memory, "local");
	assert.deepEqual(ok.def.inert, ["hooks"]);
	const none = parse("");
	assert.ok(none.ok && none.def.memory === undefined);
	const bad = parse("memory: global");
	assert.ok(!bad.ok);
	assert.match(bad.reason, /"memory" must be user \| project \| local/);
});

test("directories per scope are created on start; the name must not be a path", () => {
	for (const [scope, rel] of [
		["user", "claude/agent-memory/x"],
		["project", "repo/.claude/agent-memory/x"],
		["local", "repo/.claude/agent-memory-local/x"],
	]) {
		const t = setup(`memory: ${scope}`);
		const spec = t.resolve();
		assert.ok(existsSync(join(t.dir, rel)), scope);
		assert.ok(spec.systemPrompt.includes(join(t.dir, rel)), scope);
	}
	const t = setup();
	assert.throws(() => t.resolve({ ...t.def, name: "../evil" }), /"\.\.\/evil"/);
});

test("without memory the prompt has no memory section and nothing is created", () => {
	const t = setup("");
	assert.equal(t.resolve().systemPrompt.includes("Persistent memory"), false);
	assert.equal(existsSync(join(t.root, ".claude")), false);
});

test("MEMORY.md: no file, a short file, over 200 lines, over the byte limit, multibyte text at the limit", () => {
	const t = setup();
	const promptWith = (text: string) => {
		mkdirSync(t.memDir, { recursive: true });
		writeFileSync(join(t.memDir, "MEMORY.md"), text);
		return t.resolve().systemPrompt;
	};
	const none = t.resolve().systemPrompt;
	assert.ok(none.includes("# Persistent memory") && none.includes("does not exist yet"));

	const short = promptWith("- fact one\n- fact two\n");
	assert.ok(short.includes("- fact two") && !short.includes("truncated"));

	const long = promptWith(Array.from({ length: 250 }, (_, i) => `line-${i + 1}`).join("\n"));
	assert.ok(long.includes("line-200\n") && !long.includes("line-201") && long.includes("truncated"));

	const big = promptWith("x".repeat(20_000) + "\n" + "y".repeat(20_000));
	assert.ok(big.includes("x".repeat(20_000)) && !big.includes("y".repeat(10_000)) && big.includes("truncated"));

	// 3-byte characters: the cut falls inside one, which is dropped whole.
	const multi = promptWith("日".repeat(9000));
	assert.ok(!multi.includes("�") && multi.includes("truncated"));
	assert.ok(multi.includes("日".repeat(8333)) && !multi.includes("日".repeat(8334)));

	// a resume rebuilds the prompt, so it sees the current file
	assert.ok(promptWith("old\nnew-note\n").includes("new-note"));
});

test("tools: Read/Write/Edit are added when `tools` lacks them, not duplicated; nothing changes without `tools`", () => {
	assert.deepEqual(toolsOf(setup("memory: project\ntools: Bash").resolve().args), [
		"bash",
		"codemode",
		"edit",
		"read",
		"write",
	]);
	assert.deepEqual(toolsOf(setup("memory: project\ntools: Read, Write, Edit").resolve().args), [
		"codemode",
		"edit",
		"read",
		"write",
	]);
	const t = setup();
	const spec = t.resolve();
	assert.deepEqual(spec.args.slice(spec.args.indexOf("--tools"), spec.args.indexOf("--tools") + 2), [
		"--tools",
		"+codemode",
	]);
	assert.equal(spec.warnings.length, 0);
});

test("disallowedTools Write or Edit: memory is read-only, the prompt says so, the tools stay denied, a warning is added", () => {
	for (const denied of ["Write", "Edit"]) {
		const spec = setup(`memory: project\ntools: Bash\ndisallowedTools: ${denied}`).resolve();
		const tools = toolsOf(spec.args);
		assert.ok(tools.includes("read") && !tools.includes("write") && !tools.includes("edit"), denied);
		assert.ok(spec.args[spec.args.indexOf("--exclude-tools") + 1].includes(denied.toLowerCase()));
		assert.ok(spec.systemPrompt.includes("not allowed for you"));
		assert.ok(spec.warnings.some((w) => w.includes("memory") && w.includes("read-only")));
	}
	assert.equal(setup().resolve().systemPrompt.includes("not allowed for you"), false);
});

test("a memory agent's name must be a safe directory name; without memory any name parses", () => {
	const names = [
		'"a/b"',
		'".."',
		'".hidden"',
		'"a*"',
		'"a?"',
		'"a[b"',
		'"a]b"',
		'"a!b"',
		'"a#b"',
		'"a\\\\b"',
		'"a\\0b"',
		'"a\\nb"',
	];
	for (const n of names) {
		const r = parseDefinition("x.md", agentFile(`name: ${n}\ndescription: d\nmemory: local`));
		assert.ok(!r.ok, n);
		assert.match(r.reason, /memory/, n);
		assert.ok(parseDefinition("x.md", agentFile(`name: ${n}\ndescription: d`)).ok, `${n} without memory`);
	}
	assert.ok(parseDefinition("x.md", agentFile("name: my-agent_2.v\ndescription: d\nmemory: user")).ok);
});
