// `/subagents`: pick one of the session's subagents, newest first. Opening one shows the subagent screen.
// `/subagents worktrees`: the kept `pipipi/*` worktrees of the current checkout, and removal of the ones the user picks.

import type { ExtensionCommandContext } from "../../core/extensions/types.ts";
import { label, modelInfo, registry, type SubagentRecord } from "./registry.ts";
import { stopEverything } from "./stop-all.ts";
import { openSubagentScreen } from "./subagent-screen.ts";
import { listLines, listWorktrees, removeWorktree, type WorktreeInfo } from "./worktree.ts";

const line = (r: SubagentRecord) =>
	`${r.status.padEnd(9)} ${label(r)} · ${modelInfo(r) ? `${modelInfo(r)} · ` : ""}${r.turns} turns · ${r.id}`;

export async function subagentsCommand(ctx: ExtensionCommandContext, args = ""): Promise<void> {
	if (args.trim() === "worktrees") return worktreesCommand(ctx);
	if (args.trim() === "stop") {
		const { agents, scripts } = await stopEverything(ctx.sessionManager.getSessionId());
		return ctx.ui.notify(
			agents + scripts === 0
				? "pi-pipipi: nothing is running"
				: `pi-pipipi: stopped ${agents} subagent${agents === 1 ? "" : "s"} and ${scripts} script${scripts === 1 ? "" : "s"}`,
			"info",
		);
	}
	if (args.trim() !== "")
		return ctx.ui.notify(
			`pi-pipipi: unknown argument "${args.trim()}"; use /subagents, /subagents stop or /subagents worktrees`,
			"warning",
		);
	if (!ctx.sessionManager.getSessionFile()) {
		return ctx.ui.notify(
			"pi-pipipi: subagents of an in-memory session cannot be viewed (the session is not saved)",
			"info",
		);
	}
	const rows = registry.list(ctx.sessionManager.getSessionId());
	if (rows.length === 0) return ctx.ui.notify("pi-pipipi: this session has no subagents yet", "info");
	const labels = rows.map(line);
	const choice = await ctx.ui.select("Subagents", labels);
	if (choice === undefined) return;
	const picked = rows[labels.indexOf(choice)]!;
	void openSubagentScreen(() => ctx, picked); // not awaited: the command ends, the screen stays until the user leaves
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const summary = (w: WorktreeInfo) =>
	w.outcome.changed
		? `${plural(w.outcome.files.length, "file")}, ${plural(w.outcome.commits.length, "commit")}`
		: "no changes";
const isRunning = (w: WorktreeInfo) => registry.get(w.agentId)?.status === "running";
const worktreeRow = (w: WorktreeInfo) =>
	`${w.agentId} · ${isRunning(w) ? "running · " : ""}${w.ref.branch} · ${summary(w)} · ${w.ref.path}`;

// What removing it would lose, in words for the confirm.
function lossText(w: WorktreeInfo): string {
	const lines = [`Worktree ${w.ref.path}`, `Branch ${w.ref.branch}`, ""];
	if (!w.outcome.changed) lines.push("It has no changes.");
	else {
		const { files, commits } = w.outcome;
		if (files.length > 0)
			lines.push(`These ${plural(files.length, "changed file")} will be lost:`, ...listLines(files, 10));
		if (commits.length > 0)
			lines.push(`These ${plural(commits.length, "commit")} on the branch will be lost:`, ...listLines(commits, 10));
	}
	lines.push("", "The worktree and the branch are deleted. This cannot be undone.");
	return lines.join("\n");
}

export async function worktreesCommand(ctx: ExtensionCommandContext): Promise<void> {
	let removedAny = false; // the last removal's notice stays on screen when nothing is left to list
	for (;;) {
		const found = await listWorktrees(ctx.cwd);
		if (found.length === 0)
			return removedAny ? undefined : ctx.ui.notify("pi-pipipi: no kept worktrees in this checkout", "info");
		const rows = found.map(worktreeRow);
		const choice = await ctx.ui.select("Kept worktrees (pick one to remove)", rows);
		if (choice === undefined) return;
		const picked = found[rows.indexOf(choice)]!;
		if (isRunning(picked)) {
			ctx.ui.notify(
				`pi-pipipi: agent ${picked.agentId} is still running in ${picked.ref.path}; stop it (or wait) before removing its worktree`,
				"warning",
			);
			continue;
		}
		if (!(await ctx.ui.confirm("Remove worktree?", lossText(picked)))) continue;
		try {
			await removeWorktree(picked.ref);
			registry.markWorktreeRemoved(picked.agentId);
			removedAny = true;
			ctx.ui.notify(`pi-pipipi: removed worktree ${picked.ref.path} and branch ${picked.ref.branch}`, "info");
		} catch (err) {
			ctx.ui.notify(`pi-pipipi: could not remove the worktree: ${(err as Error).message}`, "error");
			return;
		}
	}
}
