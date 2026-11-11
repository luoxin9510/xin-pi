/**
 * Phase 2 (spec 02, from pi-roost's M39): a schedule's time rule and its slots, in local time. `every 30m`,
 * `daily 09:00`, `weekdays 09:00`, `weekly mon 09:00`, `cron "<five fields>"` or `manual`. Two slots are never under
 * 5 minutes apart (decision 3). A run's launch is made by the side that knows xpi (the extension's CLI wrapper or the
 * hub), with `{{run}}` where each run's own session file name goes.
 */
import { randomUUID } from "node:crypto";
import type { DispatchArgs, ScheduleRow } from "./protocol.ts";

export const RUN_SLOT = "{{run}}";

export interface Schedule {
	name: string;
	/** As the user wrote it (`every 2h`, `daily 09:00`, `cron 0 9 * * 1-5`). */
	when: string;
	/** What runs: an xpi dispatch whose sessionFile and command hold `{{run}}`, environment included. */
	launch: DispatchArgs;
	paused: boolean;
	/** The task as typed (shown in lists, kept for an edit). */
	task?: string;
	createdAt: number;
	/** What `every` counts from: when it was made, resumed, or its rule edited. */
	anchor: number;
	/** The next run (ms epoch), or null while paused or for a `manual` schedule. */
	nextAt: number | null;
	lastRunAt?: number;
	lastJob?: string;
	/** Why the last run started: on its slot, as a catch-up of a missed slot, or asked for. */
	lastRunWhy?: "due" | "catch-up" | "now";
	/** Why the last due run did not start (the previous one still working, a missing directory, an error). */
	lastSkip?: { at: number; why: string };
}

export const SCHEDULE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;
/** Decision 11: a task is at most this many bytes (UTF-8). */
export const TASK_MAX_BYTES = 64 * 1024;
/** Decision 11: at most this many schedules, paused ones included. */
export const SCHEDULES_MAX = 50;
/** Decision 3: two slots are never closer. */
export const FLOOR_MS = 5 * 60_000;

// ---- when ------------------------------------------------------------------------------

type Field = Set<number>;
export interface Cron {
	minute: Field;
	hour: Field;
	dom: Field;
	month: Field;
	dow: Field;
	/** Day of month and day of week both restricted: either matches (cron's rule). */
	domAndDow: boolean;
}

function field(text: string, min: number, max: number, name: string): { set: Field; any: boolean } {
	const set: Field = new Set();
	for (const part of text.split(",")) {
		const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
		if (!m) throw new Error(`cron ${name}: ${part}`);
		const step = m[4] === undefined ? 1 : Number(m[4]);
		let lo = min;
		let hi = max;
		if (m[1] !== "*") {
			lo = Number(m[2]);
			hi = m[3] === undefined ? (m[4] === undefined ? lo : max) : Number(m[3]);
		}
		if (step < 1 || lo < min || hi > max || lo > hi) throw new Error(`cron ${name}: ${part} (${min}-${max})`);
		for (let v = lo; v <= hi; v += step) set.add(v);
	}
	// a leading * (with a step too) leaves the day rule as "and", as cron does
	return { set, any: text.startsWith("*") };
}

export function parseCron(expr: string): Cron {
	const parts = expr.trim().split(/\s+/);
	if (parts.length !== 5) throw new Error("cron needs five fields: minute hour day-of-month month day-of-week");
	const [mi, h, dom, mo, dow] = parts as [string, string, string, string, string];
	const d = field(dow, 0, 7, "day of week");
	// 7 is Sunday too
	if (d.set.has(7)) {
		d.set.delete(7);
		d.set.add(0);
	}
	const dm = field(dom, 1, 31, "day of month");
	return {
		minute: field(mi, 0, 59, "minute").set,
		hour: field(h, 0, 23, "hour").set,
		dom: dm.set,
		month: field(mo, 1, 12, "month").set,
		dow: d.set,
		domAndDow: !dm.any && !d.any,
	};
}

/**
 * Decision 3: the closest two of a cron rule's times of day (its hour and minute fields), the last of a day followed
 * by the first of the next, in minutes. Day fields only move slots further apart.
 */
export function closestMinutes(c: Cron): number {
	const times = [...c.hour].flatMap((h) => [...c.minute].map((m) => h * 60 + m)).sort((a, b) => a - b);
	if (times.length === 1) return 24 * 60;
	let least = times[0]! + 24 * 60 - times[times.length - 1]!;
	for (let i = 1; i < times.length; i++) least = Math.min(least, times[i]! - times[i - 1]!);
	return least;
}

/**
 * The first minute after `after` the cron matches (local time), within ~5 years. Steps
 * never go back: in the hour a DST change repeats, a local setter can land an hour
 * earlier; a step that would is made a minute forward instead.
 */
