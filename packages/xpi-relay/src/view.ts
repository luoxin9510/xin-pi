// What the relay extension keeps on the session branch, and how it reads it back: the entries it writes, the view the
// machine decides on, and what a worker phase left behind (for the hand-back record and the role prompt).

import type { AgentMessage } from "xpi-agent-core";
import { initialView, type RelayView } from "./definition.ts";
import type { CustomEntry, RelayEntry } from "./entry.ts";
import type { Handover, Spoken } from "./record.ts";
import { handoverRoundOf, type RelayState } from "./router.ts";

/**
 * The name of the entry that holds a virtual model's router state. It is the host's constant
 * (`VIRTUAL_MODEL_STATE_ENTRY`, pinned by a test in the coding agent): the view resets its overlays when it passes one.
 */
export const VIRTUAL_MODEL_STATE_ENTRY = "pi.virtual-model-state";

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
/** The stuck guard acted on a context limit: `{ round, phase, action, compactions }`. */
export const LIMIT_ENTRY = "relay.limit";
/** A direct call of a hand tool that xpi ran as a call from codemode. */
export const DIRECT_ENTRY = "relay.direct";
/** A pending hand-off that never took effect. */
export const VOID_ENTRY = "relay.void";

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

function repairLine(entry: CustomEntry): string | undefined {
	const data = (entry.data ?? {}) as { tool?: string; role?: string; reason?: string };
	switch (entry.customType) {
		case MIXUP_ENTRY:
			return `The ${data.role ?? "model"} called ${data.tool ?? "a hand tool"} of the other role; it was corrected.`;
		case STALL_ENTRY:
			return data.reason === "idle"
				? `The ${data.role ?? "model"} stopped without doing any work; it was continued.`
				: `The ${data.role ?? "model"} stopped after a relay error; it was continued.`;
		case DIRECT_ENTRY:
			return `The ${data.role ?? "model"} called ${data.tool ?? "a hand tool"} directly; it was run through codemode.`;
		default:
			return undefined;
	}
}

export function readPhase(branch: readonly RelayEntry[]): Phase {
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
			// The record of an earlier round is rebuilt from the entries; only an ordinary summary is carried along. A
			// summary written under a limit while the worker has the work is the worker's working memory, not the
			// lead's: the lead never saw what it summarizes. One written under the lead's own limit is the lead's.
			const isRecord = (entry.details as { relay?: boolean } | undefined)?.relay;
			const workers = working && entry.contextLimit !== undefined;
			if (!isRecord && !workers) phase.earlierSummary = entry.summary;
		} else if (entry.type === "message") {
			const user = userText(entry.message).trim();
			if (user) phase.conversation.push({ who: "user", text: user });
			const lead = working ? "" : assistantText(entry.message).trim();
			if (lead) phase.conversation.push({ who: "lead", text: lead });
		}
	}
	return phase;
}

/** The router state stored on the branch: the latest state entry of the relay model. */
export function storedState(branch: readonly RelayEntry[]): RelayState {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "custom" || entry.customType !== VIRTUAL_MODEL_STATE_ENTRY) continue;
		const data = entry.data as { provider?: string; modelId?: string; state?: unknown } | undefined;
		if (data?.provider === RELAY_PROVIDER && data.modelId === RELAY_MODEL) return data.state as RelayState;
	}
	return { phase: "lead", round: 0 };
}

/**
 * The view the machine decides on. The stored router state changes only when the next request is routed, so a hand-off
 * made since then is read from its entry: a `relay.handover` or `relay.handback` appended after the latest router-state,
 * `relay.transition` or `relay.verify` entry is pending. Mixups and stalls count since the latest handover or
 * transition; the relay is paused when the latest of `relay.pause` and `relay.resume` is a pause.
 */
export function readView(branch: readonly RelayEntry[], userAsked = false): RelayView {
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
				blocked = false;
				view.mixups = 0;
				view.stalls = 0;
				view.paused = false;
				break;
			case TRANSITION_ENTRY:
				pendingKind = undefined;
				blocked = false;
				view.mixups = 0;
				view.stalls = 0;
				view.paused = false;
				break;
			case VERIFY_ENTRY:
			case VOID_ENTRY:
				pendingKind = undefined;
				blocked = false;
				break;
			case HANDOVER_ENTRY:
				pendingKind = "handover";
				blocked = false;
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
	// A blocked hand back stays blocked when a user message cleared its pending state before the run ended.
	view.blocked = blocked;
	view.userAsked = userAsked;
	return view;
}

