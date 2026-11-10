// Restarting a running agent (spec 06): its child is stopped and started over with the same task, the call that waits
// for it gets the last start's result, the earlier session is kept aside, and turns and cost add up.
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Panel } from "../../../src/extensions/subagent/panel.ts";
import { registry } from "../../../src/extensions/subagent/registry.ts";
import { ev, flag, loadTool, sandbox, usage } from "../helpers.ts";

const until = async (what: string, pred: () => boolean, ms = 8000) => {
	const t0 = Date.now();
	while (!pred()) {
		if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 20));
	}
};
// One turn done, then it hangs in a tool call until it is told to stop.
const stuck = () => ({
	lines: [
		ev.session(),
		ev.assistant("thinking", usage(10, 5, 0.01), { stopReason: "toolUse" }),
		ev.tool("bash"),
		ev.turnEnd({ stopReason: "toolUse" }),
	],
	hang: true,
	abortSettles: true,
});
const fine = (text: string) => ({
	lines: [ev.session(), ev.assistant(text, usage(10, 5, 0.02)), ev.turnEnd(), ev.settled()],
});

async function setup(sessionId: string) {
	const s = sandbox();
	s.scenario(stuck());
	const t = await loadTool({}, { cwd: s.repo, sessionFile: join(s.root, "parent.jsonl"), sessionId });
	const running = async () => {
		await until("a running child", () => registry.list(sessionId).some((r) => registry.handle(r.id) !== undefined));
		return registry.list(sessionId).find((r) => registry.handle(r.id) !== undefined)!.id;
	};
	return { s, t, running, dir: join(s.root, "subagents", sessionId) };
}

test("restart: the agent starts over with the same task; its call gets the second start's result", async () => {
	const { s, t, running, dir } = await setup("restart-1");
	const call = t.run({ name: "worker", description: "slow job", prompt: "do the job" });
	const id = await running();
	await until("the first turn", () => registry.get(id)!.turns === 1);
	// What the child would have written by now.
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `2026-11-10T00-00-00-000Z_${id}.jsonl`), '{"type":"session"}\n');
	assert.equal(registry.restartRefusal(id), undefined);

	s.scenario(fine("second start"));
	assert.equal(registry.restart(id), undefined);
	const r = (await call).structuredContent;
	assert.equal(r.status, "completed");
	assert.equal(r.output, "second start");
	assert.equal(r.agentId, id, "the same agent");
	assert.equal(r.turns, 2, "turns of both starts");
	assert.ok(Math.abs(r.usage.cost.total - 0.03) < 1e-9, `cost of both starts, got ${r.usage.cost.total}`);

	const rec = s.record();
	assert.equal(rec.commands.find((c) => c.type === "prompt")?.message, "do the job", "the same prompt");
	assert.equal(flag(rec.argv, "--session-id"), id);
	assert.deepEqual(
		readdirSync(dir).filter((f) => f.includes(".jsonl")),
		[`${id}.restart-1.jsonl.bak`],
		"the first start's session is kept aside, out of the next start's way",
	);
	const record = registry.get(id)!;
	assert.equal(record.status, "completed");
	assert.equal(record.name, "worker");
	assert.equal(record.turns, 2);
	assert.ok(Math.abs(record.usage.cost.total - 0.03) < 1e-9);
	assert.equal(t.messages.length, 0, "nothing is reported to main for the restart");
});

test("restart is refused for an agent that is not running, and for one that was continued", async () => {
	const { s, t, running } = await setup("restart-2");
	s.scenario(fine("done"));
	const first = (await t.run({})).structuredContent;
	assert.equal(registry.restart(first.agentId), "the subagent is not running");
	assert.equal(registry.restart("nobody"), "the subagent is not running");

	s.scenario(stuck());
	const continued = t.run({ resume: first.agentId, prompt: "more" });
	const id = await running();
	assert.equal(id, first.agentId);
	assert.equal(registry.restart(id), "only an agent's first run can be restarted; this one was continued");
	registry.stop(id);
	assert.equal((await continued).structuredContent.status, "failed");
});

test("a fork cannot be restarted", () => {
	registry.begin({ thinking: "off", cwd: "/tmp", trusted: true, sessionId: "restart-3" } as any, {
		id: "restart-3-fork",
		type: "fork",
		description: "side task",
		model: "m",
		thinking: "off",
	});
	registry.attach("restart-3-fork", { send: () => true, setModel: async () => undefined } as any);
	assert.match(registry.restart("restart-3-fork")!, /a fork cannot be restarted/);
	registry.finish("restart-3-fork", "stopped");
});

test("panel: r on a running agent's row restarts it; the hint shows only where it applies", () => {
	const sent: string[] = [];
	const parent = { thinking: "off", cwd: "/tmp", trusted: true, sessionId: "restart-4" } as any;
	registry.begin(parent, { id: "restart-4-a", type: "Explore", description: "one", model: "m", thinking: "off" });
	registry.attach("restart-4-a", {
		send: (c: { type: string }) => (sent.push(c.type), true),
		setModel: async () => undefined,
	} as any);
	registry.begin(parent, { id: "restart-4-b", type: "Explore", description: "two", model: "m", thinking: "off" });
	registry.finish("restart-4-b", "completed");
	const theme: any = { fg: (_c: string, x: string) => x, bg: (_c: string, x: string) => x, bold: (x: string) => x };
	const panel = new Panel(
		"restart-4",
		theme,
		() => {},
		() => {},
		{ lingerMs: 30_000, viewable: true },
	);
	assert.equal(panel.handleKey("r", true), false, "not focused: the key belongs to pi");
	panel.handleKey("\x1b[B", true);
	assert.match(panel.render(200).at(-1)!, /x stop · r restart · X stop all/);
	assert.equal(panel.handleKey("r", true), true);
	assert.deepEqual(sent, ["abort"]);
	assert.equal(registry.restartRequested("restart-4-a"), true);
	panel.handleKey("\x1b[B", true); // the finished row
	assert.doesNotMatch(panel.render(200).at(-1)!, /r restart/);
	assert.equal(panel.handleKey("r", true), false, "nothing to restart: the key goes to pi");
	assert.deepEqual(sent, ["abort"]);
	panel.dispose();
	registry.finish("restart-4-a", "stopped");
});
