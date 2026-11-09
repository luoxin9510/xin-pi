// Faults only a scripted stream can produce on demand (fake pi, no model): bad stream records, crashes with stderr,
// provider-error retry sequences, children that never settle or never exit, exact usage and turn arithmetic.
// Everything real pi can show lives in test/real/.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { registry } from "../../../src/extensions/subagent/registry.ts";
import { type ChildHandle, runChild } from "../../../src/extensions/subagent/runner.ts";
import { agentFile, ev, FAKE_PI, happyLines, loadTool, sandbox, usage } from "../helpers.ts";

const fakeSpec = (cwd: string) => ({
	command: FAKE_PI,
	args: [],
	env: process.env as Record<string, string>,
	cwd,
	systemPrompt: { head: "x", tail: "y" },
	prefixKey: "k",
	prompt: "go",
	model: "m",
	thinking: "off",
	agentId: "fake",
	warnings: [],
});

test("10: completed run: output is the last assistant text, usage summed, turns counted", async () => {
	const s = sandbox();
	s.scenario({
		lines: [
			ev.session(),
			ev.user("go"),
			ev.assistant("looking", usage(100, 10, 0.5)),
			ev.tool("grep"),
			ev.turnEnd(),
			ev.assistant("", usage(50, 5, 0.25)), // tool-only message keeps the earlier text
			ev.tool("read"),
			ev.turnEnd(),
			ev.assistant("final answer", usage(10, 20, 0.25)),
			ev.turnEnd(),
			ev.settled(),
		],
	});
	const t = await loadTool({}, { cwd: s.repo });
	const r = (await t.run({})).structuredContent;
	assert.equal(r.status, "completed");
	assert.equal(r.output, "final answer");
	assert.equal(r.turns, 3);
	assert.equal(r.usage.input, 160);
	assert.equal(r.usage.output, 35);
	assert.equal(r.usage.cost.total, 1);
	assert.deepEqual(t.updates, ["test task: turn 1, grep", "test task: turn 2, read", "test task: turn 3, read"]);
});

test("11: maxTurns stops the child and returns partial", async () => {
	const s = sandbox();
	s.write(join(s.repo, ".pi/agents/short.md"), agentFile("name: short\ndescription: d\nmaxTurns: 2"));
	const turn = (n: number) => [ev.assistant(`turn ${n}`), ev.turnEnd()];
	s.scenario({ lines: [ev.session(), ...turn(1), ...turn(2), ...turn(3), ...turn(4)], delayMs: 50, hang: true });
	const t = await loadTool({}, { cwd: s.repo });
	const r = (await t.run({ subagent_type: "short" })).structuredContent;
	assert.equal(r.status, "partial");
	assert.equal(r.turns, 2);
	assert.equal(r.output, "turn 2");
});

test("after maxTurns, output of further turns is ignored when the run still settles", async () => {
	const s = sandbox();
	s.write(join(s.repo, ".pi/agents/one.md"), agentFile("name: one\ndescription: d\nmaxTurns: 1"));
	s.scenario({
		lines: [
			ev.session(),
			ev.assistant("turn 1", usage(10, 5, 0.01)),
			ev.turnEnd(),
			ev.assistant("turn 2", usage(20, 5, 0.02)),
			ev.turnEnd(),
			ev.settled(),
		],
	});
	const t = await loadTool({}, { cwd: s.repo });
	const r = (await t.run({ subagent_type: "one" })).structuredContent;
	assert.equal(r.output, "turn 1");
	assert.equal(r.turns, 1);
	assert.equal(r.usage.input, 30, "the cost of turns past the limit still counts");
});

test("maxTurns reached on a turn that called tools is partial, even if the next turn settles quickly", async () => {
	const s = sandbox();
	s.write(join(s.repo, ".pi/agents/one.md"), agentFile("name: one\ndescription: d\nmaxTurns: 1"));
	s.scenario({
		lines: [
			ev.session(),
			ev.assistant("reading a.txt", usage(10, 5, 0.01), { stopReason: "toolUse" }),
			ev.tool("read"),
			ev.turnEnd(),
			ev.assistant("turn 2", usage(20, 5, 0.02)),
			ev.turnEnd(),
			ev.settled(),
		],
	});
	const t = await loadTool({}, { cwd: s.repo });
	const r = (await t.run({ subagent_type: "one" })).structuredContent;
	assert.equal(r.status, "partial");
	assert.equal(r.turns, 1);
	assert.equal(r.output, "reading a.txt");
});

