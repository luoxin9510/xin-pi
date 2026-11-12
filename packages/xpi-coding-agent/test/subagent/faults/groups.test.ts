// Spec 09: the script registry's side of a group, driven directly (no children): the signal each agent of a script runs
// on, and how a stop reaches agents that are not resolved yet. The whole flow runs in
// test/suite/subagent-release-groups.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { beginCodemodeScript, codemodeScripts } from "../../../src/extensions/codemode/scripts.ts";
import { scripts } from "../../../src/extensions/subagent/background.ts";
import { loadTool, sandbox } from "../helpers.ts";

let n = 0;

// A script of the loaded session whose code has ended with one call still running: it is kept, and its group formed.
async function keptScript(given?: { t: Awaited<ReturnType<typeof loadTool>>; callId: string }) {
	const t = given?.t ?? (await loadTool({}, { cwd: sandbox().repo, sessionId: `groups-${++n}` }));
	const callId = given?.callId ?? `groups-call-${++n}`;
	const run = beginCodemodeScript(callId, t.ctx.sessionManager.getSessionId(), undefined);
	const callSignal = new AbortController();
	// An agent of the script while its code runs: it follows the call's signal until the end.
	const early = scripts.join(`${callId}/1`, { description: "early" }, callSignal.signal)!;
	assert.ok(early);
	let settle!: () => void;
	const settled = new Promise<{ toolCallId: string }>((resolve) => {
		settle = () => resolve({ toolCallId: `${callId}/2` });
	});
	assert.equal(
		codemodeScripts.keep(run.info.id, { reason: "returned", calls: [{ name: "Agent", args: {}, settled }] }),
		true,
	);
	run.end({ result: { content: [{ type: "text", text: "1" }], details: {} } });
	const script = scripts.get(run.info.id)!;
	return { t, callId, script, early, callSignal, settle };
}

test("an agent no longer follows its call's signal once the script's code has ended", async () => {
	const { script, early, callSignal, settle } = await keptScript();
	assert.equal(script.state, "ended");
	callSignal.abort();
	assert.equal(early.signal.aborted, false);
	early.end(undefined, "done");
	settle();
});

test("a stop reaches the group's agents that are not resolved yet, and those that resolve after it", async () => {
	const { callId, script, early, settle } = await keptScript();
	// A call the script left running reaches Agent's execute after the end.
	const late = scripts.join(`${callId}/2`, { description: "late" }, undefined)!;
	assert.equal(late.call.runningAtEnd, true);
	await scripts.stop(script.id);
	assert.equal(early.signal.aborted, true); // not resolved: no record a stop could reach
	assert.equal(late.signal.aborted, true);
	early.end(undefined, "stopped");
	late.end(undefined, "stopped");
	settle();
});

test("an agent that resolves after its group's script was stopped is aborted when it resolves", async () => {
	const { callId, script, early, settle } = await keptScript();
	const late = scripts.join(`${callId}/2`, { description: "late" }, undefined)!;
	script.stopRequested = true; // the stop has begun; the agent resolves now
	late.started("agent-late");
	assert.equal(late.signal.aborted, true);
	late.end(undefined, "stopped");
	early.end(undefined, "stopped");
	settle();
});

test("two kept scripts with the same call id: the end of one group releases only its own script", async () => {
	const first = await keptScript();
	const second = await keptScript({ t: first.t, callId: first.callId });
	assert.notEqual(first.script.id, second.script.id);
	assert.equal(second.script.state, "ended");
	first.early.end(undefined, "done");
	first.settle();
	await new Promise((r) => setTimeout(r, 20));
	assert.notEqual(first.script.state, "ended"); // its group ended
	assert.equal(second.script.state, "ended"); // still kept: its call and agent run
	assert.ok(codemodeScripts.list().some((s) => s.id === second.script.id));
	assert.ok(!codemodeScripts.list().some((s) => s.id === first.script.id));
	second.early.end(undefined, "done");
	second.settle();
});

test("a member that ended between the sandbox's end and the keep still counts as running at the end (its output is shown)", async () => {
	const t = await loadTool({}, { cwd: sandbox().repo, sessionId: `groups-${++n}` });
	const callId = `groups-call-${++n}`;
	const run = beginCodemodeScript(callId, t.ctx.sessionManager.getSessionId(), undefined);
	const member = scripts.join(`${callId}/1`, { description: "quick" }, undefined)!;
	// Its agent ended after the sandbox released the call, before the host reported the keep.
	member.end({
		status: "completed",
		agentType: "general-purpose",
		output: "quick done",
		usage: { cost: { total: 0 } },
	});
	assert.equal(member.call.runningAtEnd, false);
	let settle!: () => void;
	const settled = new Promise<{ toolCallId: string }>((resolve) => {
		settle = () => resolve({ toolCallId: `${callId}/1` });
	});
	codemodeScripts.keep(run.info.id, { reason: "returned", calls: [{ name: "Agent", args: {}, settled }] });
	run.end({ result: { content: [{ type: "text", text: "1" }], details: {} } });
	settle();
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(member.call.runningAtEnd, true);
	const message = t.messages.map((m) => String(m.message.content)).find((c) => c.includes("Output of"));
	assert.match(message ?? "", /quick done/);
});
