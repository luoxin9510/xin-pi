// Review fix B4: a provider that reuses a codemode call id must not let a new script take over an old one's mover/stopper
// (the controller picks the newest script for an id, and stops by script id).
import assert from "node:assert/strict";
import { test } from "node:test";
import { scripts } from "../../../src/extensions/subagent/background.ts";
import { registry } from "../../../src/extensions/subagent/registry.ts";
import { codemodeStandIn, ev, loadTool, sandbox, usage } from "../helpers.ts";

const until = async (what: string, pred: () => boolean, ms = 8000) => {
	const t0 = Date.now();
	while (!pred()) {
		if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 20));
	}
};
const hang = () => ({
	lines: [ev.session(), ev.assistant("t1", usage(10, 5, 0.01), { stopReason: "toolUse" }), ev.tool("read")],
	hang: true,
	abortSettles: true,
});

test("B4: two scripts with the same call id: owner is the newest, and stopping the old one stops only it", async () => {
	const s = sandbox();
	s.scenario(hang());
	const t = await loadTool({ maxConcurrent: 5 }, { cwd: s.repo, sessionId: "b4" });
	const w = codemodeStandIn(t);
	const script = async ({ agent }: { agent: () => Promise<unknown> }) => (await agent(), "done");
	await w.run("dup", script);
	const [a] = scripts.list("b4");
	await until("a's agent running", () => a.agents.length === 1 && registry.handle(a.agents[0]) !== undefined);
	await w.run("dup", script);
	const b = scripts.list("b4").find((x) => x.id !== a.id)!;
	await until("b's agent running", () => b.agents.length === 1 && registry.handle(b.agents[0]) !== undefined);
	assert.equal(scripts.owner("dup/1"), b, "the newest active script owns the id");
	assert.equal(await scripts.stop(a.id), true);
	await until("a stopped", () => a.state === "stopped");
	assert.equal(registry.get(a.agents[0])!.status, "stopped");
	assert.equal(b.state, "background", "the other script is untouched");
	assert.equal(registry.get(b.agents[0])!.status, "running");
	assert.equal(await scripts.stop(b.id), true);
	await until("b stopped", () => b.state === "stopped");
});
