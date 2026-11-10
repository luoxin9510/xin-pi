// Which role answers the next request. The decision is read from the conversation, so it follows the session branch
// the same way the router state does: a fork or a /tree jump sees the phase of its own branch.

import type { Message } from "xpi-ai";

export interface RelayState {
	phase: "lead" | "worker";
	/** Handovers so far on this branch. */
	round: number;
}

export const HANDOVER_TOOL = "handover";
export const HANDBACK_TOOL = "handback";

/** Opens the hand-back record, which is the summary of the compaction that ends a worker phase. */
export const RECORD_MARKER = "<relay-hand-back";
/** In the message `/handover` sends: the user gives the work to the worker without a `handover` call. */
export const USER_HANDOVER_MARKER = "<relay-handover-by-user>";

function textOf(message: Message): string {
	if (message.role === "assistant") return "";
	const content = message.content;
	if (typeof content === "string") return content;
	return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

/**
 * The state for the next request. Only what follows the latest response counts: a handover or a hand back takes
 * effect once, on the request right after it.
 */
export function nextState(state: RelayState | undefined, messages: readonly Message[]): RelayState {
	const current = state ?? { phase: "lead", round: 0 };
	const tail = messages.slice(messages.findLastIndex((message) => message.role === "assistant") + 1);
	let handover = -1;
	let handBack = -1;
	tail.forEach((message, index) => {
		if (message.role === "toolResult") {
			if (message.toolName === HANDOVER_TOOL && !message.isError) handover = index;
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
