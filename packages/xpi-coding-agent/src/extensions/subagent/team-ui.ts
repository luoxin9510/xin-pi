// Agent teams, the UI side (spec .scratch/agent-teams/01-agent-teams.md, "UI"): how a teammate is drawn in the panel and on
// its screen, and the `/tasks` overlay. Reads the team's members from memory and the task list from its files; writes nothing.

import { join } from "node:path";
import { type Component, type Focusable, matchesKey, type TUI, truncateToWidth } from "xpi-tui";
import type { ExtensionContext } from "../../core/extensions/types.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { SubagentRecord } from "./registry.ts";
import { type Member, onTeamChange, teams } from "./team.ts";
import { listTasks, openBlockers, type TaskRec, tasksRoot } from "./team-tasks.ts";
import { LEAD } from "./team-text.ts";

// What a teammate row says: the member's state, with a failed last exchange shown as failed (the teammate is still idle: live,
// woken by messages, keeping its tasks).
export type TeamState = "running" | "queued" | "idle" | "stopping" | "stopped" | "failed";

export const TEAM_ICONS: Record<TeamState, string> = {
	running: "●",
	queued: "◌",
	idle: "○",
	stopping: "◍",
	stopped: "■",
	failed: "✗",
};
export const TEAM_COLORS: Record<TeamState, "accent" | "success" | "warning" | "error" | "muted"> = {
	running: "accent",
	queued: "muted",
	idle: "success",
	stopping: "warning",
	stopped: "warning",
	failed: "error",
};

// The member behind a record, when the record is a teammate of the current team.
export function memberOf(record: Pick<SubagentRecord, "teammate" | "name">): Member | undefined {
	if (!record.teammate || record.name === undefined) return undefined;
	return teams.current()?.member(record.name);
}

export function stateOf(record: SubagentRecord): TeamState | undefined {
	const m = memberOf(record);
	if (!m) return undefined;
	return m.status === "idle" && record.status === "failed" ? "failed" : m.status;
}

// A teammate that is not stopped never leaves the panel (no `panelLingerMs`).
export const isLiveMate = (record: SubagentRecord): boolean => {
	const m = memberOf(record);
	return m !== undefined && m.status !== "stopped";
};

// The team's task list of this session (the lead may write tasks before the first teammate starts).
export const taskDir = (sessionId: string): string => join(tasksRoot(), `session-${sessionId}`);

const CACHE_MS = 1000;
let cache: { dir: string; at: number; tasks: TaskRec[] } | undefined;

// The tasks, read at most once a second (the panel draws often while an agent streams).
export function tasksOf(dir: string, fresh = false): TaskRec[] {
	const now = Date.now();
	if (!fresh && cache?.dir === dir && now - cache.at < CACHE_MS) return cache.tasks;
	let tasks: TaskRec[] = [];
	try {
		tasks = listTasks({ dir });
	} catch {
		// no list yet, or one being replaced: the next read looks again
	}
	cache = { dir, at: now, tasks };
	return tasks;
}

// The subject of the task a teammate owns: the one in progress, else the first it owns that is not done.
export function ownedSubject(name: string): string | undefined {
	const team = teams.current();
	if (!team) return undefined;
	const mine = tasksOf(team.tasksDir).filter((t) => t.owner === name && t.status !== "completed");
	return (mine.find((t) => t.status === "in_progress") ?? mine[0])?.subject;
}

// --- the /tasks overlay

const REFRESH_MS = 750;

export class TasksScreen implements Component, Focusable {
	focused = false;
	private tasks: TaskRec[] = [];
	private signature = "";
	private offset = 0;
	private timer: ReturnType<typeof setInterval>;
	private stopWatching: () => void;

	private tui: TUI;
	private theme: Theme;
	private dir: string;
	private done: () => void;

	constructor(tui: TUI, theme: Theme, dir: string, done: () => void, refreshMs = REFRESH_MS) {
		this.tui = tui;
		this.theme = theme;
		this.dir = dir;
		this.done = done;
		this.read();
		// The files are read again on a timer: nothing here watches the directory, so nothing can react to its own writes
		// (the lead's mailbox watcher once spun on exactly that). Member changes redraw at once.
		this.timer = setInterval(() => this.refresh(), refreshMs);
		this.timer.unref();
		this.stopWatching = onTeamChange(() => this.tui.requestRender());
	}

	private read(): void {
		this.tasks = tasksOf(this.dir, true)
			.slice()
			.sort((a, b) => Number(a.id) - Number(b.id));
		this.signature = JSON.stringify(this.tasks);
	}

	// Redraw only when something changed.
	refresh(): void {
		const before = this.signature;
		this.read();
		if (this.signature !== before) this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "enter")) {
			this.done();
			return;
		}
		if (matchesKey(data, "up")) this.offset = Math.max(0, this.offset - 1);
		else if (matchesKey(data, "down")) this.offset += 1;
		else return;
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const t = this.theme;
		const rows = this.tui.terminal.rows;
		const done = this.tasks.filter((x) => x.status === "completed").length;
		const head = t.fg("accent", t.bold(` Tasks (${done}/${this.tasks.length} done)`));
		const rule = t.fg("dim", "─".repeat(width));
		const body: string[] = [];
		if (this.tasks.length === 0)
			body.push(t.fg("muted", " no tasks yet: the lead or a teammate creates them with TaskCreate"));
		for (const x of this.tasks) {
			const open = x.status === "completed" ? [] : openBlockers(this.dir, x);
			const status =
				x.status === "completed" ? "✓ completed" : x.status === "in_progress" ? "● in_progress" : "○ pending";
			const color = x.status === "completed" ? "success" : x.status === "in_progress" ? "accent" : "muted";
			const owner = x.owner ?? "-";
			const state = ownerState(owner);
			body.push(
				truncateToWidth(
					` #${x.id}  ${t.fg(color, status)}  ${owner}${state ? t.fg("muted", ` (${state})`) : ""}  ${x.subject}${
						open.length > 0 ? t.fg("warning", `  blocked by ${open.map((b) => `#${b}`).join(", ")}`) : ""
					}`,
					width,
				),
			);
		}
		const height = Math.max(1, rows - 4);
		this.offset = Math.min(this.offset, Math.max(0, body.length - height));
		const shown = body.slice(this.offset, this.offset + height);
		while (shown.length < height) shown.push("");
		return [
			head,
			rule,
			...shown,
			rule,
			t.fg("dim", " ↑↓ scroll · esc or q close · refreshes as the files change"),
		].slice(0, rows);
	}

	invalidate(): void {}

	dispose(): void {
		clearInterval(this.timer);
		this.stopWatching();
	}
}

// The state of a task's owner, from the live team ("" for the lead, none, or a name the team does not have).
function ownerState(owner: string): string {
	if (owner === LEAD) return "";
	return teams.current()?.member(owner)?.status ?? "";
}

let current: Promise<void> | undefined;

// Show the task list over the terminal; resolves when the user closes it. One at a time.
export function openTasksScreen(ctx: () => ExtensionContext): Promise<void> {
	if (current) return current;
	const c = ctx();
	if (!teams.on) {
		c.ui.notify("agent teams are off: set agentTeams.enabled (see docs/subagent.md)", "warning");
		return Promise.resolve();
	}
	const dir = taskDir(c.sessionManager.getSessionId());
	current = c.ui
		.custom<void>((tui, theme, _kb, done) => new TasksScreen(tui, theme, dir, () => done()), {
			overlay: true,
			overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left" },
		})
		.finally(() => {
			current = undefined;
		});
	return current;
}