test("12: provider error, non-zero exit, garbage line, failed prompt response -> failed with error", async () => {
	const s = sandbox();
	const t = await loadTool({}, { cwd: s.repo });
	const cases: [Parameters<typeof s.scenario>[0], RegExp][] = [
		[
			{
				lines: [
					ev.session(),
					ev.assistant("", usage(1, 0, 0), { stopReason: "error", errorMessage: "529 overloaded" }),
					ev.turnEnd(),
					ev.settled(),
				],
			},
			/^529 overloaded$/,
		],
		[{ lines: [ev.session()], exitCode: 2, stderr: "line a\nboom: no API key\n" }, /boom: no API key/],
		[{ lines: [ev.session()], exitCode: 3 }, /pi exited with code 3/],
		[{ lines: [ev.session(), "not json at all", ...happyLines().slice(1)] }, /invalid JSON from pi: not json at all/],
		[{ lines: [], promptError: "No API key for anthropic" }, /^No API key for anthropic$/],
		[{ lines: [ev.session(), ev.assistant("hi")] }, /exited before the run settled/],
	];
	for (const [scenario, error] of cases) {
		s.scenario(scenario);
		const res = await t.run({});
		assert.equal(res.isError, true);
		assert.equal(res.structuredContent.status, "failed");
		assert.match(res.structuredContent.error, error);
	}
});

test("the prompt goes over stdin as an rpc prompt command, whatever its size", async () => {
	const s = sandbox();
	s.scenario({ lines: happyLines() });
	const t = await loadTool({}, { cwd: s.repo });
	const prompt = `@not-a-file ${"x".repeat(300_000)}`;
	const r = (await t.run({ prompt })).structuredContent;
	assert.equal(r.status, "completed");
	const rec = s.record();
	assert.ok(rec.argv.includes("rpc") && !rec.argv.includes("-p"));
	assert.ok(!rec.argv.some((a) => a.includes("xxxx")), "no prompt text in argv");
	assert.deepEqual(
		rec.commands.map((c) => c.type),
		["prompt"],
	);
	assert.equal(rec.commands[0]!.message, prompt);
});

test("maxTurns stops the child with an rpc abort; when it settles, no signal is needed", async () => {
	const s = sandbox();
	s.write(join(s.repo, ".pi/agents/one.md"), agentFile("name: one\ndescription: d\nmaxTurns: 1"));
	s.scenario({
		lines: [
			ev.session(),
			ev.assistant("t1", usage(10, 5, 0.01), { stopReason: "toolUse" }),
			ev.tool("read"),
			ev.turnEnd({ stopReason: "toolUse" }),
		],
		hang: true,
		abortSettles: true,
	});
	const t = await loadTool({}, { cwd: s.repo });
	const started = Date.now();
	const r = (await t.run({ subagent_type: "one" })).structuredContent;
	assert.equal(r.status, "partial");
	assert.deepEqual(
		s.record().commands.map((c) => c.type),
		["prompt", "abort"],
	);
	assert.ok(Date.now() - started < 3500, "abort settled the run; only the stdin-close grace was left");
});

test("12a: agent_settled with aborted: true -> failed with a clear error", async () => {
	const s = sandbox();
	s.scenario({
		lines: [ev.session(), ev.assistant("hi"), ev.turnEnd(), JSON.stringify({ type: "agent_settled", aborted: true })],
	});
	const t = await loadTool({}, { cwd: s.repo });
	const r = (await t.run({})).structuredContent;
	assert.equal(r.status, "failed");
	assert.equal(r.error, "child run was aborted");
});

test("13: U+2028 inside a JSON string does not split a record", async () => {
	const s = sandbox();
	const text = "line one line two end";
	s.scenario({ lines: [ev.session(), ev.assistant(text), ev.turnEnd(), ev.settled()] });
	const t = await loadTool({}, { cwd: s.repo });
	const r = (await t.run({})).structuredContent;
	assert.equal(r.status, "completed");
	assert.equal(r.output, text);
});

test("auto-retry: the outcome of the LAST assistant message decides, an earlier provider error is cleared", async () => {
	const s = sandbox();
	const retry = (type: string, extra: Record<string, unknown> = {}) => JSON.stringify({ type, ...extra });
	s.scenario({
		lines: [
			ev.session(),
			ev.assistant("", usage(1, 0, 0), { stopReason: "error", errorMessage: "529 overloaded" }),
			ev.turnEnd(),
			retry("agent_end", { willRetry: true }),
			retry("auto_retry_start", { attempt: 1 }),
			ev.assistant("the real answer"),
			ev.turnEnd(),
			retry("auto_retry_end", { success: true }),
			ev.settled(),
		],
	});
	const t = await loadTool({}, { cwd: s.repo });
	const r = (await t.run({})).structuredContent;
	assert.equal(r.status, "completed");
	assert.equal(r.output, "the real answer");
	assert.equal(r.error, undefined);
});

const failedTurn = [
	ev.assistant("", usage(1, 0, 0), { stopReason: "error", errorMessage: "529 overloaded" }),
	ev.turnEnd({ role: "assistant", stopReason: "error" }),
	JSON.stringify({ type: "agent_end", messages: [], willRetry: true }),
	JSON.stringify({ type: "auto_retry_start", attempt: 1 }),
	ev.assistant("recovered"),
	ev.turnEnd({ role: "assistant", stopReason: "stop" }),
	JSON.stringify({ type: "auto_retry_end", success: true }),
	ev.settled(),
];

