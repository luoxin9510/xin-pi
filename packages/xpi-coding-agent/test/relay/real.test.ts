// relay on real models: the lead hands a small task to the worker, the acceptance command is run, the conversation is
// compacted to the hand-back record and the lead reviews. Both roles are haiku unless RELAY_TEST_LEAD names another
// model (RELAY_TEST_LEAD=anthropic/claude-opus-5-5 for a run with a real lead). Prints the tokens of each role.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { HAIKU, PI, sandbox } from "../subagent/real/helpers.ts";

const LEAD = process.env.RELAY_TEST_LEAD ?? HAIKU;

const TEST_JS = `const calc = require("./calc.js");
const assert = require("node:assert");
assert.strictEqual(calc.add(2, 3), 5);
assert.strictEqual(calc.sub(5, 3), 2);
assert.strictEqual(calc.mul(4, 3), 12);
assert.strictEqual(calc.div(12, 4), 3);
assert.throws(() => calc.div(1, 0), /division by zero/);
console.log("all passed");
`;

const PROMPT = `calc.js needs sub, mul and div (div throws an Error with the message "division by zero" when the divisor is 0) so that \`node test.js\` passes. Read calc.js and test.js, then give the work to the worker with the handover tool, with \`node test.js\` as the acceptance command. Do not edit calc.js yourself. After the hand back, tell me in one sentence whether it is done.`;

interface Entry {
	type: string;
	details?: { relay?: boolean };
	summary?: string;
	message?: {
		role: string;
		provider?: string;
		model?: string;
		usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost?: { total?: number } };
	};
}

test("the lead hands over, the worker builds, the lead reviews a record", { timeout: 600_000 }, async () => {
	const s = sandbox();
	s.write(join(s.repo, "calc.js"), "exports.add = (a, b) => a + b;\n");
	s.write(join(s.repo, "test.js"), TEST_JS);
	s.write(join(s.repo, ".pi", "settings.json"), JSON.stringify({ relay: { lead: LEAD, worker: HAIKU } }));
	const git = (...args: string[]) =>
		execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd: s.repo });
	git("init", "-q");
	git("add", "calc.js", "test.js");
	git("commit", "-q", "-m", "start");
	const sessionDir = join(s.root, "sessions");
	mkdirSync(sessionDir, { recursive: true });

	const child = spawn(PI, ["-p", "--model", "relay/auto", "--approve", "--session-dir", sessionDir, PROMPT], {
		cwd: s.repo,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let out = "";
	let err = "";
	child.stdout.on("data", (c: Buffer) => {
		out += c.toString("utf8");
	});
	child.stderr.on("data", (c: Buffer) => {
		err += c.toString("utf8");
	});
	const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
	assert.equal(code, 0, `xpi exited with ${code}: ${err.slice(-800)}`);

	const file = readdirSync(sessionDir, { recursive: true }).find((name) => String(name).endsWith(".jsonl"));
	assert.ok(file, "no session file");
	const entries: Entry[] = readFileSync(join(sessionDir, String(file)), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));

	// The work is done and the acceptance command passes.
	assert.match(execFileSync("node", ["test.js"], { cwd: s.repo }).toString(), /all passed/);

	// A hand-back compaction, with the lead's note and the acceptance result in the record.
	const record = entries.find((entry) => entry.type === "compaction" && entry.details?.relay);
	assert.ok(record, `no hand-back record; entry types: ${entries.map((entry) => entry.type).join(",")}`);
	assert.match(record.summary ?? "", /## Handover note \(written by the lead, word for word\)/);
	assert.match(record.summary ?? "", /`node test\.js`: passed \(exit 0\)/);
	assert.match(record.summary ?? "", /calc\.js/);

	// The lead answered before the handover and after the record; the worker in between.
	const recordAt = entries.indexOf(record);
	const responses = entries.flatMap((entry, index) =>
		entry.type === "message" && entry.message?.role === "assistant" ? [{ index, message: entry.message }] : [],
	);
	assert.ok(
		responses.some((response) => response.index > recordAt),
		"the lead did not answer after the hand back",
	);
	const tokens = (who: typeof responses) =>
		who.reduce(
			(sum, { message }) => ({
				requests: sum.requests + 1,
				input: sum.input + (message.usage?.input ?? 0),
				cacheRead: sum.cacheRead + (message.usage?.cacheRead ?? 0),
				cacheWrite: sum.cacheWrite + (message.usage?.cacheWrite ?? 0),
				output: sum.output + (message.usage?.output ?? 0),
				cost: sum.cost + (message.usage?.cost?.total ?? 0),
			}),
			{ requests: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, cost: 0 },
		);
	const after = responses.filter((response) => response.index > recordAt);
	console.log(`lead ${LEAD}, worker ${HAIKU}`);
	console.log("models in order:", responses.map((response) => response.message.model).join(" "));
	console.log("lead after the hand back:", JSON.stringify(tokens(after)));
	console.log("whole session:", JSON.stringify(tokens(responses)));
	if (LEAD !== HAIKU) {
		const lead = responses.filter((response) => `${response.message.provider}/${response.message.model}` === LEAD);
		const worker = responses.filter((response) => `${response.message.provider}/${response.message.model}` === HAIKU);
		console.log("lead:", JSON.stringify(tokens(lead)));
		console.log("worker:", JSON.stringify(tokens(worker)));
		assert.ok(worker.length > 0, "the worker made no request");
		assert.ok(
			after.every((response) => `${response.message.provider}/${response.message.model}` === LEAD),
			"a request after the hand back did not go to the lead",
		);
	}
	console.log("final answer:", out.trim().slice(-300));
});
