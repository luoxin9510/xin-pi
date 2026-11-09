// Ticket v2-08: stopping a subagent and switching its model from its screen, on real pi and haiku.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { registry } from "../../../src/extensions/subagent/registry.ts";
import { assistantMessages, loadTool, sandbox, sessionEntries } from "./helpers.ts";

const reply = (word: string) => `Reply with exactly the single word ${word}. Do not call any tool.`;
const LONG = "Run the bash command 'sleep 60' with the codemode tool, then reply with the single word FINISHED.";
const ALT = "anthropic/claude-haiku-4-5";
const MODELS = ["anthropic/claude-haiku-5-5", ALT];
const waitUntil = async (what: string, ready: () => boolean, ms = 60_000) => {
	for (const end = Date.now() + ms; !ready(); ) {
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 50));
	}
};
const running = (t: { sessionId: string }) => {
	const r = registry.list(t.sessionId)[0];
	return r?.lastTool !== undefined && registry.handle(r.id) !== undefined ? r : undefined;
};
const meta = (dir: string, id: string) => JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8"));
const modelChanges = (dir: string, id: string) =>
	sessionEntries(dir, id)
		.filter((e) => e.type === "model_change")
		.map((e) => `${e.provider}/${e.modelId}`);
const lastLine = (screen: any) => screen.render(100).at(-1) as string;

test("/stop on a running subagent: the Agent call resolves failed 'stopped by user', the script goes on, it can be resumed or typed to", async () => {
	const s = sandbox();
	const t = await loadTool({}, { cwd: s.repo, persist: join(s.root, "sessions") });
	const started = Date.now();
	const run = t.result({ description: "stop probe", prompt: LONG });
	await waitUntil("the child to be running a tool", () => running(t) !== undefined);
	const id = registry.list(t.sessionId)[0]!.id;
	await t.say(id, "/stop");

	const r = await run; // resolved, not thrown: the script's Promise continues
	assert.ok(Date.now() - started < 50_000, "the sleep was cut short");
	assert.equal(r.status, "failed");
	assert.equal(r.error, "stopped by user");
	assert.equal(r.agentId, id);
	assert.equal(registry.get(id)!.status, "stopped");
	assert.equal(registry.handle(id), undefined);
	assert.equal(meta(t.sessionDir!, id).status, "stopped");
	assert.equal(t.messages.length, 0, "stopping is not talking: no note");

	// stopping something that is not running: a short notice
	const screen = await t.say(id, "/stop");
	assert.match(lastLine(screen), /not running/);

	// main resumes it
	const resumed = await t.result({ resume: id, prompt: reply("AFTERSTOP") });
	assert.equal(resumed.status, "completed", resumed.error ?? "");
	assert.match(resumed.output, /AFTERSTOP/);
	assert.equal(registry.get(id)!.status, "completed");

	// the user types to it
	await t.say(id, reply("TYPED"));
	await registry.drained(id);
	assert.equal(registry.get(id)!.status, "completed");
	assert.match(JSON.stringify(sessionEntries(t.sessionDir!, id).at(-1)), /TYPED/);
});

test("/model on a finished subagent is stored in its meta and used by the next exchange; unknown models change nothing", async () => {
	const s = sandbox();
	const t = await loadTool({}, { cwd: s.repo, persist: join(s.root, "sessions"), models: MODELS });
	const first = await t.result({ description: "model probe", prompt: reply("ONE") });
	assert.equal(first.status, "completed", first.error ?? "");
	const id = first.agentId;
	assert.equal(registry.get(id)!.model, "anthropic/claude-haiku-5-5");

	let screen = await t.say(id, "/model anthropic/nope");
	await new Promise((r) => setTimeout(r, 100));
	assert.match(lastLine(screen), /unknown model anthropic\/nope/);
	assert.equal(registry.get(id)!.model, "anthropic/claude-haiku-5-5");

	screen = await t.say(id, "/model " + ALT);
	await waitUntil("the model to be stored", () => registry.get(id)!.model === ALT);
	assert.equal(meta(t.sessionDir!, id).model, ALT);

	await t.say(id, reply("TWO")); // continued with the stored model
	await registry.drained(id);
	assert.equal(registry.get(id)!.model, ALT);
	const lastReply = assistantMessages(sessionEntries(t.sessionDir!, id)).at(-1);
	assert.equal(`${lastReply.provider}/${lastReply.model}`, ALT, "the second answer came from the stored model");
});

test("/model without an argument opens a list on the screen; the running child switches at once", async () => {
	const s = sandbox();
	const t = await loadTool({}, { cwd: s.repo, persist: join(s.root, "sessions"), models: MODELS });
	const run = t.result({ description: "model probe", prompt: LONG });
	await waitUntil("the child to be running a tool", () => running(t) !== undefined);
	const id = registry.list(t.sessionId)[0]!.id;

	const screen = await t.say(id, "/model"); // opens the list on the screen, the current model selected
	assert.match(
		screen.render(100).join("\n"),
		/Model for general-purpose[\s\S]*▸ anthropic\/claude-haiku-5-5\n? *anthropic\/claude-haiku-4-5/,
	);
	screen.handleInput("\x1b[B");
	screen.handleInput("\r");
	await waitUntil("the model to be stored", () => registry.get(id)!.model === ALT);
	await waitUntil("pi to record the switch", () => modelChanges(t.sessionDir!, id).at(-1) === ALT);
	assert.equal(meta(t.sessionDir!, id).model, ALT);

	await t.say(id, "/stop");
	const r = await run;
	assert.equal(r.error, "stopped by user");
});
