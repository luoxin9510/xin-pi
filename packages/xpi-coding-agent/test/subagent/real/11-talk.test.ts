// Ticket v2-07: talking to a subagent from its screen, on real pi and haiku. The screen is typed into through the
// stub ui (t.say); main's side is the Agent tool and what pi.sendMessage received.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { noteText } from "../../../src/extensions/subagent/exchange.ts";
import { registry } from "../../../src/extensions/subagent/registry.ts";
import { assistantMessages, loadTool, sandbox, sessionEntries } from "./helpers.ts";

const reply = (word: string) => `Reply with exactly the single word ${word}. Do not call any tool.`;
const textOf = (m: any) =>
	m.content
		.filter((c: any) => c.type === "text")
		.map((c: any) => c.text)
		.join("");
const userTexts = (dir: string, id: string) =>
	sessionEntries(dir, id)
		.filter((e) => e.type === "message" && e.message.role === "user")
		.map((e) =>
			typeof e.message.content === "string" ? e.message.content : e.message.content.map((c: any) => c.text).join(""),
		);
const waitUntil = async (what: string, ready: () => boolean, ms = 60_000) => {
	for (const end = Date.now() + ms; !ready(); ) {
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 50));
	}
};

test("a user message and main's resume of one subagent run one after the other, in arrival order; only the user's gets a note", async () => {
	const s = sandbox();
	const t = await loadTool({}, { cwd: s.repo, persist: join(s.root, "sessions") });
	const first = await t.result({ description: "queue probe", prompt: reply("ONE") });
	assert.equal(first.status, "completed", first.error ?? "");
	const id = first.agentId;

	await t.say(id, reply("USERREPLY")); // the screen does not wait: the user's exchange starts now
	const resumed = await t.result({ resume: id, prompt: reply("MAINREPLY") }); // arrives second: waits its turn
	assert.equal(resumed.status, "completed", resumed.error ?? "");
	assert.match(resumed.output, /MAINREPLY/);
	await registry.drained(id);

	// one conversation, in order, one writer at a time: a linear chain, the second exchange starts after the first ended
	const entries = sessionEntries(t.sessionDir!, id);
	const msgs = entries.filter((e) => e.type === "message" && e.message.role !== "system");
	assert.deepEqual(
		msgs.map((e) => e.message.role),
		["user", "assistant", "user", "assistant", "user", "assistant"],
	);
	msgs.slice(1).forEach((e, i) => assert.equal(e.parentId, msgs[i]!.id, "no branch: nobody wrote at the same time"));
	assert.deepEqual(userTexts(t.sessionDir!, id), [reply("ONE"), reply("USERREPLY"), reply("MAINREPLY")]);
	assert.match(textOf(assistantMessages(entries)[1]), /USERREPLY/);
	assert.ok(
		Date.parse(msgs[4]!.timestamp) >= Date.parse(msgs[3]!.timestamp),
		"main's resume started after the user's exchange ended",
	);

	// the note: the user's exchange only, with the text and the reply; main was idle, so no steer delivery
	assert.equal(t.messages.length, 1);
	const { message, options } = t.messages[0]!;
	assert.equal(message.customType, "subagent");
	assert.equal(message.display, true);
	assert.equal(
		message.content,
		`User said to general-purpose(${id}): ${reply("USERREPLY")}\nIt replied: ${textOf(assistantMessages(entries)[1])}`,
	);
	assert.equal(options, undefined, "idle main: stored, no turn");
});

test("a message to a finished subagent resumes it with its stored thinking level; while main runs the note is a steer", async () => {
	const s = sandbox();
	let mainIdle = true;
	const t = await loadTool({}, { cwd: s.repo, persist: join(s.root, "sessions"), idle: () => mainIdle });
	const first = await t.result({ description: "stored config", prompt: reply("ONE"), effort: "high" }); // the parent's own level is "off"
	assert.equal(first.status, "completed", first.error ?? "");
	const id = first.agentId;
	assert.equal(registry.get(id)!.thinking, "high");

	mainIdle = false;
	await t.say(id, reply("USERREPLY"));
	await registry.drained(id);
	const rec = registry.get(id)!;
	assert.equal(rec.status, "completed");
	assert.equal(rec.thinking, "high", "the stored level was used, not the parent's");
	assert.equal(rec.model, first.model);
	assert.ok(rec.turns > first.turns, "the new exchange counts on the same record");
	const entries = sessionEntries(t.sessionDir!, id);
	assert.match(textOf(assistantMessages(entries).at(-1)), /USERREPLY/);

	assert.equal(t.messages.length, 1);
	assert.deepEqual(
		t.messages[0]!.options,
		{ deliverAs: "steer" },
		"main is running: the note steers it, no turn is triggered",
	);
});

test("typing to a running subagent steers it; the note, sent when the run settles, has the steer and the final reply", async () => {
	const s = sandbox();
	const t = await loadTool({}, { cwd: s.repo, persist: join(s.root, "sessions") });
	const run = t.result({
		description: "steer probe",
		prompt: "Run the bash command 'sleep 8' with the codemode tool, then reply with the single word FINISHED.",
	});
	await waitUntil("the child to be running a tool", () => {
		const r = registry.list(t.sessionId)[0];
		return r?.lastTool !== undefined && registry.handle(r.id) !== undefined;
	});
	const id = registry.list(t.sessionId)[0]!.id;
	const steer =
		"STOP. Do not run anything else. Your final message must be exactly the word TOKEN-xyz and nothing more.";
	await t.say(id, steer);
	assert.equal(t.messages.length, 0, "no note until the run settles");

	const r = await run;
	assert.equal(r.status, "completed", r.error ?? "");
	assert.match(r.output, /TOKEN-xyz/);
	assert.doesNotMatch(r.output, /FINISHED/);
	assert.equal(userTexts(t.sessionDir!, id).length, 2, "the steer is a user message in the same session");
	assert.equal(t.messages.length, 1);
	assert.equal(
		t.messages[0]!.message.content,
		`User said to general-purpose(${id}): ${steer}\nIt replied: ${r.output}`,
	);
});

test("a long reply is cut in the note; a failed exchange says so", () => {
	const run = (output: string, error?: string) => ({ status: error ? "failed" : "completed", output, error }) as any;
	const long = noteText("Plan", "abc", ["hi"], run("x".repeat(5000)));
	assert.equal(long, `User said to Plan(abc): hi\nIt replied: ${"x".repeat(2000)}... (cut, 5000 chars)`);
	assert.equal(
		noteText("Plan", "abc", ["a", "b"], run("", "boom")),
		"User said to Plan(abc): a\nUser said to Plan(abc): b\nIt replied: (failed: boom)",
	);
});
