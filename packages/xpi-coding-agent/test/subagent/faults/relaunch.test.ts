// Spec 07: a workflow run records its Agent calls; a relaunch runs the script again and answers calls from the earlier
// run's saved results until the first one that failed, was running, or asks something else. Real codemode sandbox, the
// extension's Agent tool, fake children.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { endMessage } from "../../../src/extensions/subagent/background.ts";
import { registry } from "../../../src/extensions/subagent/registry.ts";
import { type Run, runs } from "../../../src/extensions/subagent/runs.ts";
import { startWorkflow } from "../../../src/extensions/subagent/workflow-run.ts";
import { runToRelaunch } from "../../../src/extensions/subagent/workflow-tool.ts";
import { parseWorkflow, type Workflow } from "../../../src/extensions/subagent/workflows.ts";
import { ev, loadTool, sandbox } from "../helpers.ts";

const ok = (text: string) => [ev.session(), ev.assistant(text), ev.turnEnd(), ev.settled()];
const failing = [
	ev.session(),
	ev.assistant("", undefined, { stopReason: "error", errorMessage: "529" }),
	ev.turnEnd(),
	ev.settled(),
];

const workflow = (name: string, body: string): Workflow => {
	const text = `export const meta = { name: '${name}', description: 'd' }\n${body}`;
	return { ...parseWorkflow(text, name), path: `/tmp/${name}.js`, source: "project" };
};
// Four agents in order; the script goes on past a failed one (agent() gives null).
const ABCD = (third = "task C") =>
	workflow(
		"abcd",
		`const out = [];
for (const p of ['task A', 'task B', ${JSON.stringify(third)}, 'task D']) out.push(await agent(p));
return JSON.stringify(out);`,
	);

let calls = 0;
async function setup(sessionId: string, saved = true) {
	const s = sandbox();
	const log = join(s.root, "starts.log");
	const scenario = (byPrompt: Record<string, string[]>) => s.scenario({ lines: ok("?"), byPrompt, logFile: log });
	const t = await loadTool(
		{ backgroundScripts: false },
		{ cwd: s.repo, sessionId, ...(saved ? { sessionFile: join(s.root, "parent.jsonl") } : {}) },
	);
	const session = { sessionFile: saved ? join(s.root, "parent.jsonl") : undefined, sessionId };
	const starts = () =>
		existsSync(log)
			? readFileSync(log, "utf8")
					.split("\n")
					.filter((l) => l === "start").length
			: 0;
	// Run a workflow in the foreground, as `xpi -p "/name"` does.
	const run = async (w: Workflow, args?: unknown, relaunchOf?: Run) => {
		const callId = `wf-${++calls}`;
		let n = 0;
		const ctx = {
			...t.ctx,
			tools: [t.tool],
			sessionManager: { ...t.ctx.sessionManager, getBranch: () => [] },
			executeTool: async (_name: string, args: unknown, { signal }: { signal?: AbortSignal }) => {
				const id = `${callId}/${++n}`;
				const toolCall = { type: "toolCall", id, name: "Agent", arguments: args };
				try {
					const result = await t.tool.execute(id, args, signal, undefined, t.ctx);
					return { toolCall, result, isError: result.isError === true };
				} catch (err) {
					return {
						toolCall,
						result: { content: [{ type: "text", text: (err as Error).message }] },
						isError: true,
					};
				}
			},
			detachNestedCalls: () => {},
			releaseNestedCalls: () => {},
		};
		const before = starts();
		const started = await startWorkflow(ctx as any, callId, w, args, false, relaunchOf);
		assert.equal(started.background, false);
		const text = (started as any).result.content.map((c: any) => c.text ?? "").join("");
		return { run: started.run, text, started: starts() - before };
	};
	return { s, t, session, scenario, run };
}
const ALL = { "task A": ok("a"), "task B": ok("b"), "task C": ok("c"), "task D": ok("d"), "edited third": ok("c2") };

