// The `wait` tool's arguments (.scratch/xpi-durable/02-waits.md, section 1): durations, times, limits. Pure.

/** The longest wait (W2), the same as roost's catch-up window for schedules. */
export const MAX_WAIT_MS = 7 * 24 * 60 * 60 * 1000;
/** The default and the shortest interval between checks (W9). */
export const DEFAULT_EVERY_MS = 2 * 60 * 1000;
export const MIN_EVERY_MS = 30 * 1000;
/** How long one check may run (W8). */
export const CHECK_TIMEOUT_MS = 2 * 60 * 1000;
/** How many lines of a check's output go into the note (W8). */
export const OUTPUT_LINES = 50;

const UNITS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** `"90s"`, `"20m"`, `"1.5h"`, `"3d"` (or several: `"1h30m"`) in ms; throws on anything else. */
export function parseDuration(text: string): number {
	const trimmed = text.trim();
	const parts = [...trimmed.matchAll(/(\d+(?:\.\d+)?)\s*([smhd])/g)];
	if (parts.length === 0 || parts.map((part) => part[0]).join("") !== trimmed.replace(/\s+/g, "")) {
		throw new Error(
			`"${text}" is not a duration: use a number and a unit (s, m, h, d), as "90s", "20m", "2h", "3d".`,
		);
	}
	return Math.round(parts.reduce((sum, part) => sum + Number(part[1]) * UNITS[part[2]], 0));
}

/**
 * An `at` time in epoch ms: `"HH:MM"` is the next such local time after `now`; an ISO time without an offset is local
 * time. "Local" is this process's time zone. A local time a DST change skips moves forward (as `Date` does).
 */
export function parseAt(text: string, now: number): number {
	const trimmed = text.trim();
	const clock = /^(\d{1,2}):(\d{2})$/.exec(trimmed);
	if (clock) {
		const hours = Number(clock[1]);
		const minutes = Number(clock[2]);
		if (hours > 23 || minutes > 59) throw new Error(`"${text}" is not a time of day (HH:MM, 00:00 to 23:59).`);
		const day = new Date(now);
		const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hours, minutes, 0, 0);
		if (at.getTime() <= now) at.setDate(at.getDate() + 1);
		return at.getTime();
	}
	const time = Date.parse(trimmed);
	if (!/^\d{4}-\d{2}-\d{2}/.test(trimmed) || Number.isNaN(time)) {
		throw new Error(`"${text}" is not a time: use "HH:MM" or an ISO time such as "2026-11-21T14:20".`);
	}
	return time;
}

export interface WaitParams {
	after?: string;
	at?: string;
	reason: string;
	check?: string;
	every?: string;
}

export interface ParsedWait {
	wakeAt: number;
	reason: string;
	check?: { command: string; everyMs: number; timeoutMs: number };
}

/** The tool's arguments checked against the limits; throws an error for the model. */
export function parseWait(params: WaitParams, now: number): ParsedWait {
	const reason = params.reason?.trim().split("\n")[0]?.trim() ?? "";
	if (!reason) throw new Error("wait needs a reason: one line saying what you wait for.");
	if ((params.after === undefined) === (params.at === undefined)) {
		throw new Error('wait needs exactly one of after (a duration, as "20m") or at (a time, as "14:20").');
	}
	const wakeAt = params.after !== undefined ? now + parseDuration(params.after) : parseAt(params.at as string, now);
	if (wakeAt <= now) throw new Error(`The time to wait until has passed (${new Date(wakeAt).toString()}).`);
	if (wakeAt - now > MAX_WAIT_MS) throw new Error("A wait is at most 7 days.");
	const command = params.check?.trim();
	if (params.every !== undefined && !command) throw new Error("every is the interval of a check: give check too.");
	if (!command) return { wakeAt, reason };
	const everyMs = params.every === undefined ? DEFAULT_EVERY_MS : parseDuration(params.every);
	if (everyMs < MIN_EVERY_MS) throw new Error("every is at least 30s.");
	return { wakeAt, reason, check: { command, everyMs, timeoutMs: CHECK_TIMEOUT_MS } };
}

/** The last `lines` lines of `text`. */
export function tail(text: string, lines = OUTPUT_LINES): string {
	const all = text.replace(/\s+$/, "").split("\n");
	return all.slice(-lines).join("\n");
}

/** A time for people: `14:20` today, else `Nov 22 14:20`. */
export function clockTime(time: number, now: number = Date.now()): string {
	const date = new Date(time);
	const hm = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
	const today = new Date(now);
	if (date.toDateString() === today.toDateString()) return hm;
	return `${date.toLocaleString("en-US", { month: "short", day: "numeric" })} ${hm}`;
}

/** `2m`, `90s`, `1h30m`: an interval for people. */
export function shortDuration(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	const rest = s % 60;
	if (m < 60) return rest ? `${m}m${rest}s` : `${m}m`;
	const h = Math.floor(m / 60);
	return m % 60 ? `${h}h${m % 60}m` : `${h}h`;
}
