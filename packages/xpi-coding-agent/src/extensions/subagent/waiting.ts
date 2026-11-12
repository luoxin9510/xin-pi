// Waiting without model turns (spec 09): what the user and clients see while agents run in the background. The line
// added to a user message during a group, stall detection, and the `subagents` status.

import { type ScriptRecord, scripts } from "./background.ts";
import { label, registry, type SubagentRecord } from "./registry.ts";
import { elapsed } from "./script-screen.ts";

// "stalled 12m": how long a stalled agent has been quiet, in whole minutes.
export const stalledLabel = (ms: number): string => `stalled ${Math.floor(ms / 60_000)}m`;

// The session's running groups: scripts whose code ended with agents left running.
const runningGroups = (sessionId: string): ScriptRecord[] => scripts.list(sessionId).filter((s) => s.state === "ended");

/**
 * The line added after a user message that starts a turn while a group runs:
 * `[agents still running: <id> <type> "<description>" <elapsed>; …]`. Undefined when no group has a member running.
 */
export function runningLine(sessionId: string, now = Date.now()): string | undefined {
	const members = runningGroups(sessionId)
		.flatMap((s) => s.members)
		.filter((m) => m.member && m.status === "running");
	if (members.length === 0) return undefined;
	const entries = members.map(
		(m) => `${m.agentId ?? "(starting)"} ${m.type} ${JSON.stringify(m.description)} ${elapsed(now - m.startedAt)}`,
	);
	return `[agents still running: ${entries.join("; ")}]`;
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The `subagents` status: the session's running agents (and how many are stalled), its running groups, and its other
 * background scripts. Undefined when nothing runs, which clears the status.
 */
export function statusText(sessionId: string): string | undefined {
	const agents = registry.list(sessionId).filter((r) => r.status === "running");
	const stalled = agents.filter((r) => registry.stalledFor(r.id) !== undefined).length;
	const running = scripts.list(sessionId);
	const groups = running.filter((s) => s.state === "ended").length;
	const background = running.filter((s) => s.state === "background").length;
	const parts = [
		...(agents.length > 0 ? [count(agents.length, "agent running", "agents running")] : []),
		...(stalled > 0 ? [`${stalled} stalled`] : []),
		...(groups > 0 ? [count(groups, "group", "groups")] : []),
		...(background > 0 ? [count(background, "background script", "background scripts")] : []),
	];
	return parts.length > 0 ? parts.join(" · ") : undefined;
}

// What the user is told when an agent is marked stalled.
export const stallNotice = (r: SubagentRecord, stallMs: number): string =>
	`subagent: ${r.id} ${label(r)} has done nothing for ${Math.floor(stallMs / 60_000)}m${r.lastTool ? ` (last tool: ${r.lastTool})` : ""}; it keeps running, x in the panel stops it`;

/** Mark the session's agents quiet for `stallMs` as stalled, and tell the user (never main). */
export function checkStalls(
	sessionId: string,
	stallMs: number,
	notify: (message: string) => void,
	now = Date.now(),
): void {
	for (const r of registry.checkStalls(sessionId, stallMs, now)) notify(stallNotice(r, stallMs));
}