test("a run is recorded: its calls in order, what each returned, and how it ended; the file is in the session's runs dir", async () => {
	const { s, session, scenario, run } = await setup("relaunch-1");
	scenario({ ...ALL, "task B": failing });
	const first = await run(ABCD(), { who: "x" });
	assert.equal(first.started, 4);
	assert.match(first.text, /\["a",null,"c","d"\]/);
	const file = JSON.parse(readFileSync(join(s.root, "subagents", "relaunch-1", "runs", "R1.json"), "utf8")) as Run;
	assert.equal(file.id, "R1");
	assert.equal(file.workflow, "abcd");
	assert.deepEqual(file.args, { who: "x" });
	assert.equal(file.state, "completed");
	assert.deepEqual(
		file.calls.map((c) => c.status),
		["completed", "failed", "completed", "completed"],
	);
	assert.equal(file.calls[0]!.result!.output, "a");
	assert.equal(runs.get(session, "R1")!.calls.length, 4);
});

test("relaunch: completed calls are answered from saved results until the first failed one; from there everything runs", async () => {
	const { session, scenario, run, s } = await setup("relaunch-2");
	scenario({ ...ALL, "task B": failing });
	const first = await run(ABCD());
	scenario(ALL);
	const again = await run(ABCD(), undefined, runToRelaunch(session, "abcd", first.run.id));
	assert.equal(again.started, 3, "A is not run again; B, C and D are, though C and D had completed");
	assert.match(again.text, /\["a","b","c","d"\]/);
	assert.equal(again.run.id, "R2");
	assert.equal(again.run.relaunchOf, "R1");
	assert.deepEqual(
		again.run.calls.map((c) => c.saved),
		["R1", undefined, undefined, undefined],
	);
	assert.equal(
		again.run.calls[0]!.result!.agentId,
		first.run.calls[0]!.result!.agentId,
		"the old agent, still there to continue",
	);
	assert.match(again.run.calls[0]!.result!.warnings.join(), /^$/, "the saved result itself is unchanged");
	const file = JSON.parse(readFileSync(join(s.root, "subagents", "relaunch-2", "runs", "R2.json"), "utf8")) as Run;
	assert.equal(file.relaunchOf, "R1");
});

test("relaunch: an edited script reruns from the first call that asks something else; an unchanged complete run is refused", async () => {
	const { session, scenario, run } = await setup("relaunch-3");
	scenario(ALL);
	const first = await run(ABCD());
	assert.equal(first.started, 4);
	assert.throws(() => runToRelaunch(session, "abcd", "R1"), /run R1 completed: nothing to relaunch/);
	assert.throws(() => runToRelaunch(session, "abcd", "R9"), /nothing to resume: no saved results for run R9/);
	assert.throws(
		() => runToRelaunch(session, "other", "R1"),
		/run R1 completed|is a run of workflow "abcd", not "other"/,
	);
	// The same run, relaunched by hand with an edited third prompt (the check above is what the entry points use).
	const edited = await run(ABCD("edited third"), undefined, runs.get(session, "R1"));
	assert.equal(edited.started, 2, "A and B come from saved results; the changed C and everything after it run");
	assert.match(edited.text, /\["a","b","c2","d"\]/);
});

test("relaunch of a relaunch; a run with a failed call can be relaunched though its script completed", async () => {
	const { session, scenario, run } = await setup("relaunch-4");
	scenario({ ...ALL, "task B": failing });
	await run(ABCD());
	scenario({ ...ALL, "task C": failing });
	const second = await run(ABCD(), undefined, runToRelaunch(session, "abcd", "R1"));
	assert.equal(second.started, 3);
	scenario(ALL);
	const third = await run(ABCD(), undefined, runToRelaunch(session, "abcd", "R2"));
	assert.equal(third.started, 2, "A (saved twice over) and B come from saved results");
	assert.equal(third.run.relaunchOf, "R2");
	assert.match(third.text, /\["a","b","c","d"\]/);
});

test("a rerun call takes over the name its agent of the earlier run holds", async () => {
	const { session, scenario, run } = await setup("relaunch-5");
	const named = workflow(
		"named",
		"const r = await tools.Agent({ name: 'worker', description: 'w', prompt: 'task B' });\nreturn r.status;",
	);
	scenario({ "task B": failing });
	const first = await run(named);
	assert.match(first.text, /failed/);
	const old = first.run.calls[0]!.result!.agentId;
	assert.equal(registry.named("relaunch-5", "worker"), old);
	scenario(ALL);
	const again = await run(named, undefined, runToRelaunch(session, "named", "R1"));
	assert.match(again.text, /completed/);
	const fresh = again.run.calls[0]!.result!.agentId;
	assert.notEqual(fresh, old);
	assert.equal(registry.named("relaunch-5", "worker"), fresh);
	assert.equal(registry.get(old)!.name, undefined, "the old agent keeps its id and loses the name");
});

