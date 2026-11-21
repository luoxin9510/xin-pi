// Waits that do not hold a process (.scratch/xpi-durable/02-waits.md): the entries `builtin:wait` writes, and the rule
// for a pending one. In the core because forks close a pending wait they copy, as they close open runs.
import type { SessionEntry } from "./session-manager.ts";

/** A wait the model asked for (custom entry, hidden), written when its run ends. */
export const WAIT_CUSTOM_TYPE = "xpi.wait";
/** How a wait ended (custom entry, hidden). */
export const WAKE_CUSTOM_TYPE = "xpi.wake";
/** The note the model reads when a wait ends (custom message, shown). */
export const WOKE_CUSTOM_TYPE = "xpi.woke";

export type WakeWhy = "due" | "check" | "deadline" | "user" | "continue" | "cancel" | "blocked";

export interface WaitCheck {
	command: string;
	everyMs: number;
	timeoutMs: number;
}

export interface WaitData {
	id: string;
	/** When the run that asked for it ended (epoch ms). */
	at: number;
	/** The wake time, or with a check the deadline (epoch ms). */
	wakeAt: number;
	reason: string;
	check?: WaitCheck;
}

export interface WakeData {
	id: string;
	at: number;
	why: WakeWhy;
	/** The last lines of the last check run. */
	output?: string;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

export function waitOf(entry: SessionEntry): WaitData | undefined {
	if (entry.type !== "custom" || entry.customType !== WAIT_CUSTOM_TYPE || !isObject(entry.data)) return undefined;
	const data = entry.data;
	if (typeof data.id !== "string" || typeof data.at !== "number" || typeof data.wakeAt !== "number") return undefined;
	return data as unknown as WaitData;
}

export function wakeOf(entry: SessionEntry): WakeData | undefined {
	if (entry.type !== "custom" || entry.customType !== WAKE_CUSTOM_TYPE || !isObject(entry.data)) return undefined;
	return typeof entry.data.id === "string" ? (entry.data as unknown as WakeData) : undefined;
}

/**
 * The pending wait: the branch's last `xpi.wait` whose id has no `xpi.wake` anywhere in the session (`entries`), so a
 * fork or `/tree` does not bring an ended one back.
 */
export function pendingWait(
	branch: readonly SessionEntry[],
	entries: readonly SessionEntry[] = branch,
): WaitData | undefined {
	let last: WaitData | undefined;
	for (let i = branch.length - 1; i >= 0 && !last; i--) last = waitOf(branch[i]);
	if (!last) return undefined;
	const id = last.id;
	return entries.some((entry) => wakeOf(entry)?.id === id) ? undefined : last;
}

/** The time of the next check after `now` (`at + k × everyMs`, k ≥ 1), capped at the deadline. */
/**
 * The `pi.events` channel the wait extension says on when it next looks at a pending wait (`{ id, next }`), and when
 * a wait ended (`{ id, ended: true }`). Roost's worker reports it, and lets the daemon end the process until then.
 */
export const WAIT_EVENT = "xpi.wait";
export type WaitEvent = { id: string; next: number } | { id: string; ended: true };

export function nextCheckAt(wait: WaitData, now: number): number {
	if (!wait.check) return wait.wakeAt;
	const every = Math.max(1, wait.check.everyMs);
	const k = Math.max(1, Math.floor((now - wait.at) / every) + 1);
	return Math.min(wait.at + k * every, wait.wakeAt);
}
