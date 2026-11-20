/**
 * A model run cut off when the process ended (spec `.scratch/xpi-durable/01-interrupted-turn.md`).
 *
 * `AgentSession._startRun` writes a hidden `xpi.run` custom entry when a run starts and another when it ends. A branch
 * whose last `xpi.run` entry is a `start` was cut off: the process ended during the run (`kill -9`, a closed laptop,
 * SIGTERM, `/quit` while a reply streamed, the end of an RPC child's stdin). This module reads that from the branch;
 * the session writes the recovery.
 */

import type { AssistantMessage } from "xpi-ai/compat";
import type { SessionEntry } from "./session-manager.ts";

export type ToolCall = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

/** The built-in command that goes on without a new message. */
export const CONTINUE_COMMAND = "/continue";

/**
 * What `/continue` did (`AgentSession.continueRun()`). `finished`: the last run completed (or ended after a complete
 * reply); `stopped`: it was aborted (Esc); `none`: the branch has no run; `busy`: a run, a compaction or a branch
 * summary is in progress.
 */
export type ContinueResult = { ran: true } | { ran: false; reason: "finished" | "stopped" | "none" | "busy" };

export function continueResultText(reason: Extract<ContinueResult, { ran: false }>["reason"]): string {
	switch (reason) {
		case "finished":
			return "Nothing to continue: the last run finished.";
		case "stopped":
			return "Nothing to continue: the last run was stopped.";
		case "none":
			return "Nothing to continue.";
		case "busy":
			return "A run is in progress.";
	}
}

/** The custom entry type of the run markers. */
export const RUN_CUSTOM_TYPE = "xpi.run";
/** The custom message type of the note the model sees after a cut-off run. */
export const INTERRUPTED_CUSTOM_TYPE = "xpi.interrupted";

export type RunOutcome = "completed" | "aborted" | "error" | "recovered";

export type RunMarker =
	| { phase: "start"; id: string; at: number }
	| { phase: "end"; id: string; at: number; outcome: RunOutcome };

export const INTERRUPTED_TOOL_RESULT_TEXT =
	"[xpi] Interrupted: the process ended while this tool call ran. It may have run in full, in part or not at all; check its effects before running it again.";
export const INTERRUPTED_NOTE_TEXT =
	"[xpi] The previous run stopped before it finished (the process ended). Check the state of what you were doing, such as half-edited files, before going on.";
export const INTERRUPTED_NOTICE =
	"The last run stopped before it finished (the process ended). Send a message to go on, or /continue to go on without one.";

/** What a run cut off by the end of the process left on the branch. */
export interface InterruptedRun {
	/** The run's id, from its `start` marker. */
	id: string;
	/** When the run started (ms since epoch). */
	startedAt: number;
	/** Tool calls of the run's last assistant message with no tool result on the branch, in call order. */
	danglingToolCalls: ToolCall[];
	/** True when the run's last message is a complete assistant reply with no tool calls: nothing was lost. */
	replyComplete: boolean;
	/** True when an `xpi.interrupted` note already follows the `start` (an earlier recovery was itself cut off). */
	noteWritten: boolean;
}

/** The marker an entry holds, if it is a well-formed `xpi.run` entry. */
export function runMarkerOf(entry: SessionEntry): RunMarker | undefined {
	if (entry.type !== "custom" || entry.customType !== RUN_CUSTOM_TYPE) return undefined;
	const data = entry.data as Partial<RunMarker> | undefined;
	if (!data || typeof data.id !== "string" || typeof data.at !== "number") return undefined;
	if (data.phase === "start") return { phase: "start", id: data.id, at: data.at };
	if (data.phase === "end" && typeof (data as { outcome?: unknown }).outcome === "string") {
		return { phase: "end", id: data.id, at: data.at, outcome: (data as { outcome: RunOutcome }).outcome };
	}
	return undefined;
}

/** The last run marker on the branch and its index, or undefined for a branch without runs (or written before them). */
function lastMarker(branch: readonly SessionEntry[]): { marker: RunMarker; index: number } | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const marker = runMarkerOf(branch[i]);
		if (marker) return { marker, index: i };
	}
	return undefined;
}

