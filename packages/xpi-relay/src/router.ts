// Which role answers the next request. The decision is read from the conversation, so it follows the session branch
// the same way the router state does: a fork or a /tree jump sees the phase of its own branch.

import type { Message, ToolResultMessage } from "xpi-ai";

export interface RelayState {
	phase: "lead" | "worker";
	/** Handovers so far on this branch. */
	round: number;
	/**
	 * The stuck guard's decision for this phase: `"lifted"` (no context limit until the next handover; for the lead also
	 * until the next user message) or `"asked"`
	 * (the worker was asked to hand back; the limit stays). Absent: limited. A state from before the field reads so.
	 */
	limit?: "lifted" | "asked";
}

export const HANDOVER_TOOL = "handover";
export const HANDBACK_TOOL = "handback";
/** The tool whose results the router also reads: a handover made from a codemode script ends the script's result. */
const CODEMODE_TOOL = "codemode";

/** Opens the hand-back record, which is the summary of the compaction that ends a worker phase. */
export const RECORD_MARKER = "<relay-hand-back";
/** In the message `/handover` sends: the user gives the work to the worker without a `handover` call. */
export const USER_HANDOVER_MARKER = "<relay-handover-by-user>";

/** The `signal.type` of a successful `handover` result, and of the codemode result that made the call. */
export const HANDOVER_SIGNAL = "relay.handover";

/** The start of a handover's result text, which the worker's prompt quotes to name the handover. */
export function handoverResultStart(round: number | undefined): string {
	return `Handed over to the worker model (round ${round ?? "N"})`;
}

/** The result text of a handover: a neutral sentence. The handover itself is the `relay.handover` signal. */
export function handoverResult(round: number): string {
	return `${handoverResultStart(round)}: from the next message on the worker answers; the messages above were written by the lead.`;
}

/**
 * The marker line that sessions written before the signal carry as the last line of a `handover` or `codemode` result.
 * Nothing writes it any more; it is still read, so that such a session continues.
 */
export function handoverMarker(round: number): string {
	return `<relay-handover round="${round}"/>`;
}

const HANDOVER_MARKER_LINE = /^<relay-handover round="(\d+)"\/>$/;

function textOf(message: Message): string {
	if (message.role === "assistant") return "";
	const content = message.content;
	if (typeof content === "string") return content;
	return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

/** The round of the handover marker that is the last line of `text`, if there is one. */
export function lastLineHandoverRound(text: string): number | undefined {
	const last = text.trimEnd().split("\n").at(-1)?.trim() ?? "";
	const match = HANDOVER_MARKER_LINE.exec(last);
	return match ? Number(match[1]) : undefined;
}

/**
 * The round a tool result hands over to: `signal.data.round` when its signal is a handover, else the round of the
 * marker line that ends a result of an older session. Undefined for a result that is no handover.
 */
export function handoverRoundOf(message: Pick<ToolResultMessage, "content" | "signal">): number | undefined {
	const { signal } = message;
	if (signal?.type === HANDOVER_SIGNAL) {
		const round = (signal.data as { round?: unknown } | undefined)?.round;
		return typeof round === "number" ? round : undefined;
	}
	const text = message.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
	return lastLineHandoverRound(text);
}

/**
 * The state for the next request. Only what follows the latest response counts: a handover or a hand back takes
 * effect once, on the request right after it.
 *
 * A handover is a `relay.handover` signal on the result of `handover` or `codemode` (the script that called it) that
 * names the next round; a result of an older session ends with the marker line instead. A file the worker reads that
 * contains the marker does not carry a signal or end a result with it, and a handover of another round is not this
 * branch's.
 */
export function nextState(state: RelayState | undefined, messages: readonly Message[]): RelayState {
	const current = state ?? { phase: "lead", round: 0 };
	const tail = messages.slice(messages.findLastIndex((message) => message.role === "assistant") + 1);
	let handover = -1;
	let handBack = -1;
	tail.forEach((message, index) => {
		if (message.role === "toolResult") {
			if ((message.toolName === HANDOVER_TOOL || message.toolName === CODEMODE_TOOL) && !message.isError) {
				if (handoverRoundOf(message) === current.round + 1) handover = index;
			}
			return;
		}
		const text = textOf(message);
		if (text.includes(RECORD_MARKER)) handBack = index;
		if (text.includes(USER_HANDOVER_MARKER)) handover = index;
	});
	if (current.phase === "lead" && handover > handBack) return { phase: "worker", round: current.round + 1 };
	// A retry of the worker's first request still has the previous record in front of the handover: that is no hand back.
	if (current.phase === "worker" && handBack > handover) return { phase: "lead", round: current.round };
	return current;
}
