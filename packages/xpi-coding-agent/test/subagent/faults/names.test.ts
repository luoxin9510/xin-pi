// Agent names (spec 03): validation, uniqueness in the session, storage in the meta file, resume by name, and the
// label the panel and the screen header show.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { label, registry } from "../../../src/extensions/subagent/registry.ts";
import { ev, loadTool, sandbox } from "../helpers.ts";

const ok = (text = "done") => ({ lines: [ev.session(), ev.assistant(text), ev.turnEnd(), ev.settled()] });

async function setup(sessionId: string) {
	const s = sandbox();
	s.scenario(ok());
	const sessionFile = join(s.root, "parent.jsonl");
	const t = await loadTool({}, { cwd: s.repo, sessionFile, sessionId });
	return { s, t };
}

test("name: stored with the agent, shown in its label, and no warning", async () => {
	const { s, t } = await setup("names-1");
	const r = (await t.run({ name: "reviewer", description: "check the diff" })).structuredContent;
	assert.equal(r.status, "completed");
	assert.deepEqual(r.warnings, []);
	const record = registry.get(r.agentId)!;
	assert.equal(record.name, "reviewer");
	assert.equal(label(record), "general-purpose(reviewer) check the diff");
	assert.equal(label({ type: "Explore", description: "d" }), "Explore(d)");
	const meta = JSON.parse(readFileSync(join(s.root, "subagents", "names-1", `${r.agentId}.json`), "utf8"));
	assert.equal(meta.name, "reviewer");
});

test("name: letters, digits, _ and -, at most 64; anything else throws before a child starts", async () => {
	const { t } = await setup("names-2");
	for (const name of ["", "has space", "ümlaut", "a/b", "x".repeat(65)])
		await assert.rejects(t.run({ name }), /invalid name .*use 1 to 64 letters, digits, "_" or "-"/, name);
	assert.equal(registry.list("names-2").length, 0);
	assert.equal((await t.run({ name: "x".repeat(64) })).structuredContent.status, "completed");
});

test("name: a second agent with the name throws, naming the first one's id; also when both start in one tick", async () => {
	const { t } = await setup("names-3");
	const first = (await t.run({ name: "worker" })).structuredContent;
	await assert.rejects(
		t.run({ name: "worker" }),
		new RegExp(`the name "worker" is already used by agent ${first.agentId} of this session`),
	);
	const both = await Promise.allSettled([t.run({ name: "twin" }), t.run({ name: "twin" })]);
	assert.deepEqual(both.map((b) => b.status).sort(), ["fulfilled", "rejected"]);
	assert.equal(registry.list("names-3").filter((r) => r.name === "twin").length, 1);
});

test("name: a call that fails before it starts gives the name back", async () => {
	const { t } = await setup("names-4");
	await assert.rejects(t.run({ name: "ghost", subagent_type: "no-such-agent" }), /unknown subagent_type/);
	await assert.rejects(t.run({ name: "ghost", isolation: "worktree" })); // no real repository: fails after the claim
	assert.equal((await t.run({ name: "ghost" })).structuredContent.status, "completed");
});

test("resume: by name; with the same name; another name, or a name for an unnamed agent, throws", async () => {
	const { s, t } = await setup("names-5");
	const first = (await t.run({ name: "reviewer" })).structuredContent;
	s.scenario(ok("second answer"));
	const byName = (await t.run({ resume: "reviewer", prompt: "one more thing" })).structuredContent;
	assert.equal(byName.agentId, first.agentId);
	assert.equal(byName.output, "second answer");
	assert.equal(s.record().commands.find((c) => c.type === "prompt")?.message, "one more thing");
	assert.equal((await t.run({ resume: first.agentId, name: "reviewer" })).structuredContent.status, "completed");
	assert.equal(registry.get(first.agentId)!.name, "reviewer", "a resume keeps the name");
	await assert.rejects(t.run({ resume: "reviewer", name: "other" }), /is named "reviewer", not "other"/);
	const plain = (await t.run({})).structuredContent;
	await assert.rejects(
		t.run({ resume: plain.agentId, name: "late" }),
		/has no name: a name is given when an agent starts/,
	);
	await assert.rejects(t.run({ resume: "nobody" }), /no subagent session "nobody" to resume/);
});

test("names belong to a session: another session may use the same one; a reload reads them back", async () => {
	const { s, t } = await setup("names-6");
	const a = (await t.run({ name: "shared" })).structuredContent;
	const other = await loadTool({}, { cwd: s.repo, sessionFile: join(s.root, "other.jsonl"), sessionId: "names-6b" });
	assert.equal((await other.run({ name: "shared" })).structuredContent.status, "completed");
	registry.clear(); // a fresh process
	const again = await loadTool({}, { cwd: s.repo, sessionFile: join(s.root, "parent.jsonl"), sessionId: "names-6" });
	assert.equal(registry.find("names-6", "shared"), a.agentId);
	await assert.rejects(again.run({ name: "shared" }), /already used by agent/);
});
