// Ticket 06: run outcomes on real pi: completed, partial, abort, long prompts. Scripted faults (bad stream, crashes,
// provider errors, exact usage arithmetic) live in test/faults/.
import assert from "node:assert/strict";
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { agentFile, loadTool, REPLY_OK, sandbox, sessionEntries } from "./helpers.ts";

// step1.txt -> step2.txt -> ... -> stepN.txt, which holds the answer. A model has to read them one after another.
function chain(s: ReturnType<typeof sandbox>, steps: number) {
	for (let i = 1; i < steps; i++) s.write(join(s.repo, `step${i}.txt`), `Next file: step${i + 1}.txt\n`);
	s.write(join(s.repo, `step${steps}.txt`), "END. The code is ZEBRA-9.\n");
}
const FOLLOW =
	"Start at step1.txt. Read one file per step with the read tool (never two files in one step) and follow its Next file line until a file says END. Then reply with the code.";

test("a run longer than maxTurns stops as partial after exactly maxTurns turns", async () => {
	const s = sandbox();
	chain(s, 6);
	s.write(join(s.repo, ".pi/agents/short.md"), agentFile("name: short\ndescription: d\nmaxTurns: 2"));
	const t = await loadTool({}, { cwd: s.repo });
	const r = await t.result({ subagent_type: "short", prompt: FOLLOW });
	assert.equal(r.status, "partial");
	assert.equal(r.turns, 2);
	assert.doesNotMatch(r.output, /ZEBRA-9/);
	assert.ok(r.usage.cost.total > 0, "the turns that ran are paid for and counted");
});

test("with room in maxTurns the same task completes", async () => {
	const s = sandbox();
	chain(s, 3);
	s.write(join(s.repo, ".pi/agents/roomy.md"), agentFile("name: roomy\ndescription: d\nmaxTurns: 12"));
	const t = await loadTool({}, { cwd: s.repo });
	const r = await t.result({ subagent_type: "roomy", prompt: FOLLOW });
	assert.equal(r.status, "completed", r.error ?? "");
	assert.match(r.output, /ZEBRA-9/);
	assert.ok(r.turns >= 4 && r.turns <= 12, `turns: ${r.turns}`);
});

test("maxTurns reached on the last turn of a run that settles on its own is completed", async () => {
	const s = sandbox();
	s.write(join(s.repo, ".pi/agents/one.md"), agentFile("name: one\ndescription: d\nmaxTurns: 1"));
	const t = await loadTool({}, { cwd: s.repo });
	const r = await t.result({ subagent_type: "one", prompt: REPLY_OK });
	assert.equal(r.status, "completed", r.error ?? "");
	assert.match(r.output, /OK/);
	assert.equal(r.turns, 1);
});

test("abort stops a real child promptly and throws", async () => {
	const s = sandbox();
	chain(s, 30);
	const t = await loadTool({}, { cwd: s.repo });
	const ac = new AbortController();
	const started = Date.now();
	setTimeout(() => ac.abort(), 1500);
	await assert.rejects(t.run({ prompt: FOLLOW }, ac.signal), /aborted/);
	assert.ok(Date.now() - started < 8000, "the child was stopped promptly");
});

test("a missing pi binary fails the run", async () => {
	const s = sandbox();
	const t = await loadTool({ piCommand: join(s.root, "no-such-pi") }, { cwd: s.repo });
	const r = await t.result({});
	assert.equal(r.status, "failed");
	assert.match(r.error!, /could not start/);
});

test("a prompt with a NUL byte (impossible in argv) reaches the child over rpc, and the temp dir is removed", async () => {
	const s = sandbox();
	const tmp = join(s.root, "tmp");
	mkdirSync(tmp);
	const oldTmp = process.env.TMPDIR;
	process.env.TMPDIR = tmp;
	try {
		const t = await loadTool({}, { cwd: s.repo });
		const r = await t.result({ prompt: "nul \0 byte. Reply with the single word OK. Do not call any tool." });
		assert.equal(r.status, "completed", r.error ?? "");
		assert.deepEqual(
			readdirSync(tmp).filter((f) => f.startsWith("subagent-")),
			[],
		); // pi may cache under TMPDIR
	} finally {
		if (oldTmp === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = oldTmp;
	}
});

test("a prompt over 150 KB reaches the child intact over rpc", async () => {
	const s = sandbox();
	const t = await loadTool({}, { cwd: s.repo, persist: join(s.root, "sessions") });
	const filler = "alpha beta gamma delta\n".repeat(6800); // a little over 150,000 bytes
	const prompt = `The secret code is OWL-5150. Reply with only the secret code. Ignore everything after this line.\n${filler}`;
	assert.ok(Buffer.byteLength(prompt) > 150_000);
	const r = await t.result({ prompt });
	assert.equal(r.status, "completed", r.error ?? "");
	assert.match(r.output, /OWL-5150/);
	const users = sessionEntries(t.sessionDir!, r.agentId).filter(
		(e) => e.type === "message" && e.message.role === "user",
	);
	assert.ok(JSON.stringify(users[0]!.message.content).includes("OWL-5150"), "the whole prompt text arrived");
});

test("a prompt starting with a dash or an @ is text for pi, not a flag or a file", async () => {
	const s = sandbox();
	const t = await loadTool({}, { cwd: s.repo });
	const [dash, at] = await Promise.all([
		t.result({ prompt: "--help is not a flag here. Reply with the single word OK. Do not call any tool." }),
		t.result({ prompt: "@alice is not a file here. Reply with the single word OK. Do not call any tool." }),
	]);
	for (const r of [dash, at]) {
		assert.equal(r.status, "completed", r.error ?? "");
		assert.match(r.output, /OK/);
		assert.equal(r.turns, 1);
	}
});
