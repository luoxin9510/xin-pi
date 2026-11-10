// Spec 07 on real haiku: a workflow run is stopped while its third agent works; a relaunch answers the first two from
// the saved results (no child starts for them) and runs the third.
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { codemodeScripts } from "../../../src/extensions/codemode/scripts.ts";
import { registry } from "../../../src/extensions/subagent/registry.ts";
import { type Run, runs } from "../../../src/extensions/subagent/runs.ts";
import { startWorkflow } from "../../../src/extensions/subagent/workflow-run.ts";
import { runToRelaunch } from "../../../src/extensions/subagent/workflow-tool.ts";
import { parseWorkflow } from "../../../src/extensions/subagent/workflows.ts";
import { loadTool, sandbox } from "./helpers.ts";

const WORKFLOW = `export const meta = { name: 'three', description: 'Three agents in a row' }
const a = await agent('Reply with exactly the word ALPHA. Do not call any tool.');
const b = await agent('Reply with exactly the word BRAVO. Do not call any tool.');
const c = await agent('Run the bash command \`sleep 8\`. After it ends, reply with exactly the word CHARLIE.');
return [a, b, c].join(' ');
`;

test("a stopped run is relaunched: finished agents come from saved results, the unfinished one runs", async () => {
	const s = sandbox();
	const t = await loadTool({ backgroundScripts: false }, { cwd: s.repo, persist: join(s.root, "sessions") });
	const workflow = { ...parseWorkflow(WORKFLOW, "three"), path: "three.js", source: "project" as const };
	const session = { sessionFile: t.ctx.sessionManager.getSessionFile(), sessionId: t.sessionId };
	let wf = 0;
	const start = (relaunchOf?: Run) => {
		const callId = `real-wf-${++wf}`;
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
		return startWorkflow(ctx as any, callId, workflow, undefined, false, relaunchOf);
	};
	const sessions = () => readdirSync(t.sessionDir!).filter((f) => f.endsWith(".jsonl")).length;

	// First run: stop it once the third agent is at work.
	const first = start();
	for (const end = Date.now() + 120_000; ; ) {
		const run = runs.list(session)[0];
		const third =
			run?.calls.length === 3 && registry.list(t.sessionId).some((r) => r.status === "running" && r.turns >= 1);
		if (third) break;
		if (Date.now() > end) throw new Error("timed out waiting for the third agent");
		await new Promise((r) => setTimeout(r, 50));
	}
	const running = registry
		.list(t.sessionId)
		.filter((r) => r.status === "running")
		.map((r) => r.id);
	await registry.stopAll(running);
	await codemodeScripts.stopAll(t.sessionId);
	await first.catch(() => {});
	const r1 = runs.get(session, "R1")!;
	assert.deepEqual(
		r1.calls.map((c) => c.status),
		["completed", "completed", "failed"],
	);
	const before = sessions();
	assert.equal(before, 3);

	// The relaunch: one new child, for the third call only.
	const again = await start(runToRelaunch(session, "three", "R1"));
	assert.equal(again.background, false);
	const text = (again as any).result.content.map((c: any) => c.text ?? "").join("");
	assert.match(text, /ALPHA BRAVO CHARLIE/, text);
	assert.deepEqual(
		again.run.calls.map((c) => c.saved),
		["R1", "R1", undefined],
	);
	assert.equal(again.run.calls[0]!.result!.agentId, r1.calls[0]!.result!.agentId);
	assert.equal(sessions(), before + 1, "exactly one new agent ran");
});
