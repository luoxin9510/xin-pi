// `/workflows`: the saved workflows (name, description, where it is saved) and this session's workflow runs, newest
// first. Enter on a workflow runs it with no args; on a run, it lists the run's agents and opens the one picked.

import type { ExtensionCommandContext } from "../../core/extensions/types.ts";
import { isStdoutTakenOver, writeRawStdout } from "../../core/output-guard.ts";
import { type ScriptRecord, scripts } from "./background.ts";
import { label, registry } from "./registry.ts";
import { openSubagentScreen } from "./subagent-screen.ts";
import type { Workflow } from "./workflows.ts";

export const workflowLine = (w: Workflow) => `/${w.meta.name} · ${w.meta.description} · ${w.source}`;

const runLine = (s: ScriptRecord) =>
	`${s.id} ${s.workflow} · ${s.state} · ${s.agents.length} agent${s.agents.length === 1 ? "" : "s"}${s.log ? ` · ${s.log}` : ""}`;

export async function workflowsCommand(
	ctx: ExtensionCommandContext,
	workflows: Map<string, Workflow>,
	run: (name: string) => Promise<void>,
): Promise<void> {
	const saved = [...workflows.values()].sort((a, b) => a.meta.name.localeCompare(b.meta.name));
	if (!ctx.hasUI) {
		const text = saved.length === 0 ? "No saved workflows." : saved.map(workflowLine).join("\n");
		if (isStdoutTakenOver()) writeRawStdout(`${text}\n`);
		else process.stdout.write(`${text}\n`);
		return;
	}
	const runs = scripts
		.list(ctx.sessionManager.getSessionId())
		.filter((s) => s.workflow !== undefined)
		.reverse();
	if (saved.length === 0 && runs.length === 0) {
		return ctx.ui.notify(
			"subagent: no saved workflows (.pi/workflows/<name>.js in the project, or workflows/ in the agent dir)",
			"info",
		);
	}
	const rows = [...saved.map(workflowLine), ...runs.map(runLine)];
	const choice = await ctx.ui.select("Workflows (Enter runs a workflow or opens a run)", rows);
	if (choice === undefined) return;
	const index = rows.indexOf(choice);
	if (index < saved.length) return run(saved[index]!.meta.name);
	const picked = runs[index - saved.length]!;
	const agents = picked.agents.map((id) => registry.get(id)).filter((r) => r !== undefined);
	if (agents.length === 0) return ctx.ui.notify(`subagent: run ${picked.id} has no agents yet`, "info");
	if (!ctx.sessionManager.getSessionFile()) {
		return ctx.ui.notify(
			"subagent: agents of an in-memory session cannot be viewed (the session is not saved)",
			"info",
		);
	}
	const labels = agents.map(
		(r) => `${r.status.padEnd(9)} ${picked.phases[r.id] ? `[${picked.phases[r.id]}] ` : ""}${label(r)} · ${r.id}`,
	);
	const agentChoice = await ctx.ui.select(`Run ${picked.id} (${picked.workflow})`, labels);
	if (agentChoice === undefined) return;
	void openSubagentScreen(() => ctx, agents[labels.indexOf(agentChoice)]!);
}
