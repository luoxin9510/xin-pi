// Agent memory on real pi and haiku (v3b ticket 03): an agent with project memory reads a fact planted in MEMORY.md, writes
// a new note that a later run sees, and a read-only agent cannot change the file.
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { initRepo } from "../helpers.ts";
import { agentFile, loadTool, sandbox } from "./helpers.ts";

function setup(fields: string) {
	const s = sandbox();
	initRepo(s.repo);
	s.write(join(s.home, ".claude/agents/x.md"), agentFile(`name: x\ndescription: d\n${fields}`));
	const dir = join(realpathSync(s.repo), ".claude/agent-memory/x");
	mkdirSync(dir, { recursive: true });
	return { s, dir, file: join(dir, "MEMORY.md") };
}

const ALL = (dir: string) =>
	readdirSync(dir)
		.map((f) => readFileSync(join(dir, f), "utf8"))
		.join("\n");

test("an agent with project memory answers with a fact planted in MEMORY.md", async () => {
	const { s, file } = setup("memory: project");
	writeFileSync(file, "- The project codeword is ZEBRA-4417.\n");
	const t = await loadTool({}, { cwd: s.repo });
	const r = await t.result({
		subagent_type: "x",
		prompt:
			"What is the project codeword according to your memory? Reply with the codeword only. Do not call any tool.",
	});
	assert.equal(r.status, "completed", r.error ?? "");
	assert.ok(r.output.includes("ZEBRA-4417"), r.output);
});

test("an agent writes a note into its memory directory and a later run sees it", async () => {
	const { s, dir } = setup("memory: project");
	const t = await loadTool({}, { cwd: s.repo });
	const w = await t.result({
		subagent_type: "x",
		prompt:
			"Save to your memory: the deploy day is always THURSDAY-9035. Write it into MEMORY.md in your memory directory, then reply DONE.",
	});
	assert.equal(w.status, "completed", w.error ?? "");
	assert.ok(ALL(dir).includes("THURSDAY-9035"), "the note is in the memory directory");
	const r = await t.result({
		subagent_type: "x",
		prompt: "What is the deploy day according to your memory? Reply with the exact token only. Do not call any tool.",
	});
	assert.ok(r.output.includes("THURSDAY-9035"), r.output);
});

test("an agent whose disallowedTools denies Write cannot change its memory", async () => {
	// Bash is denied too: with it the agent can still write the file (README, Agent memory).
	const { s, dir, file } = setup("memory: project\ndisallowedTools: Write, Edit, Bash");
	writeFileSync(file, "- original\n");
	const t = await loadTool({}, { cwd: s.repo });
	const r = await t.result({
		subagent_type: "x",
		prompt:
			"Replace the contents of MEMORY.md in your memory directory with the single line 'changed'. If you cannot, say so.",
	});
	assert.ok(r.warnings.some((w) => w.includes("read-only")));
	assert.equal(readFileSync(file, "utf8"), "- original\n");
	assert.deepEqual(readdirSync(dir), ["MEMORY.md"]);
});
