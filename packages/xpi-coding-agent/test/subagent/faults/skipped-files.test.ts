// An agent file that does not load is reported where the user can see it: on stderr in print mode, and in the error of
// a call for that agent (no model; a fake child that is never started).
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { agentFile, loadTool, sandbox } from "../helpers.ts";

const broken = agentFile("name: reviewer\ndescription: d\ntools: [Read, Grep");

async function captureStderr(run: () => Promise<unknown>): Promise<string> {
	const write = process.stderr.write;
	let out = "";
	process.stderr.write = ((chunk: string | Uint8Array) => {
		out += String(chunk);
		return true;
	}) as typeof process.stderr.write;
	try {
		await run();
	} finally {
		process.stderr.write = write;
	}
	return out;
}

test("print mode: a skipped agent file is a warning on stderr, not a dropped notification", async () => {
	const s = sandbox();
	const path = join(s.repo, ".pi", "agents", "reviewer.md");
	s.write(path, broken);
	let notes: string[] = [];
	const err = await captureStderr(async () => {
		notes = (await loadTool({}, { cwd: s.repo, hasUI: false })).notes;
	});
	assert.match(err, new RegExp(`subagent: skipped agent file ${path}: invalid YAML`));
	assert.deepEqual(notes, []);
});

test("with a UI the same warning is a notification and stderr stays clean", async () => {
	const s = sandbox();
	s.write(join(s.repo, ".pi", "agents", "reviewer.md"), broken);
	let notes: string[] = [];
	const err = await captureStderr(async () => {
		notes = (await loadTool({}, { cwd: s.repo })).notes;
	});
	assert.equal(err, "");
	assert.ok(notes.some((n) => /skipped agent file .*reviewer\.md: invalid YAML/.test(n)));
});

test("a call for an agent whose file was skipped says why in its error", async () => {
	const s = sandbox();
	const path = join(s.repo, ".pi", "agents", "reviewer.md");
	s.write(path, broken);
	const t = await loadTool({}, { cwd: s.repo });
	await assert.rejects(
		t.run({ subagent_type: "reviewer" }),
		(error: Error) =>
			/unknown subagent_type "reviewer"\. Available: .*general-purpose/.test(error.message) &&
			error.message.includes(`skipped agent file ${path}: invalid YAML`),
	);
});
