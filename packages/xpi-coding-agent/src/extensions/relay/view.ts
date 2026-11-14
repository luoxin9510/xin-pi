// What the relay extension keeps on the session branch, and how it reads it back: the entries it writes, the view the
// machine decides on, and what a worker phase left behind (for the hand-back record and the role prompt).

import type { AgentMessage } from "xpi-agent-core";
import type { SessionEntry } from "../../core/session-manager.ts";
import { getVirtualModelState, VIRTUAL_MODEL_STATE_ENTRY } from "../../core/virtual-models.ts";
import { initialView, type RelayView } from "./machine.ts";
import type { Handover, Spoken } from "./record.ts";
import type { RelayState } from "./router.ts";

export const RELAY_PROVIDER = "relay";
export const RELAY_MODEL = "auto";

/** Session entries the extension writes. They hold what the conversation does not, on the branch it belongs to. */
export const HANDOVER_ENTRY = "relay.handover";
export const HANDBACK_ENTRY = "relay.handback";
export const VERIFY_ENTRY = "relay.verify";
export const ROUND_ENTRY = "relay.round";
export const MIXUP_ENTRY = "relay.mixup";
export const STALL_ENTRY = "relay.stall";
export const PAUSE_ENTRY = "relay.pause";
export const RESUME_ENTRY = "relay.resume";
export const TRANSITION_ENTRY = "relay.transition";
/** A direct call of a hand tool that xpi ran as a call from codemode. */
export const DIRECT_ENTRY = "relay.direct";

export interface Handback {
	status: "done" | "blocked";
	report: string;
}

export interface RoundSummary {
	round: number;
	line: string;
}

export interface TransitionData {
	from: string;
	to: string;
	event: string;
	round: number;
	at: number;
}

