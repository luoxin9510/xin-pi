// Ticket 08: concurrency limit and config validation. The limit is process-wide and fixed by the first session that
// loads, so the first test in this file must be the one that sets it (2) and nothing before it may load a tool.
// Overlap is read from the children's session files: a header timestamp is a start, the last entry an end.
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadTool, REPLY_OK, sandbox, sessionEntries } from "./helpers.ts";

const span = (dir: string, agentId: string) => {
	const entries = sessionEntries(dir, agentId);
	return { start: Date.parse(entries[0]!.timestamp), end: Date.parse(entries.at(-1)!.timestamp) };
};

test("with maxConcurrent 2 the third call waits for a free slot", async () => {
	const s = sandbox();
	const t = await loadTool({ maxConcurrent: 2 }, { cwd: s.repo, persist: join(s.root, "sessions") });
	const rs = await Promise.all([1, 2, 3].map(() => t.result({ prompt: REPLY_OK })));
	assert.ok(
		rs.every((r) => r.status === "completed"),
		rs.map((r) => r.error).join(),
	);
	const spans = rs.map((r) => span(t.sessionDir!, r.agentId)).sort((a, b) => a.start - b.start);
	assert.ok(spans[1]!.start < spans[0]!.end, "the first two ran at the same time");
	assert.ok(
		spans[2]!.start >= Math.min(spans[0]!.end, spans[1]!.end),
		"the third started only after one of them ended",
	);
});

test("a queued call that is aborted leaves the queue and leaves no meta file behind", async () => {
	const s = sandbox();
	const t = await loadTool({ maxConcurrent: 2 }, { cwd: s.repo, persist: join(s.root, "sessions") }); // the first session's limit stays in force
	const ac = new AbortController();
	const first = t.result({ prompt: REPLY_OK });
	const second = t.result({ prompt: REPLY_OK });
	const queued = t.result({ prompt: REPLY_OK }, ac.signal);
	const third = t.result({ prompt: REPLY_OK });
	ac.abort();
	await assert.rejects(queued, /aborted/);
	const done = await Promise.all([first, second]);
	// If the aborted call kept its place in the queue, it would take the freed slot and never release it,
	// and the third call would wait forever.
	const timeout = new Promise((_, reject) =>
		setTimeout(() => reject(new Error("third call never got a slot")), 30_000),
	);
	const last = (await Promise.race([third, timeout])) as Awaited<typeof third>;
	assert.equal(last.status, "completed", last.error ?? "");
	const metas = [...done, last].map((r) => `${r.agentId}.json`).sort();
	const onDisk = readdirSync(t.sessionDir!)
		.filter((f) => f.endsWith(".json"))
		.sort();
	assert.deepEqual(onDisk, metas, "only the three calls that ran have a meta file");
});

test("the first session's maxConcurrent wins for the process; a later session does not change it", async () => {
	const s = sandbox();
	const t = await loadTool({ maxConcurrent: 1 }, { cwd: s.repo, persist: join(s.root, "sessions") }); // limit is already 2
	const rs = await Promise.all([1, 2].map(() => t.result({ prompt: REPLY_OK })));
	const [a, b] = rs.map((r) => span(t.sessionDir!, r.agentId)).sort((x, y) => x.start - y.start);
	assert.ok(b!.start < a!.end, "both calls ran at the same time");
});

test("wrong config types throw naming the key", async () => {
	const s = sandbox();
	const cases: [Record<string, unknown>, RegExp][] = [
		[{ maxConcurrent: "lots" }, /subagent\.maxConcurrent must be a positive integer/],
		[{ maxConcurrent: 0 }, /subagent\.maxConcurrent must be a positive integer/],
		[{ models: { opus: 5 } }, /subagent\.models\.opus must be a string/],
		[{ models: ["x"] }, /subagent\.models must be an object of strings/],
		[{ toolMap: { WebFetch: false } }, /subagent\.toolMap\.WebFetch must be a string/],
		[{ defaultModel: "" }, /subagent\.defaultModel must be a non-empty string/],
		[{ piCommand: 3 }, /subagent\.piCommand must be a non-empty string/],
		[{ childCodemode: "yes" }, /subagent\.childCodemode must be "only" or "inherit"/],
		[{ childCodemode: true }, /subagent\.childCodemode must be "only" or "inherit"/],
		[{ panelLingerMs: "soon" }, /subagent\.panelLingerMs must be a number/],
		[{ panelLingerMs: -1 }, /subagent\.panelLingerMs must be a number/],
	];
	for (const [settings, error] of cases) await assert.rejects(loadTool(settings, { cwd: s.repo }), error);
});

test("a config error is shown in the UI and rethrown", async () => {
	const s = sandbox();
	const notes: string[] = [];
	await assert.rejects(loadTool({ maxConcurrent: 0 }, { cwd: s.repo, notes }), /subagent\.maxConcurrent/);
	assert.equal(notes.length, 1);
	assert.match(notes[0]!, /^subagent: .*subagent\.maxConcurrent must be a positive integer/);
});
