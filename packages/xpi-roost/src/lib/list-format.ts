// M15: `xpi roost ls`, a table for people (`--json` is for programs).
import type { JobRow, ScheduleRow } from "./protocol.ts";
import { agoText, untilText } from "./schedule.ts";
import { truncateToWidth, visibleWidth } from "./text-width.ts";
import { ageOf, groupOf, sentenceOf, shortPath } from "./view-model.ts";

const ORDER = { pinned: 0, "needs-input": 1, working: 2, completed: 3 } as const;
const oneLine = (s: string) =>
	s
		.replace(/[\u0000-\u001f\u007f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();

export interface ListOptions {
	now?: number;
	width?: number;
	home?: string;
}

/** Rows as the hub would list them: waiting first, then working, then the rest by when they ended. */
export function formatList(rows: JobRow[], opts: ListOptions = {}): string {
	const now = opts.now ?? Date.now();
	const width = Math.max(40, opts.width ?? 100);
	const shown = [...rows].sort(
		(a, b) => ORDER[groupOf(a)] - ORDER[groupOf(b)] || (b.endedAt ?? b.stateSince) - (a.endedAt ?? a.stateSince),
	);
	if (shown.length === 0) return "no background sessions\n";
	const state = (r: JobRow) =>
		r.state === "blocked" ? "waiting" : r.state === "working" && r.status === "busy" ? "working" : r.state;
	const cells = shown.map((r) => ({
		id: r.id,
		state: `${r.pid !== null ? "●" : "∙"} ${state(r)}`,
		// phase 2: a scheduled run says its schedule
		name: oneLine(r.schedule ? `${r.name} ← ${r.schedule}` : r.name),
		age: ageOf(r, now),
		what: oneLine(r.state === "blocked" && r.question ? r.question : sentenceOf(r)),
		dir: shortPath(r.cwd, opts.home),
	}));
	type Cell = (typeof cells)[number];
	const w = (k: keyof Cell, max: number) => Math.min(max, Math.max(k.length, ...cells.map((c) => visibleWidth(c[k]))));
	const cols = { id: w("id", 8), state: w("state", 10), name: w("name", 36), age: w("age", 6), dir: w("dir", 28) };
	const fixed = cols.id + cols.state + cols.name + cols.age + cols.dir + 10;
	const whatW = Math.max(10, width - fixed);
	const pad = (s: string, n: number) => {
		const t = truncateToWidth(s, n, "…");
		return t + " ".repeat(Math.max(0, n - visibleWidth(t)));
	};
	const line = (c: Cell) =>
		[
			pad(c.id, cols.id),
			pad(c.state, cols.state),
			pad(c.name, cols.name),
			pad(c.age, cols.age),
			pad(c.what, whatW),
			truncateToWidth(c.dir, cols.dir, "…"),
		]
			.join("  ")
			.trimEnd();
	const fit = (l: string) => truncateToWidth(l, width, "…");
	const head = line({ id: "ID", state: "STATE", name: "NAME", age: "AGE", what: "ACTIVITY", dir: "DIR" });
	return `${[head, ...cells.map(line)].map(fit).join("\n")}\n`;
}

/** Phase 2: `xpi roost schedule list`, a table like `ls`. */
export function formatSchedules(rows: ScheduleRow[], opts: ListOptions = {}): string {
	const now = opts.now ?? Date.now();
	const width = Math.max(40, opts.width ?? 100);
	if (rows.length === 0) return "no schedules\n";
	const last = (r: ScheduleRow) => {
		const skip = r.lastSkip && (r.lastRunAt === null || r.lastSkip.at >= r.lastRunAt) ? r.lastSkip : null;
		if (skip) return `skipped ${agoText(now - skip.at)} ago: ${oneLine(skip.why)}`;
		if (r.lastRunAt === null) return "never run";
		return `${agoText(now - r.lastRunAt)} ago${r.lastRunWhy && r.lastRunWhy !== "due" ? ` (${r.lastRunWhy})` : ""}${r.lastJob ? ` ${r.lastJob}` : ""}`;
	};
	const cells = rows.map((r) => ({
		name: r.name,
		when: oneLine(r.when),
		next: r.paused ? "paused" : r.nextAt === null ? "on request" : untilText(r.nextAt, now),
		last: last(r),
		dir: shortPath(r.cwd, opts.home),
		task: oneLine(r.task ?? ""),
	}));
	type Cell = (typeof cells)[number];
	const w = (k: keyof Cell, max: number) => Math.min(max, Math.max(k.length, ...cells.map((c) => visibleWidth(c[k]))));
	const cols = {
		name: w("name", 40),
		when: w("when", 24),
		next: w("next", 12),
		last: w("last", 50),
		dir: w("dir", 28),
	};
	const fixed = cols.name + cols.when + cols.next + cols.last + cols.dir + 10;
	const taskW = Math.max(10, width - fixed);
	const pad = (s: string, n: number) => {
		const t = truncateToWidth(s, n, "…");
		return t + " ".repeat(Math.max(0, n - visibleWidth(t)));
	};
	const line = (c: Cell) =>
		[
			pad(c.name, cols.name),
			pad(c.when, cols.when),
			pad(c.next, cols.next),
			pad(c.last, cols.last),
			pad(c.dir, cols.dir),
			truncateToWidth(c.task, taskW, "…"),
		]
			.join("  ")
			.trimEnd();
	const fit = (l: string) => truncateToWidth(l, width, "…");
	const head = line({ name: "NAME", when: "WHEN", next: "NEXT", last: "LAST", dir: "DIR", task: "TASK" });
	return `${[head, ...cells.map(line)].map(fit).join("\n")}\n`;
}