export function assistantText(message: AgentMessage): string {
	if (message.role !== "assistant") return "";
	return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

function userText(message: AgentMessage): string {
	if (message.role !== "user") return "";
	const content = message.content;
	if (typeof content === "string") return content;
	return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

/** What a worker phase left on the branch, read back when it ends. */
export interface Phase {
	handover?: Handover;
	/** When the handover was made. */
	startedAt?: number;
	/** Time the acceptance commands took in the attempts that failed. */
	acceptanceMs: number;
	/** The worker's `handback` call, unless acceptance failed after it and the worker went on. */
	handback?: Handback;
	failedRounds: number;
	conversation: Spoken[];
	earlierSummary?: string;
	earlierRounds: string[];
	/** One line per repair since the last hand back, for the record. */
	repairs: string[];
}

function repairLine(entry: SessionEntry & { type: "custom" }): string | undefined {
	const data = (entry.data ?? {}) as { tool?: string; role?: string };
	switch (entry.customType) {
		case MIXUP_ENTRY:
			return `The ${data.role ?? "model"} called ${data.tool ?? "a hand tool"} of the other role; it was corrected.`;
		case STALL_ENTRY:
			return `The ${data.role ?? "model"} stopped after a relay error; it was continued.`;
		case DIRECT_ENTRY:
			return `The ${data.role ?? "model"} called ${data.tool ?? "a hand tool"} directly; it was run through codemode.`;
		default:
			return undefined;
	}
}

export function readPhase(branch: readonly SessionEntry[]): Phase {
	const phase: Phase = { failedRounds: 0, acceptanceMs: 0, conversation: [], earlierRounds: [], repairs: [] };
	let working = false;
	for (const entry of branch) {
		if (entry.type === "custom") {
			if (entry.customType === HANDOVER_ENTRY) {
				phase.handover = entry.data as Handover;
				phase.startedAt = Date.parse(entry.timestamp) || undefined;
				phase.acceptanceMs = 0;
				phase.handback = undefined;
				phase.failedRounds = 0;
				working = true;
			} else if (entry.customType === HANDBACK_ENTRY) {
				phase.handback = entry.data as Handback;
			} else if (entry.customType === VERIFY_ENTRY) {
				phase.failedRounds++;
				phase.acceptanceMs += (entry.data as { ms?: number } | undefined)?.ms ?? 0;
				phase.handback = undefined;
			} else if (entry.customType === ROUND_ENTRY) {
				phase.earlierRounds.push((entry.data as RoundSummary).line);
				working = false;
				phase.repairs = [];
			} else {
				const line = repairLine(entry);
				if (line) phase.repairs.push(line);
			}
		} else if (entry.type === "compaction") {
			// The record of an earlier round is rebuilt from the entries; only an ordinary summary is carried along.
			if (!(entry.details as { relay?: boolean } | undefined)?.relay) phase.earlierSummary = entry.summary;
		} else if (entry.type === "message") {
			const user = userText(entry.message).trim();
			if (user) phase.conversation.push({ who: "user", text: user });
			const lead = working ? "" : assistantText(entry.message).trim();
			if (lead) phase.conversation.push({ who: "lead", text: lead });
		}
	}
	return phase;
}

/** The router state stored on the branch. */
export function storedState(branch: readonly SessionEntry[]): RelayState {
	return (
		(getVirtualModelState(branch, RELAY_PROVIDER, RELAY_MODEL) as RelayState | undefined) ?? {
			phase: "lead",
			round: 0,
		}
	);
}

/**
 * The view the machine decides on. The stored router state changes only when the next request is routed, so a hand-off
 * made since then is read from its entry: a `relay.handover` or `relay.handback` appended after the latest router-state,
 * `relay.transition` or `relay.verify` entry is pending. Mixups and stalls count since the latest handover or
 * transition; the relay is paused when the latest of `relay.pause` and `relay.resume` is a pause.
 */
export function readView(branch: readonly SessionEntry[], userAsked = false): RelayView {
	const view = initialView(storedState(branch));
	let pendingKind: "handover" | "handback" | undefined;
	let blocked = false;
	for (const entry of branch) {
		// A hand-off whose response was cut short (Esc, an error) never reached the next request: a user message after
		// it means the run started over, and the hand-off did not happen.
		if (entry.type === "message" && entry.message.role === "user") pendingKind = undefined;
		if (entry.type !== "custom") continue;
		switch (entry.customType) {
			case VIRTUAL_MODEL_STATE_ENTRY:
				// The state of another virtual model leaves this view alone.
				if ((entry.data as { provider?: string } | undefined)?.provider !== RELAY_PROVIDER) break;
				pendingKind = undefined;
				view.mixups = 0;
				view.stalls = 0;
				view.paused = false;
				break;
			case TRANSITION_ENTRY:
				pendingKind = undefined;
				view.mixups = 0;
				view.stalls = 0;
				view.paused = false;
				break;
			case VERIFY_ENTRY:
				pendingKind = undefined;
				blocked = false;
				break;
			case HANDOVER_ENTRY:
				pendingKind = "handover";
				view.mixups = 0;
				view.stalls = 0;
				view.paused = false;
				break;
			case HANDBACK_ENTRY:
				pendingKind = "handback";
				blocked = (entry.data as Handback | undefined)?.status === "blocked";
				break;
			case MIXUP_ENTRY:
				view.mixups++;
				break;
			case STALL_ENTRY:
				view.stalls++;
				break;
			case PAUSE_ENTRY:
				view.paused = true;
				break;
			case RESUME_ENTRY:
				view.paused = false;
				break;
		}
	}
	view.pending = pendingKind;
	view.blocked = pendingKind === "handback" && blocked;
	view.userAsked = userAsked;
	return view;
}

/**
 * Whether the latest turn ended right after a `relay.mixup`: after the latest mixup entry the branch holds only the
 * results of that turn's calls and one final assistant message without tool calls. The error is a nested result inside
 * a codemode result, so it is read from the entry, not from the transcript.
 */
export function endedAfterRelayError(branch: readonly SessionEntry[]): boolean {
	const index = branch.findLastIndex((entry) => entry.type === "custom" && entry.customType === MIXUP_ENTRY);
	if (index < 0) return false;
	const after = branch.slice(index + 1);
	const last = after.at(-1);
	if (!last || last.type !== "message" || last.message.role !== "assistant") return false;
	if (last.message.content.some((block) => block.type === "toolCall")) return false;
	return after.every((entry, i) => {
		if (entry.type !== "message") return false;
		return i === after.length - 1 ? true : entry.message.role === "toolResult";
	});
}

/** This round's transitions and repairs, oldest first, one line each: for `/relay`. */
export function describeHistory(branch: readonly SessionEntry[], now = Date.now()): string[] {
	const lines: string[] = [];
	// The latest round: from the end of the one before the latest handover on (so a direct call that came first counts).
	const handover = branch.findLastIndex((entry) => entry.type === "custom" && entry.customType === HANDOVER_ENTRY);
	const from =
		handover < 0
			? 0
			: branch
					.slice(0, handover)
					.findLastIndex((entry) => entry.type === "custom" && entry.customType === ROUND_ENTRY) + 1;
	for (const entry of branch.slice(from)) {
		if (entry.type !== "custom") continue;
		const data = (entry.data ?? {}) as Partial<TransitionData> & { tool?: string; role?: string; round?: number };
		const ago = (at: number | undefined) => {
			const ms = now - (at ?? (Date.parse(entry.timestamp) || now));
			return ms < 1000 ? "just now" : `${Math.round(ms / 1000)}s ago`;
		};
		switch (entry.customType) {
			case TRANSITION_ENTRY:
				lines.push(`${data.from} → ${data.to} (round ${data.round}, ${data.event}), ${ago(data.at)}`);
				break;
			case MIXUP_ENTRY:
			case STALL_ENTRY:
			case DIRECT_ENTRY: {
				const line = repairLine(entry);
				if (line) lines.push(`repair: ${line}`);
				break;
			}
			case PAUSE_ENTRY:
				lines.push(`paused (round ${data.round})`);
				break;
			case RESUME_ENTRY:
				lines.push(`resumed (round ${data.round})`);
				break;
		}
	}
	return lines;
}