test("a turn that ended in a provider error does not count toward maxTurns", async () => {
	const s = sandbox();
	s.write(join(s.repo, ".pi/agents/one.md"), agentFile("name: one\ndescription: d\nmaxTurns: 1"));
	s.scenario({ lines: [ev.session(), ...failedTurn] });
	const t = await loadTool({}, { cwd: s.repo });
	const r = (await t.run({ subagent_type: "one" })).structuredContent;
	assert.equal(r.status, "completed");
	assert.equal(r.output, "recovered");
	assert.equal(r.turns, 1);
});

test("a turn that ended in a provider error is not counted in turns", async () => {
	const s = sandbox();
	s.scenario({ lines: [ev.session(), ...failedTurn] });
	const t = await loadTool({}, { cwd: s.repo });
	const r = (await t.run({})).structuredContent;
	assert.equal(r.status, "completed");
	assert.equal(r.turns, 1);
});

test("a child that settles but never exits is stopped after a grace period and the run completes", async () => {
	const s = sandbox();
	s.scenario({ lines: happyLines("all done"), hang: true });
	const t = await loadTool({}, { cwd: s.repo });
	const started = Date.now();
	const r = (await t.run({})).structuredContent;
	assert.equal(r.status, "completed");
	assert.equal(r.output, "all done");
	assert.ok(Date.now() - started < 4500, "stopped after about 2 s");
});

test("a child that settles after an error and never exits fails with the error", async () => {
	const s = sandbox();
	s.scenario({
		lines: [
			ev.session(),
			ev.assistant("", usage(1, 0, 0), { stopReason: "error", errorMessage: "bad key" }),
			ev.turnEnd(),
			ev.settled(),
		],
		hang: true,
	});
	const t = await loadTool({}, { cwd: s.repo });
	const r = (await t.run({})).structuredContent;
	assert.equal(r.status, "failed");
	assert.equal(r.error, "bad key");
});

test("malformed records fail the run with the bad line named instead of throwing", async () => {
	const s = sandbox();
	const t = await loadTool({}, { cwd: s.repo });
	const bad = [
		"null",
		JSON.stringify({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "x" }], stopReason: "stop" },
		}),
		JSON.stringify({ type: "message_end" }),
	];
	for (const line of bad) {
		s.scenario({ lines: [ev.session(), line, ev.turnEnd(), ev.settled()], hang: true });
		const res = await t.run({});
		assert.equal(res.structuredContent.status, "failed", line);
		assert.ok(res.structuredContent.error.includes(line), `error names the line: ${res.structuredContent.error}`);
	}
});

test("set_model requests get unique ids, even in the same millisecond, and each is answered", async () => {
	const s = sandbox();
	s.scenario({ lines: [], hang: true });
	const ctl = new AbortController();
	const handle = await new Promise<ChildHandle>((resolve) => {
		runChild(fakeSpec(s.repo), ctl.signal, () => {}, resolve).catch(() => {});
	});
	const answers = await Promise.all([1, 2, 3, 4].map((n) => handle.setModel("anthropic", `m${n}`)));
	assert.deepEqual(answers, [undefined, undefined, undefined, undefined]);
	const ids = s
		.record()
		.commands.filter((c) => c.type === "set_model")
		.map((c: any) => c.id);
	assert.equal(ids.length, 4);
	assert.equal(new Set(ids).size, 4, `ids: ${ids}`);
	ctl.abort();
});

const until = async (ready: () => boolean) => {
	for (let i = 0; i < 300 && !ready(); i++) await new Promise((r) => setTimeout(r, 10));
};
const first = () => registry.list("parent-id")[0]!;

test("a run that finishes before the abort lands is not 'stopped'; its real result stands", async () => {
	const s = sandbox();
	s.scenario({ lines: [ev.session(), ev.assistant("fine"), ev.turnEnd(), ev.settled()], delayMs: 150 }); // ignores abort
	const t = await loadTool({}, { cwd: s.repo });
	const run = t.run({});
	await until(() => registry.list("parent-id").length > 0 && registry.handle(first().id) !== undefined);
	const id = first().id;
	assert.equal(registry.stop(id), true, "the abort was sent");
	const r = (await run).structuredContent;
	assert.equal(r.status, "completed");
	assert.equal(r.output, "fine");
	assert.equal(registry.get(id)!.status, "completed");
});

test("a stop that lands: failed 'stopped by user'; the handle takes no more commands once settled", async () => {
	const s = sandbox();
	s.scenario({
		lines: [ev.session(), ev.assistant("t1", usage(10, 5, 0.01), { stopReason: "toolUse" }), ev.tool("read")],
		hang: true,
		abortSettles: true,
	});
	const t = await loadTool({}, { cwd: s.repo });
	const run = t.run({});
	await until(
		() =>
			registry.list("parent-id").length > 0 &&
			first().lastTool !== undefined &&
			registry.handle(first().id) !== undefined,
	);
	const id = first().id;
	const handle = registry.handle(id)!;
	assert.equal(registry.stop(id), true);
	const r = (await run).structuredContent;
	assert.equal(r.status, "failed");
	assert.equal(r.error, "stopped by user");
	assert.equal(registry.get(id)!.status, "stopped");
	assert.equal(handle.send({ type: "steer", message: "late" }), false, "settled: no more commands");
});
