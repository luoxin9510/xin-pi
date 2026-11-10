// `/workflows`: the saved workflows (name, description, where it was read from) and this session's workflow runs,
// newest first. Enter on a workflow runs it with no args. Enter on a run that is going offers its agents, pause or
// resume, and stop; on one that stopped or failed, it relaunches it from its saved results (runs.ts).

import { homedir } from "node:os";
import { dirname } from "node:path";
import type { ExtensionCommandContext } from "../../core/extensions/types.ts";
import { isStdoutTakenOver, writeRawStdout } from "../../core/output-guard.ts";
import { type ScriptRecord, scripts } from "./background.ts";
import { label, registry } from "./registry.ts";
import { type Run, runs, savedCalls } from "./runs.ts";
import { openSubagentScreen } from "./subagent-screen.ts";
import type { Workflow } from "./workflows.ts";

// Where a workflow was read from, with the home directory as `~`.
const directoryOf = (w: Workflow) => {
	const dir = dirname(w.path);
	return dir.startsWith(homedir()) ? `~${dir.slice(homedir().length)}` : dir;
};

export const workflowLine = (w: Workflow) =>
	`/${w.meta.name} · ${w.meta.description} · ${w.source} · ${directoryOf(w)}`;

// "R2 audit · stopped · 3 of 5 calls completed · 2 from saved results · relaunch of R1"
export function runLine(run: Run, script?: ScriptRecord): string {
	const calls = run.calls.filter((c) => !c.background);
	const done = calls.filter((c) => c.status === "completed").length;
	const saved = savedCalls(run);
	return [
		`${run.id} ${run.workflow}`,
		script?.paused ? "paused" : run.state,
		`${done} of ${calls.length} call${calls.length === 1 ? "" : "s"} completed`,
		...(saved > 0 ? [`${saved} from saved results`] : []),
		...(run.relaunchOf ? [`relaunch of ${run.relaunchOf}`] : []),
		...(script?.log ? [script.log] : []),
	].join(" · ");
}

export interface WorkflowActions {
	run(name: string): Promise<void>;
	relaunch(name: string, runId: string): Promise<void>;
}

export async function workflowsCommand(
	ctx: ExtensionCommandContext,
	workflows: Map<string, Workflow>,
	actions: WorkflowActions,
): Promise<void> {
	const saved = [...workflows.values()].sort((a, b) => a.meta.name.localeCompare(b.meta.name));
	if (!ctx.hasUI) {
		const text = saved.length === 0 ? "No saved workflows." : saved.map(workflowLine).join("\n");
		if (isStdoutTakenOver()) writeRawStdout(`${text}\n`);
		else process.stdout.write(`${text}\n`);
		return;
	}
	const session = { sessionFile: ctx.sessionManager.getSessionFile(), sessionId: ctx.sessionManager.getSessionId() };
	const past = runs.list(session);
	const scriptOf = (run: Run) => scripts.list(session.sessionId).find((s) => s.run === run.id);
	if (saved.length === 0 && past.length === 0) {
		return ctx.ui.notify(
			"subagent: no saved workflows (.pi/workflows/<name>.js or .claude/workflows/<name>.js in the project, or workflows/ in the agent dir)",
			"info",
		);
	}
	const rows = [...saved.map(workflowLine), ...past.map((run) => runLine(run, scriptOf(run)))];
	const choice = await ctx.ui.select("Workflows (Enter runs a workflow; on a run: its actions, or a relaunch)", rows);
	if (choice === undefined) return;
	const index = rows.indexOf(choice);
	if (index < saved.length) return actions.run(saved[index]!.meta.name);
	const run = past[index - saved.length]!;
	const script = scriptOf(run);
	if (run.state === "running" && script) return runActions(ctx, run, script);
	const refusal = runs.relaunchRefusal(session, run.id, (id) => registry.get(id)?.status === "running");
	if (refusal !== undefined) return ctx.ui.notify(`subagent: ${refusal}`, "info");
	return actions.relaunch(run.workflow, run.id);
}

// A run that is going: look at its agents, hold it or let it go on, or stop it.
async function runActions(ctx: ExtensionCommandContext, run: Run, script: ScriptRecord): Promise<void> {
	const options = ["Open one of its agents", script.paused ? "Resume" : "Pause", "Stop"];
	const action = await ctx.ui.select(`Run ${run.id} (${run.workflow})`, options);
	if (action === undefined) return;
	if (action === "Stop") {
		await scripts.stop(script.id);
		return;
	}
	if (action !== options[0]) {
		const paused = scripts.togglePause(script.id);
		if (paused !== undefined) {
			ctx.ui.notify(
				paused
					? `subagent: run ${run.id} is paused: it starts no new agent; the ones running finish`
					: `subagent: run ${run.id} resumed`,
				"info",
			);
		}
		return;
	}
	const agents = script.agents.map((id) => registry.get(id)).filter((r) => r !== undefined);
	if (agents.length === 0) return ctx.ui.notify(`subagent: run ${run.id} has no agents yet`, "info");
	if (!ctx.sessionManager.getSessionFile()) {
		return ctx.ui.notify(
			"subagent: agents of an in-memory session cannot be viewed (the session is not saved)",
			"info",
		);
	}
	const labels = agents.map(
		(r) => `${r.status.padEnd(9)} ${script.phases[r.id] ? `[${script.phases[r.id]}] ` : ""}${label(r)} · ${r.id}`,
	);
	const picked = await ctx.ui.select(`Run ${run.id} (${run.workflow})`, labels);
	if (picked === undefined) return;
	void openSubagentScreen(() => ctx, agents[labels.indexOf(picked)]!);
}
