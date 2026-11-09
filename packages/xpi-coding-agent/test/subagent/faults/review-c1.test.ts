// Review fix C1: the process-wide script controller feeds every connected extension instance. An instance must only act on
// its own session's scripts and must be silent after it disconnects (session shutdown).
import assert from "node:assert/strict";
import { test } from "node:test";
import { beginCodemodeScript, codemodeScripts } from "../../../src/extensions/codemode/scripts.ts";
import { scripts } from "../../../src/extensions/subagent/background.ts";

const link = (session: string, got: string[]) => ({
	sessionId: () => session,
	enabled: () => true,
	deliver: (c: string) => void got.push(c),
	parent: () => ({ sessionFile: undefined, sessionId: session }),
});

test("C1: a background script's end is delivered only to the instance of its own session", async () => {
	const a: string[] = [];
	const b: string[] = [];
	const offA = scripts.connect(link("c1-a", a));
	const offB = scripts.connect(link("c1-b", b));
	const run = beginCodemodeScript("c1-call", "c1-a", undefined);
	assert.equal(scripts.list("c1-a").length, 1);
	assert.equal(scripts.list("c1-b").length, 0);
	codemodeScripts.background(run.info.id);
	run.end({ result: { content: [{ type: "text", text: "hi" }], details: {} } });
	assert.equal(a.length, 1);
	assert.equal(b.length, 0);
	offA();
	offB();
});

test("C1: after disconnect (session_shutdown) an old script's end reaches nobody, not even a new connection", () => {
	const old: string[] = [];
	const fresh: string[] = [];
	const offOld = scripts.connect(link("c1-s", old));
	const run = beginCodemodeScript("c1-old", "c1-s", undefined);
	codemodeScripts.background(run.info.id);
	offOld(); // session_shutdown
	const offNew = scripts.connect(link("c1-s", fresh)); // /new or reload: same session id may even be reused
	run.end({ result: { content: [{ type: "text", text: "late" }], details: {} } });
	assert.deepEqual(old, []);
	assert.deepEqual(fresh, []);
	assert.equal(scripts.list("c1-s")[0].state, "stopped", "the row is closed at disconnect");
	offNew();
});
