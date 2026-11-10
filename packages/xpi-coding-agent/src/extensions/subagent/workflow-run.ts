// Running a saved workflow: its script starts as a codemode script, from a `/name` command (a tool context the command
// creates, `ctx.createToolContext`) or from the Workflow tool (that call's own context). With a UI it moves to the
// background at once, and its end reaches main like any background script's (background.ts). Without one (print mode,
// or subagent.backgroundScripts: false) it runs in the foreground and the caller gets its result.

import type { AgentToolResult } from "xpi-agent-core";
import type { ExtensionCommandContext, ExtensionToolContext } from "../../core/extensions/types.ts";
import { loadCodemodeExecutor } from "../codemode/execute.lazy.ts";
import { codemodeScripts } from "../codemode/scripts.ts";
import { type Run, runs as workflowRuns } from "./runs.ts";
import type { Workflow } from "./workflows.ts";

const WORKFLOW_CALL_PREFIX = "workflow:";
let runs = 0;
// Runs started by the Workflow tool keep the tool call's id, which does not carry the name.
const named = new Map<string, string>();

// The workflow a script's codemode call id runs, if a workflow started it.
export function workflowOf(toolCallId: string): string | undefined {
	const name = named.get(toolCallId);
	if (name !== undefined) return name;
	if (!toolCallId.startsWith(WORKFLOW_CALL_PREFIX)) return undefined;
	return toolCallId.slice(WORKFLOW_CALL_PREFIX.length).split(":")[0];
}

export const workflowStartText = (name: string, scriptId: string, run?: Run) =>
	`Workflow ${name} started as background script ${scriptId}${
		run ? ` (run ${run.id}${run.relaunchOf ? `, a relaunch of ${run.relaunchOf}` : ""})` : ""
	}. Its result arrives as a message when it ends.`;

export type WorkflowStart =
	| { background: true; scriptId: string; run: Run }
	| { background: false; result: AgentToolResult<unknown>; run: Run };

// A /name command's run: a call id made for it, and a tool context the command creates.
export function startWorkflowCommand(
	ctx: ExtensionCommandContext,
	workflow: Workflow,
	args: unknown,
	background: boolean,
	relaunchOf?: Run,
): Promise<WorkflowStart> {
	const id = `${WORKFLOW_CALL_PREFIX}${workflow.meta.name}:${Date.now().toString(36)}-${++runs}`;
	return startWorkflow(ctx.createToolContext(id), id, workflow, args, background, relaunchOf);
}

// Start a workflow's script under `id` (the codemode call id its nested calls hang off). `args` reaches the script as a
// global, set on the body's first line (the `meta` statement left it empty), so line numbers stay the file's.
// The run is recorded (runs.ts); with `relaunchOf`, its Agent calls are answered from that run's saved results while
// they match.
export async function startWorkflow(
	toolCtx: ExtensionToolContext,
	id: string,
	workflow: Workflow,
	args: unknown,
	background: boolean,
	relaunchOf?: Run,
): Promise<WorkflowStart> {
	const code = `globalThis.args = ${args === undefined ? "undefined" : JSON.stringify(args)};${workflow.body}`;
	const { executeCodemode } = await loadCodemodeExecutor();
	named.set(id, workflow.meta.name);
	const session = {
		sessionFile: toolCtx.sessionManager.getSessionFile(),
		sessionId: toolCtx.sessionManager.getSessionId(),
	};
	const recorded = workflowRuns.begin(session, id, workflow.meta.name, args, relaunchOf);
	if (!background) {
		// Its calls' usage is added to the session when the scope is released (no result message records it).
		toolCtx.detachNestedCalls?.();
		try {
			const result = await executeCodemode(id, { code }, undefined, undefined, toolCtx, {});
			return { background: false, result, run: recorded };
		} finally {
			toolCtx.releaseNestedCalls?.();
			named.delete(id);
		}
	}
	// executeCodemode registers the script synchronously before its first await, so it is listed now.
	const run = executeCodemode(id, { code }, undefined, undefined, toolCtx, {});
	const forget = () => named.delete(id);
	run.then(forget, forget); // its end (also a failure) reaches main through the script registry
	const script = codemodeScripts
		.list(toolCtx.sessionManager.getSessionId())
		.find((s) => s.toolCallId === id && s.state === "foreground");
	if (!script) {
		// Without a session the controller does not track it: wait for it in the foreground.
		return { background: false, result: await run, run: recorded };
	}
	codemodeScripts.background(script.id, workflowStartText(workflow.meta.name, script.id, recorded));
	return { background: true, scriptId: script.id, run: recorded };
}
