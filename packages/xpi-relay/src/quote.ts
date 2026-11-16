// The worker's view of the lead's work. Before the handover, the lead's replies are assistant messages; a model reads
// its own role's messages as its own words, and a worker that does so takes itself for the lead ("I have handed the
// work over"). For the worker's requests, everything up to the handover is folded into one user message that quotes
// it, with the lead's parts named. The session is not changed: only the request is.

import {
	getCurrentSystemMessage,
	type ImageContent,
	type Message,
	type SystemMessage,
	type TextContent,
	type UserMessage,
} from "xpi-ai";
import { HANDOVER_TOOL, handoverRoundOf, USER_HANDOVER_MARKER } from "./router.ts";

/** Opens the quote. The worker's prompt names it. */
export const LEAD_WORK_TAG = "relay-lead-work";

const CODEMODE_TOOL = "codemode";

function userText(content: UserMessage["content"]): string {
	if (typeof content === "string") return content;
	return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

/**
 * The index of the message that hands round `round` over: the successful `handover` (or `codemode`) result that
 * names it, or the latest message `/handover` sent. -1 when the context holds neither, as after a compaction that
 * summarized it.
 */
export function handoverIndex(messages: readonly Message[], round: number): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]!;
		if (message.role === "toolResult") {
			if (
				(message.toolName === HANDOVER_TOOL || message.toolName === CODEMODE_TOOL) &&
				!message.isError &&
				handoverRoundOf(message) === round
			)
				return i;
		} else if (message.role === "user" && userText(message.content).includes(USER_HANDOVER_MARKER)) return i;
	}
	return -1;
}

/** Adds text to the quote, joined to the text before it so the quote stays a few blocks long. */
function pushText(blocks: (TextContent | ImageContent)[], text: string): void {
	const last = blocks.at(-1);
	if (last?.type === "text") last.text = `${last.text}\n\n${text}`;
	else blocks.push({ type: "text", text });
}

function pushContent(blocks: (TextContent | ImageContent)[], label: string, content: UserMessage["content"]): void {
	if (typeof content === "string") {
		pushText(blocks, `${label}\n${content}`);
		return;
	}
	let pending: string | undefined = label;
	for (const block of content) {
		if (block.type === "text") {
			pushText(blocks, pending === undefined ? block.text : `${pending}\n${block.text}`);
		} else {
			if (pending !== undefined) pushText(blocks, pending);
			blocks.push(block);
		}
		pending = undefined;
	}
	if (pending !== undefined) pushText(blocks, pending);
}

/**
 * The worker's request with the conversation up to the handover of `round` quoted in one user message, after a leading
 * system message that holds the prompt and tools as of the handover. Undefined when there is nothing to quote: no
 * handover in the context, or no message of the lead before it. The lead's thinking is left out; tool calls and
 * results are kept whole.
 */
export function quoteLeadWork(messages: readonly Message[], round: number): Message[] | undefined {
	const at = handoverIndex(messages, round);
	if (at < 0) return undefined;
	const before = messages.slice(0, at + 1);
	if (!before.some((message) => message.role === "assistant")) return undefined;
	const head: SystemMessage | undefined = getCurrentSystemMessage(before);
	if (!head) return undefined;

	const blocks: (TextContent | ImageContent)[] = [];
	pushText(
		blocks,
		`<${LEAD_WORK_TAG} round="${round}">\nThe conversation before the handover, quoted. Every part marked "Lead" was written by the lead, a different model; you are the worker and wrote none of it.`,
	);
	for (const message of before) {
		switch (message.role) {
			case "system":
				break;
			case "user":
				pushContent(blocks, "User:", message.content);
				break;
			case "assistant":
				for (const block of message.content) {
					if (block.type === "text") {
						if (block.text.trim()) pushText(blocks, `Lead:\n${block.text}`);
					} else if (block.type === "toolCall") {
						pushText(blocks, `Lead called ${block.name}: ${JSON.stringify(block.arguments)}`);
					}
				}
				break;
			case "toolResult":
				pushContent(blocks, `Result of ${message.toolName}${message.isError ? " (error)" : ""}:`, message.content);
				break;
		}
	}
	pushText(blocks, `</${LEAD_WORK_TAG}>`);
	const quote: UserMessage = { role: "user", content: blocks, timestamp: before.at(-1)!.timestamp };
	return [head, quote, ...messages.slice(at + 1)];
}
