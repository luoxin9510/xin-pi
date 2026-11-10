// The `Workflow` tool (spec 02): the model runs a saved workflow as `tools.Workflow({ name, args })` from a script. The
// run is the same as `/name`'s: with a UI it starts as a background script and the call returns its id at once; the
// result arrives as a message. Without one it runs in the foreground and the call returns its result.

import { type Static, Type } from "typebox";
import type { ExtensionToolContext } from "../../core/extensions/types.ts";
import { startWorkflow, workflowStartText } from "./workflow-run.ts";
import type { Workflow } from "./workflows.ts";

const parameters = Type.Object({
	name: Type.String({ description: "The saved workflow to run (one listed in this tool's description)" }),
	args: Type.Optional(Type.Unknown({ description: "The run's input, the script's `args` (any JSON value)" })),
});
type WorkflowInput = Static<typeof parameters>;

export function describeWorkflows(workflows: Iterable<Workflow>): string {
	const list = [...workflows].map((w) => `- ${w.meta.name}: ${w.meta.description}`);
	return [
		"Run a saved workflow: a script that orchestrates subagents, saved to be rerun. Prefer one that fits the task over",
		"writing a new script. `args` is its input. The call returns at once with the script id; the workflow's result",
		"arrives as a message when it ends (do not wait or poll). Without a UI it runs to its end and returns its result.",
		"",
		"Saved workflows:",
		...(list.length > 0 ? list : ["(none)"]),
	].join("\n");
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
			const start = await startWorkflow(ctx, toolCallId, workflow, params.args, background(ctx));
			if (start.background) {
				return {
					content: [{ type: "text" as const, text: workflowStartText(workflow.meta.name, start.scriptId) }],
					details: { scriptId: start.scriptId } as { scriptId?: string },
				};
			}
			return { ...start.result, details: {} as { scriptId?: string } };
		},
	};
}