export function nextCron(c: Cron, after: number): number | null {
	// the next whole minute, in epoch time (a local setter could land in the other occurrence of a repeated hour)
	let t = new Date(Math.floor(after / 60_000) * 60_000 + 60_000);
	const limit = after + 5 * 366 * 24 * 3600_000;
	const dayOk = (d: Date) => {
		const dom = c.dom.has(d.getDate());
		const dow = c.dow.has(d.getDay());
		return c.domAndDow ? dom || dow : dom && dow;
	};
	const step = (move: (d: Date) => void) => {
		const prev = t.getTime();
		const d = new Date(prev);
		move(d);
		t = d.getTime() > prev ? d : new Date(prev + 60_000);
	};
	while (t.getTime() <= limit) {
		if (!c.month.has(t.getMonth() + 1)) {
			step((d) => {
				d.setMonth(d.getMonth() + 1, 1);
				d.setHours(0, 0, 0, 0);
			});
			continue;
		}
		if (!dayOk(t)) {
			step((d) => {
				d.setDate(d.getDate() + 1);
				d.setHours(0, 0, 0, 0);
			});
			continue;
		}
		if (!c.hour.has(t.getHours())) {
			step((d) => d.setHours(d.getHours() + 1, 0, 0, 0));
			continue;
		}
		if (!c.minute.has(t.getMinutes())) {
			t = new Date(t.getTime() + 60_000);
			continue;
		}
		return t.getTime() > after ? t.getTime() : null;
	}
	return null;
}

export type When = { every: number } | { cron: Cron } | { manual: true };

const UNIT: Record<string, number> = { m: 60_000, h: 3600_000, d: 86_400_000 };
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const FULL_DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export const WHEN_HELP =
	'"every 30m", "daily 09:00", "weekdays 09:00", "weekly mon 09:00", "cron <minute hour day month weekday>" or "manual"';

function timeOfDay(rule: string, hh: string, mm: string): [number, number] {
	const h = Number(hh);
	const m = Number(mm);
	if (h > 23 || m > 59) throw new Error(`${rule}: a time of day, HH:MM`);
	return [h, m];
}

