// Spec 09 PR 2, stalls and status: the registry marks a running child quiet for subagent.stallMs as stalled (the clock
// starts when its process starts), the next event clears the mark, the panel row and the `subagents` status show it,
// and the user is told. Real registry, no pi and no model.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readConfig } from "../../../src/extensions/subagent/config.ts";
import { Panel } from "../../../src/extensions/subagent/panel.ts";
import { registry, stalledLabel } from "../../../src/extensions/subagent/registry.ts";
import { checkStalls, statusText } from "../../../src/extensions/subagent/waiting.ts";

const theme: any = {
	fg: (c: string, s: string) => (c === "warning" ? `<w>${s}</w>` : s),
	bg: (_c: string, s: string) => s,
};
const parent = (sessionId: string) => ({ thinking: "off", cwd: "/tmp", trusted: true, sessionId });
const handle: any = { send: () => true, setModel: async () => undefined };
const begin = (sessionId: string, id: string) =>
	registry.begin(parent(sessionId), { id, type: "Explore", description: `${id} task`, model: "m", thinking: "off" });
const MIN = 60_000;
const event = { type: "turn_start" } as any;

test("subagent.stallMs: default 600000, 0 turns it off, a negative or non-number value is refused", () => {
	assert.equal(readConfig({}).stallMs, 600_000);
	assert.equal(readConfig({ stallMs: 0 }).stallMs, 0);
	assert.equal(readConfig({ stallMs: 1234 }).stallMs, 1234);
	for (const bad of [-1, "600000", Number.NaN, Number.POSITIVE_INFINITY])
		assert.throws(() => readConfig({ stallMs: bad }), /subagent\.stallMs/);
});

test("the clock starts when the child's process starts: an agent waiting for a slot is never stalled", () => {
	begin("st1", "q1");
	const t0 = Date.now();
	assert.deepEqual(registry.checkStalls("st1", 10 * MIN, t0 + 60 * MIN), [], "no process yet: not stalled");
	registry.attach("q1", handle);
	assert.deepEqual(registry.checkStalls("st1", 10 * MIN, Date.now() + 9 * MIN), [], "quiet for less than stallMs");
	const marked = registry.checkStalls("st1", 10 * MIN, Date.now() + 10 * MIN);
	assert.deepEqual(
		marked.map((r) => r.id),
		["q1"],
	);
	registry.finish("q1", "completed");
});

test("marked once, cleared by the next event, marked again after another quiet stretch; stallMs 0 never marks", () => {
	begin("st2", "s1");
	registry.attach("s1", handle);
	let changes = 0;
	const off = registry.subscribe(() => changes++);
	assert.deepEqual(registry.checkStalls("st2", 0, Date.now() + 600 * MIN), [], "0: off");
	const later = Date.now() + 11 * MIN;
	assert.equal(registry.checkStalls("st2", 10 * MIN, later).length, 1);
	assert.ok(changes > 0, "a new mark is a record change (the panel and the status redraw)");
	assert.equal(registry.checkStalls("st2", 10 * MIN, later + MIN).length, 0, "already marked: not new");
	assert.ok(registry.stalledFor("s1", later)! >= 11 * MIN - 1000);
	const before = changes;
	registry.event("s1", event);
	assert.equal(registry.stalledFor("s1"), undefined, "activity clears the mark");
	assert.ok(changes > before, "clearing it is a record change");
	// The check ran on a clock 11 minutes ahead, the event on the real one: the stall's length here is about 0.
	assert.notEqual(registry.longestStallOf("s1"), undefined, "the stall it had is remembered");
	assert.equal(registry.checkStalls("st2", 10 * MIN, Date.now() + 10 * MIN).length, 1, "quiet again: marked again");
	off();
	registry.finish("s1", "completed");
	assert.equal(registry.stalledFor("s1"), undefined, "a finished agent is not stalled");
	assert.notEqual(registry.longestStallOf("s1"), undefined, "the latest exchange's stall stays after it ends");
	begin("st2", "s1");
	assert.equal(registry.longestStallOf("s1"), undefined, "a new exchange starts with none");
	registry.finish("s1", "completed");
});

test("a session's check marks only its own agents", () => {
	begin("st3a", "o1");
	registry.attach("o1", handle);
	begin("st3b", "o2");
	registry.attach("o2", handle);
	const later = Date.now() + 20 * MIN;
	assert.deepEqual(
		registry.checkStalls("st3a", 10 * MIN, later).map((r) => r.id),
		["o1"],
	);
	assert.equal(registry.stalledFor("o2", later), undefined);
	assert.deepEqual(
		registry.checkStalls("st3b", 10 * MIN, later).map((r) => r.id),
		["o2"],
	);
	registry.finish("o1", "completed");
	registry.finish("o2", "completed");
});

test("the user is told once per stall, with the last tool; the panel row says `stalled Nm`; the status counts it", () => {
	begin("st4", "n1");
	registry.attach("n1", handle);
	registry.progress("n1", { turns: 2, lastTool: "bash" });
	const panel = new Panel(
		"st4",
		theme,
		() => {},
		() => {},
		{ lingerMs: 30_000, viewable: true },
	);
	assert.ok(!panel.render(120).join("\n").includes("stalled"));
	assert.equal(statusText("st4"), "1 agent running");
	const told: string[] = [];
	const later = Date.now() + 12 * MIN;
	checkStalls("st4", 10 * MIN, (m) => told.push(m), later);
	checkStalls("st4", 10 * MIN, (m) => told.push(m), later + MIN);
	assert.equal(told.length, 1, "once per stall");
	assert.match(told[0]!, /n1 Explore\(n1 task\) has done nothing for 10m \(last tool: bash\)/);
	const row = panel.render(120).join("\n");
	assert.match(row, /bash · <w>stalled \d+[sm]<\/w>/, row);
	assert.equal(statusText("st4"), "1 agent running · 1 stalled");
	registry.event("n1", event);
	assert.ok(!panel.render(120).join("\n").includes("stalled"), "cleared on activity");
	registry.finish("n1", "completed");
	assert.equal(statusText("st4"), undefined, "nothing runs: no status");
	panel.dispose();
});

test("stalledLabel: seconds under a minute, else whole minutes; the notice says the same", () => {
	assert.equal(stalledLabel(10 * MIN + 59_000), "stalled 10m");
	assert.equal(stalledLabel(59_900), "stalled 59s");
	begin("st5", "n5");
	registry.attach("n5", handle);
	const told: string[] = [];
	checkStalls("st5", 30_000, (m) => told.push(m), Date.now() + MIN);
	assert.match(told[0]!, /has done nothing for 30s; it keeps running, x in the panel \(TUI\) stops it/);
	registry.finish("n5", "completed");
});

test("a new process (a restart) ends the stall of the one before", () => {
	begin("st6", "r6");
	registry.attach("r6", handle);
	assert.equal(registry.checkStalls("st6", 10 * MIN, Date.now() + 11 * MIN).length, 1);
	registry.attach("r6", handle);
	assert.equal(registry.stalledFor("r6"), undefined);
	assert.notEqual(registry.longestStallOf("r6"), undefined, "its stall is remembered");
	registry.finish("r6", "completed");
});
