// The `Workflow` tool (spec 02): the model runs a saved workflow as `tools.Workflow({ name, args })` from a script. The
// run is the same as `/name`'s: with a UI it starts as a background script and the call returns its id at once; the
// result arrives as a message. Without one it runs in the foreground and the call returns its result.

import { type Static, Type } from "typebox";
import type { ExtensionToolContext } from "../../core/extensions/types.ts";
import { registry } from "./registry.ts";
import { type Run, runs } from "./runs.ts";
import { startWorkflow, workflowStartText } from "./workflow-run.ts";
import type { Workflow } from "./workflows.ts";

const parameters = Type.Object({
	name: Type.String({ description: "The saved workflow to run (one listed in this tool's description)" }),
	args: Type.Optional(Type.Unknown({ description: "The run's input, the script's `args` (any JSON value)" })),
	relaunch: Type.Optional(
		Type.String({
			description:
				'A run id (such as "R2") of this workflow that stopped or failed: start it again with the same args. Agents that completed are answered from saved results; from the first one that failed, was still running or is asked something else, everything runs. Do not pass `args`.',
		}),
	),
});
type WorkflowInput = Static<typeof parameters>;

export function describeWorkflows(workflows: Iterable<Workflow>): string {
	const list = [...workflows].map((w) => `- ${w.meta.name}: ${w.meta.description}`);
	return [
		"Run a saved workflow: a script that orchestrates subagents, saved to be rerun. Prefer one that fits the task over",
		"writing a new script. `args` is its input. The call returns at once with the script id; the workflow's result",
		"arrives as a message when it ends (do not wait or poll). Without a UI it runs to its end and returns its result.",
		"A run that stopped or failed can be started again with `relaunch: <run id>`: finished agents are not run twice.",
		"",
		"Saved workflows:",
		...(list.length > 0 ? list : ["(none)"]),
	].join("\n");
}

// The run a relaunch names, checked: it exists, is this workflow's, has ended and has something left to do. Throws
// with the reason otherwise.
export function runToRelaunch(
	session: { sessionFile: string | undefined; sessionId: string },
	name: string,
	id: string,
): Run {
	const refusal = runs.relaunchRefusal(session, id, (agentId) => registry.get(agentId)?.status === "running");
	if (refusal !== undefined) throw new Error(refusal);
	const run = runs.get(session, id)!;
	if (run.workflow !== name) throw new Error(`run ${id} is a run of workflow "${run.workflow}", not "${name}"`);
	return run;
}

export function workflowTool(
	description: string,
	find: (name: string, ctx: ExtensionToolContext) => Workflow | undefined, // looked up when called: an edited file runs as edited
	background: (ctx: ExtensionToolContext) => boolean,
) {
	return {
		name: "Workflow",
		label: "Workflow",
		exposure: "codemode" as const,
		description,
		parameters,
		async execute(
			toolCallId: string,
			params: WorkflowInput,
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionToolContext,
		) {
			const workflow = find(params.name, ctx);
			if (!workflow) throw new Error(`no saved workflow "${params.name}" is available here`);
			let earlier: Run | undefined;
			if (params.relaunch !== undefined) {
				if (params.args !== undefined)
					throw new Error("a relaunch uses the args of the run it relaunches: do not pass `args`");
				const session = {
					sessionFile: ctx.sessionManager.getSessionFile(),
					sessionId: ctx.sessionManager.getSessionId(),
				};
				earlier = runToRelaunch(session, workflow.meta.name, params.relaunch);
			}
			const args = earlier ? earlier.args : params.args;
			const start = await startWorkflow(ctx, toolCallId, workflow, args, background(ctx), earlier);
			if (start.background) {
				return {
					content: [
						{ type: "text" as const, text: workflowStartText(workflow.meta.name, start.scriptId, start.run) },
					],
					details: { scriptId: start.scriptId } as { scriptId?: string },
				};
			}
			return { ...start.result, details: {} as { scriptId?: string } };
		},
	};
}