/**
 * Whether the latest turn ended right after a `relay.mixup`: after the latest mixup entry the branch holds only the
 * results of that turn's calls and one final assistant message without tool calls. The error is a nested result inside
 * a codemode result, so it is read from the entry, not from the transcript.
 */
export function endedAfterRelayError(branch: readonly RelayEntry[]): boolean {
	const index = branch.findLastIndex((entry) => entry.type === "custom" && entry.customType === MIXUP_ENTRY);
	if (index < 0) return false;
	// Entries that are no part of the conversation (a `codemode-store` entry, say) do not count.
	const after = branch.slice(index + 1).filter((entry) => entry.type === "message" || entry.type !== "custom");
	const last = after.at(-1);
	if (!last || last.type !== "message" || last.message.role !== "assistant") return false;
	if (last.message.content.some((block) => block.type === "toolCall")) return false;
	return after.every((entry, i) => {
		if (entry.type !== "message") return false;
		return i === after.length - 1 ? true : entry.message.role === "toolResult";
	});
}

/** This round's transitions and repairs, oldest first, one line each: for `/relay`. */
export function describeHistory(branch: readonly RelayEntry[], now = Date.now()): string[] {
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

/** Whether the latest tool results carry the handover that made round `round` (its signal, or the marker line of an older session). */
export function handoverLanded(branch: readonly RelayEntry[], round: number): boolean {
	const lastAssistant = branch.findLastIndex(
		(entry) => entry.type === "message" && entry.message.role === "assistant",
	);
	return branch.slice(lastAssistant + 1).some((entry) => {
		if (entry.type !== "message" || entry.message.role !== "toolResult") return false;
		const message = entry.message;
		if (message.isError || (message.toolName !== "handover" && message.toolName !== "codemode")) return false;
		return handoverRoundOf(message) === round;
	});
}

/** Whether the worker has made no tool call since the latest handover: it answered with text only. */
export function workerMadeNoCalls(branch: readonly RelayEntry[]): boolean {
	const handover = branch.findLastIndex((entry) => entry.type === "custom" && entry.customType === HANDOVER_ENTRY);
	if (handover < 0) return false;
	return !branch
		.slice(handover + 1)
		.some(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "assistant" &&
				entry.message.content.some((block) => block.type === "toolCall"),
		);
}

/**
 * The summaries written under a context limit in the current phase of `role`: the compaction entries with
 * `contextLimit` after the latest handover (worker) or the latest hand-back record, or the start of the branch (lead).
 * They stay on the branch, so the count follows it.
 */
export function limitSummaries(branch: readonly RelayEntry[], role: "lead" | "worker"): number {
	const boundary = branch.findLastIndex((entry) =>
		role === "worker"
			? entry.type === "custom" && entry.customType === HANDOVER_ENTRY
			: entry.type === "compaction" && (entry.details as { relay?: boolean } | undefined)?.relay === true,
	);
	return branch.slice(boundary + 1).filter((entry) => entry.type === "compaction" && entry.contextLimit !== undefined)
		.length;
}

/** What the latest worker round did to its context, read from the branch after the latest handover. */
export interface RoundContext {
	/** The largest prompt (input, cache read and cache write tokens) of a worker request; undefined without usage. */
	peak?: number;
	/** Summaries written under the limit. */
	summaries: number;
	/** What the stuck guard did, if it acted. */
	action?: "lifted" | "handback";
}

export function roundContext(branch: readonly RelayEntry[]): RoundContext {
	const handover = branch.findLastIndex((entry) => entry.type === "custom" && entry.customType === HANDOVER_ENTRY);
	const result: RoundContext = { summaries: limitSummaries(branch, "worker") };
	for (const entry of branch.slice(handover + 1)) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			const usage = (entry.message as { usage?: { input: number; cacheRead: number; cacheWrite: number } }).usage;
			if (!usage) continue;
			const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
			if (result.peak === undefined || prompt > result.peak) result.peak = prompt;
		} else if (entry.type === "custom" && entry.customType === LIMIT_ENTRY) {
			const action = (entry.data as { action?: string } | undefined)?.action;
			if (action === "lifted" || action === "handback") result.action = action;
		}
	}
	return result;
}
