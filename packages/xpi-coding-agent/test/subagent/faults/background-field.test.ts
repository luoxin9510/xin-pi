// `background: true` in an agent file (spec 05): a call without run_in_background returns at once and the result
// arrives as a message; the call's own value wins; print mode waits. Also the fields that stay inert say why.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { inertNotice, parseDefinition } from "../../../src/extensions/subagent/definition.ts";
import { agentFile, ev, loadTool, sandbox } from "../helpers.ts";

async function setup(hasUI = true) {
	const s = sandbox();
	s.write(join(s.repo, ".pi/agents/bg.md"), agentFile("name: bg\ndescription: d\nbackground: true"));
	s.write(join(s.repo, ".pi/agents/fg.md"), agentFile("name: fg\ndescription: d\nbackground: false"));
	s.scenario({ lines: [ev.session(), ev.assistant("the answer"), ev.turnEnd(), ev.settled()] });
	const t = await loadTool({}, { cwd: s.repo, hasUI, sessionFile: join(s.root, "parent.jsonl") });
	return { s, t };
}
const ended = async (t: { messages: unknown[] }) => {
	for (let i = 0; i < 300 && t.messages.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
};

test("background: true returns at once with status running; the result arrives as a message", async () => {
	const { t } = await setup();
	const r = (await t.run({ subagent_type: "bg" })).structuredContent;
	assert.equal(r.status, "running");
	assert.deepEqual(r.warnings, [], "the field is no longer reported as inert");
	await ended(t);
	assert.match(t.messages[0]!.message.content as string, /^Background agent .* bg completed[\s\S]*the answer/);
});

test("the call's run_in_background: false wins; background: false and other agents wait as before", async () => {
	const { t } = await setup();
	const waited = (await t.run({ subagent_type: "bg", run_in_background: false })).structuredContent;
	assert.equal(waited.status, "completed");
	assert.equal(waited.output, "the answer");
	assert.equal((await t.run({ subagent_type: "fg" })).structuredContent.status, "completed");
	assert.equal((await t.run({})).structuredContent.status, "completed");
	assert.equal(t.messages.length, 0);
});

test("a resume of a background agent runs in the background too; print mode waits", async () => {
	const { t } = await setup();
	const first = (await t.run({ subagent_type: "bg", run_in_background: false })).structuredContent;
	const again = (await t.run({ resume: first.agentId })).structuredContent;
	assert.equal(again.status, "running");
	await ended(t);
	const print = await setup(false);
	assert.equal((await print.t.run({ subagent_type: "bg" })).structuredContent.status, "completed");
});

test("background must be true or false; the fields that stay inert say why", () => {
	const bad = parseDefinition("f", "---\nname: a\ndescription: d\nbackground: yes please\n---\nbody");
	assert.ok(!bad.ok && /"background" must be true or false/.test(bad.reason));
	const r = parseDefinition(
		"f",
		"---\nname: a\ndescription: d\nbackground: true\nmcpServers: []\nhooks: {}\npermissionMode: plan\ninitialPrompt: hi\nautoCompactWindow: 200000\nexperimental: {}\n---\nbody",
	);
	assert.ok(r.ok);
	assert.deepEqual(r.def.inert, ["autoCompactWindow", "permissionMode", "hooks", "initialPrompt", "experimental"]);
	assert.equal(
		inertNotice("permissionMode"),
		'field "permissionMode" has no effect in subagent: xpi has no permission modes',
	);
	for (const field of r.def.inert) assert.match(inertNotice(field), /has no effect in subagent: \S/);
});