test("an in-memory session keeps its runs for the life of the process; nothing is written", async () => {
	const { s, session, scenario, run } = await setup("relaunch-6", false);
	scenario({ ...ALL, "task D": failing });
	await run(ABCD());
	scenario(ALL);
	const again = await run(ABCD(), undefined, runToRelaunch(session, "abcd", "R1"));
	assert.equal(again.started, 1, "only D runs");
	assert.equal(existsSync(join(s.root, "subagents")), false);
});

test("the Workflow tool relaunches by run id, with the run's args; the end message of a failed run says how", async () => {
	const { s, session, scenario, run, t } = await setup("relaunch-7");
	s.write(
		join(s.repo, ".pi/workflows/echo.js"),
		"export const meta = { name: 'echo', description: 'd' }\nconst r = await agent('task ' + args.letter);\nreturn 'got ' + r;",
	);
	const loaded = await loadTool(
		{ backgroundScripts: false },
		{ cwd: s.repo, sessionId: "relaunch-7", sessionFile: join(s.root, "parent.jsonl") },
	);
	scenario({ "task B": failing });
	const echo = {
		...parseWorkflow(readFileSync(join(s.repo, ".pi/workflows/echo.js"), "utf8"), "echo"),
		path: "x",
		source: "project" as const,
	};
	const first = await run(echo, { letter: "B" });
	assert.match(first.text, /got null/);
	scenario(ALL);
	const toolCtx = {
		...loaded.ctx,
		tools: [loaded.tool],
		sessionManager: { ...loaded.ctx.sessionManager, getBranch: () => [] },
		executeTool: async (_n: string, args: unknown, { signal }: { signal?: AbortSignal }) => {
			const result = await loaded.tool.execute("wf-tool/1", args, signal, undefined, loaded.ctx);
			return {
				toolCall: { type: "toolCall", id: "wf-tool/1", name: "Agent", arguments: args },
				result,
				isError: false,
			};
		},
		detachNestedCalls: () => {},
		releaseNestedCalls: () => {},
	};
	const tool = loaded.tools.Workflow;
	await assert.rejects(
		tool.execute("wf-tool", { name: "echo", relaunch: "R1", args: { letter: "C" } }, undefined, undefined, toolCtx),
		/a relaunch uses the args of the run it relaunches/,
	);
	await assert.rejects(
		tool.execute("wf-tool", { name: "echo", relaunch: "R7" }, undefined, undefined, toolCtx),
		/nothing to resume/,
	);
	const result = await tool.execute("wf-tool", { name: "echo", relaunch: "R1" }, undefined, undefined, toolCtx);
	assert.match(
		result.content.map((c: any) => c.text).join(""),
		/got b/,
		"the run's own args ({ letter: 'B' }) were used",
	);
	assert.equal(runs.get(session, "R2")!.relaunchOf, "R1");
	void t;

	const message = endMessage(
		{
			id: "S3",
			callId: "c",
			workflow: "echo",
			run: "R1",
			saved: 2,
			sessionId: "p",
			state: "failed",
			stopRequested: false,
			pinned: false,
			agents: [],
			members: [],
			phases: {},
			calls: [],
			logs: [],
			startedAt: 0,
		},
		"failed",
		"boom",
		{ sessionFile: undefined, sessionId: "p" },
	);
	assert.match(message, /^Background script S3 \(workflow echo, run R1\) failed\./);
	assert.match(message, /Answered from saved results: 2/);
	assert.match(message, /Relaunch it with Workflow\(\{ name: "echo", relaunch: "R1" \}\)/);
	const done = endMessage(
		{
			id: "S4",
			callId: "c",
			workflow: "echo",
			run: "R2",
			sessionId: "p",
			state: "completed",
			stopRequested: false,
			pinned: false,
			agents: [],
			members: [],
			phases: {},
			calls: [],
			logs: [],
			startedAt: 0,
		},
		"completed",
		"ok",
		{ sessionFile: undefined, sessionId: "p" },
	);
	assert.doesNotMatch(done, /Relaunch/);
});
