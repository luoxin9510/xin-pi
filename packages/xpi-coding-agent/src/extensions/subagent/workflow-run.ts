// Running a saved workflow: its script starts as a codemode script that no model call issued (a command's tool
// context, `ctx.createToolContext`). With a UI it moves to the background at once, and its end reaches main like any
// background script's (background.ts). Without one (print mode, or subagent.backgroundScripts: false) it runs in the
// foreground and the command returns its result.

import type { AgentToolResult } from "xpi-agent-core";
import type { ExtensionCommandContext } from "../../core/extensions/types.ts";
import { loadCodemodeExecutor } from "../codemode/execute.lazy.ts";
import { codemodeScripts } from "../codemode/scripts.ts";
import type { Workflow } from "./workflows.ts";

const WORKFLOW_CALL_PREFIX = "workflow:";
let runs = 0;

// The workflow name a script's codemode call id carries, if a workflow started it.
export function workflowOf(toolCallId: string): string | undefined {
	if (!toolCallId.startsWith(WORKFLOW_CALL_PREFIX)) return undefined;
	return toolCallId.slice(WORKFLOW_CALL_PREFIX.length).split(":")[0];
}

export const workflowStartText = (name: string, scriptId: string) =>
	`Workflow ${name} started as background script ${scriptId}. Its result arrives as a message when it ends.`;

export type WorkflowStart =
	| { background: true; scriptId: string }
	| { background: false; result: AgentToolResult<unknown> };

// `args` reaches the script as a global, set on the body's first line (the `meta` statement left it empty), so line
// numbers stay the file's.
export async function startWorkflow(
	ctx: ExtensionCommandContext,
	workflow: Workflow,
	args: unknown,
	background: boolean,
): Promise<WorkflowStart> {
	const id = `${WORKFLOW_CALL_PREFIX}${workflow.meta.name}:${Date.now().toString(36)}-${++runs}`;
	const code = `globalThis.args = ${args === undefined ? "undefined" : JSON.stringify(args)};${workflow.body}`;
	const toolCtx = ctx.createToolContext(id);
	const { executeCodemode } = await loadCodemodeExecutor();
	if (!background) {
		// Its calls' usage is added to the session when the scope is released (no result message records it).
		toolCtx.detachNestedCalls?.();
		try {
			return { background: false, result: await executeCodemode(id, { code }, undefined, undefined, toolCtx, {}) };
		} finally {
			toolCtx.releaseNestedCalls?.();
		}
	}
	// executeCodemode registers the script synchronously before its first await, so it is listed now.
	const run = executeCodemode(id, { code }, undefined, undefined, toolCtx, {});
	const script = codemodeScripts.list(ctx.sessionManager.getSessionId()).find((s) => s.toolCallId === id);
	if (!script) {
		// Without a session the controller does not track it: wait for it in the foreground.
		return { background: false, result: await run };
	}
	codemodeScripts.background(script.id, workflowStartText(workflow.meta.name, script.id));
	run.catch(() => {}); // its end (also a failure) reaches main through the script registry
	return { background: true, scriptId: script.id };
}