/** The `end` marker of run `id` anywhere in the session (on any branch), if it has one. */
function endOf(id: string, entries: readonly SessionEntry[]): Extract<RunMarker, { phase: "end" }> | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const marker = runMarkerOf(entries[i]);
		if (marker?.phase === "end" && marker.id === id) return marker;
	}
	return undefined;
}

/**
 * How the branch's last run ended, if it ended; undefined when it has no run or was cut off. `entries` is the whole
 * session: after `/tree` to a point inside a run, its end is on another branch.
 */
export function lastRunOutcome(
	branch: readonly SessionEntry[],
	entries: readonly SessionEntry[] = branch,
): RunOutcome | undefined {
	const last = lastMarker(branch);
	if (!last) return undefined;
	return last.marker.phase === "end" ? last.marker.outcome : endOf(last.marker.id, entries)?.outcome;
}

/** True when the branch has at least one run marker. */
export function hasRun(branch: readonly SessionEntry[]): boolean {
	return lastMarker(branch) !== undefined;
}

/**
 * The run the branch shows as cut off, or undefined: the branch's last run marker is a `start` whose run has no `end`
 * anywhere in the session (`entries`). A start whose end is on another branch (the leaf moved by `/tree` to a point
 * inside a finished run) is not cut off. A session without markers never is.
 */
export function findInterruptedRun(
	branch: readonly SessionEntry[],
	entries: readonly SessionEntry[] = branch,
): InterruptedRun | undefined {
	const last = lastMarker(branch);
	if (!last || last.marker.phase !== "start" || endOf(last.marker.id, entries)) return undefined;
	const after = branch.slice(last.index + 1);
	// Messages a retry left out of the model's context (an abandoned attempt and its results, `context_edit` with no
	// replacement) are not where the run stands: answering their calls would put results with no call into the context.
	const omitted = new Set(
		after.flatMap((entry) => (entry.type === "context_edit" && entry.replacement === null ? [entry.targetId] : [])),
	);

	let lastMessage: SessionEntry | undefined;
	let lastAssistantIndex = -1;
	let noteWritten = false;
	for (let i = 0; i < after.length; i++) {
		const entry = after[i];
		if (omitted.has(entry.id)) continue;
		if (entry.type === "custom_message" && entry.customType === INTERRUPTED_CUSTOM_TYPE) noteWritten = true;
		if (entry.type === "message" || entry.type === "custom_message") lastMessage = entry;
		// A failed or aborted reply is left out of provider requests; its calls never ran.
		if (entry.type === "message" && entry.message.role === "assistant" && !failedReply(entry.message)) {
			lastAssistantIndex = i;
		}
	}

	const danglingToolCalls: ToolCall[] = [];
	if (lastAssistantIndex >= 0) {
		const assistant = after[lastAssistantIndex];
		if (assistant.type === "message" && assistant.message.role === "assistant") {
			const answered = new Set<string>();
			for (const entry of after.slice(lastAssistantIndex + 1)) {
				if (entry.type === "message" && entry.message.role === "toolResult") answered.add(entry.message.toolCallId);
			}
			for (const block of assistant.message.content) {
				if (block.type === "toolCall" && !answered.has(block.id)) danglingToolCalls.push(block);
			}
		}
	}

	const replyComplete =
		lastMessage?.type === "message" &&
		lastMessage.message.role === "assistant" &&
		!failedReply(lastMessage.message) &&
		!lastMessage.message.content.some((block) => block.type === "toolCall");

	return { id: last.marker.id, startedAt: last.marker.at, danglingToolCalls, replyComplete, noteWritten };
}

/** A reply that ended on an error or an abort: provider requests leave it out. */
function failedReply(message: AssistantMessage): boolean {
	return message.stopReason === "error" || message.stopReason === "aborted";
}

/**
 * The ids of runs started on `path` and not ended on it, oldest first. A new session made from a path (a fork, a
 * clone) closes them: they did not run there, and must not read as cut off by a crash.
 */
export function openRunIds(path: readonly SessionEntry[]): string[] {
	const open = new Map<string, true>();
	for (const entry of path) {
		const marker = runMarkerOf(entry);
		if (marker?.phase === "start") open.set(marker.id, true);
		else if (marker?.phase === "end") open.delete(marker.id);
	}
	return [...open.keys()];
}