/** A rule as decision 3 has them; refused with the reason (below 5 minutes apart, a bad field). */
export function parseWhen(text: string): When {
	const s = text.trim();
	if (/^manual$/i.test(s)) return { manual: true };
	let m = /^every\s+(\d+)\s*([mhd])$/i.exec(s);
	if (m) {
		const ms = Number(m[1]) * UNIT[m[2]!.toLowerCase()]!;
		if (ms < FLOOR_MS) throw new Error("every: five minutes at least");
		return { every: ms };
	}
	m = /^(daily|weekdays)\s+(\d{1,2}):(\d{2})$/i.exec(s);
	if (m) {
		const [h, mi] = timeOfDay(m[1]!.toLowerCase(), m[2]!, m[3]!);
		return { cron: parseCron(`${mi} ${h} * * ${m[1]!.toLowerCase() === "daily" ? "*" : "1-5"}`) };
	}
	m = /^weekly\s+([a-z]+)\s+(\d{1,2}):(\d{2})$/i.exec(s);
	if (m) {
		const name = m[1]!.toLowerCase();
		const day = DAYS.findIndex((d, i) => name === d || name === FULL_DAYS[i]);
		if (day < 0) throw new Error("weekly: a day, mon tue wed thu fri sat sun");
		const [h, mi] = timeOfDay("weekly", m[2]!, m[3]!);
		return { cron: parseCron(`${mi} ${h} * * ${day}`) };
	}
	m = /^cron\s+(.+)$/i.exec(s);
	if (m) {
		const cron = parseCron(m[1]!.replace(/^["']|["']$/g, ""));
		const gap = closestMinutes(cron);
		if (gap < 5)
			throw new Error(`cron: two of its times are ${gap} minute${gap === 1 ? "" : "s"} apart; five at least`);
		return { cron };
	}
	throw new Error(`when: ${WHEN_HELP}`);
}

/** The run after `after`. `every` counts from `from` (the schedule's anchor). `manual` has none. */
export function nextRun(when: When, after: number, from: number = after): number | null {
	if ("manual" in when) return null;
	if ("every" in when) {
		const n = Math.floor((after - from) / when.every) + 1;
		return from + Math.max(1, n) * when.every;
	}
	return nextCron(when.cron, after);
}

/** Decision 4: the latest slot in [from, to], or null. `every` counts from `anchor`. */
export function latestSlot(when: When, from: number, to: number, anchor: number): number | null {
	if ("manual" in when || to < from) return null;
	if ("every" in when) {
		const k = Math.floor((to - anchor) / when.every);
		const slot = anchor + k * when.every;
		return k >= 1 && slot >= from ? slot : null;
	}
	let latest: number | null = null;
	for (let t = nextCron(when.cron, from - 1); t !== null && t <= to; t = nextCron(when.cron, t)) latest = t;
	return latest;
}

// ---- a run ----------------------------------------------------------------------------

/** A run's own session file name, as xpi names one (`<time>_<uuid>`). */
export function runSlot(now: number = Date.now()): string {
	return `${new Date(now).toISOString().replace(/[:.]/g, "-")}_${randomUUID()}`;
}

/** The dispatch for one run: `{{run}}` filled in the session file and the command. */
export function runLaunch(template: DispatchArgs, slot: string): DispatchArgs {
	const file = template.sessionFile.split(RUN_SLOT).join(slot);
	// the session file's own argument only: a task that says {{run}} is left as written
	return {
		...template,
		sessionFile: file,
		command: template.command.map((x) => (x === template.sessionFile ? file : x)),
	};
}

/** A launch a schedule may keep: an xpi session whose session file has the run slot, in an absolute directory. */
export function checkTemplate(t: unknown): asserts t is DispatchArgs {
	const a = t as DispatchArgs;
	if (!a || typeof a !== "object") throw new Error("launch: missing");
	if (a.kind === "shell") throw new Error("launch: a schedule runs xpi sessions only");
	if (!Array.isArray(a.command) || a.command.length < 2 || !a.command.every((x) => typeof x === "string"))
		throw new Error("launch: command");
	if (typeof a.cwd !== "string" || !a.cwd.startsWith("/")) throw new Error("launch: cwd");
	if (typeof a.sessionFile !== "string" || !a.sessionFile.startsWith("/") || !a.sessionFile.includes(RUN_SLOT))
		throw new Error(`launch: its sessionFile must be absolute and hold ${RUN_SLOT}`);
	if (!a.command.includes(a.sessionFile)) throw new Error("launch: its command must name its sessionFile");
	if (!a.env || typeof a.env !== "object") throw new Error("launch: env");
}

/** Decision 11: a task's size, refused above TASK_MAX_BYTES. */
export function checkTask(task: unknown): string | undefined {
	if (task === undefined) return undefined;
	if (typeof task !== "string") throw new Error("task: text");
	if (Buffer.byteLength(task, "utf8") > TASK_MAX_BYTES) throw new Error("task: 64 KiB at most");
	return task;
}

// ---- what the hub and the CLI read and show ------------------------------------------

/** A schedule as the ops answer it (and `xpi roost schedule list` reads it from the file when no daemon runs). */
export function scheduleRow(s: Schedule): ScheduleRow {
	return {
		name: s.name,
		when: s.when,
		task: s.task ?? null,
		cwd: s.launch.cwd,
		model: s.launch.model ?? null,
		thinking: s.launch.thinking ?? null,
		paused: s.paused === true,
		nextAt: s.paused ? null : (s.nextAt ?? null),
		lastRunAt: s.lastRunAt ?? null,
		lastJob: s.lastJob ?? null,
		lastRunWhy: s.lastRunWhy ?? null,
		lastSkip: s.lastSkip ?? null,
	};
}

const WHEN_PATTERN =
	/^(every\s+\d+\s*[mhd]|(?:daily|weekdays)\s+\d{1,2}:\d{2}|weekly\s+[A-Za-z]+\s+\d{1,2}:\d{2}|manual|cron\s+"[^"]+"|cron\s+'[^']+'|cron(?:\s+\S+){5})(?:\s+|$)/i;

/** `<when> <task>`: the rule first (as `parseWhen` reads it), then the task. */
export function splitWhen(text: string): { when: string; rest: string } | undefined {
	const s = text.trim();
	const m = WHEN_PATTERN.exec(s);
	if (!m) return undefined;
	return { when: m[1]!.replace(/\s+/g, " "), rest: s.slice(m[0].length).trim() };
}

/** `<name> <when> <task>`, as `/schedule` and `xpi roost schedule add` take it. */
export function parseScheduleInput(text: string): { name: string; when: string; task: string } | { error: string } {
	const usage = `schedule: <name> <when> <task>; when: ${WHEN_HELP}`;
	const m = /^(\S+)\s+([\s\S]+)$/.exec(text.trim());
	if (!m) return { error: usage };
	const name = m[1]!;
	if (!SCHEDULE_NAME.test(name)) return { error: `not a schedule name: ${name} (letters, digits, _ . -)` };
	const split = splitWhen(m[2]!);
	if (!split || !split.rest) return { error: usage };
	try {
		parseWhen(split.when);
		checkTask(split.rest);
	} catch (err) {
		return { error: (err as Error).message };
	}
	return { name, when: split.when, task: split.rest };
}

/** "in 3h 05m", "in 2d 4h", "now", for a time ahead. */
export function untilText(at: number, now: number = Date.now()): string {
	const ms = at - now;
	if (ms < 60_000) return ms <= 0 ? "now" : "in <1m";
	const m = Math.floor(ms / 60_000);
	if (m < 60) return `in ${m}m`;
	const h = Math.floor(m / 60);
	if (h < 48) return `in ${h}h ${String(m % 60).padStart(2, "0")}m`;
	return `in ${Math.floor(h / 24)}d ${h % 24}h`;
}

/** "5m", "3h", "2d": how long ago, roughly. */
export function agoText(ms: number): string {
	const m = Math.max(0, Math.floor(ms / 60_000));
	if (m < 1) return "<1m";
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
}
