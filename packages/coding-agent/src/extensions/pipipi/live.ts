// The assistant message a running child is writing, rebuilt from its rpc `message_update` deltas (docs/json.md,
// "Reconstruct streaming messages"). The message_end that follows replaces it with the finished message, which is
// in the child's session file by then.

import type { ChildEvent } from "./runner.ts";

export type LiveBlock =
	| { type: "text"; text: string }
	| { type: "thinking"; thinking: string }
	| { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };

export interface LiveMessage {
	content: LiveBlock[];
	version: number; // grows with every change, so a drawing can tell whether it is current
}

interface Update {
	type: string;
	contentIndex: number;
	delta?: string;
	content?: string;
	toolCall?: { id: string; name: string; arguments: Record<string, unknown> };
}

// Fold one event into the message in progress. Returns the message after the event; undefined when none is in progress.
export function applyEvent(live: LiveMessage | undefined, event: ChildEvent): LiveMessage | undefined {
	const message = event.message as { role?: string } | undefined;
	if (event.type === "message_start" && message?.role === "assistant") return { content: [], version: 0 };
	if (event.type === "message_end" && message?.role === "assistant") return undefined;
	if (event.type !== "message_update") return live;

	const u = event.assistantMessageEvent as Update;
	const m = live ?? { content: [], version: 0 };
	const at = u.contentIndex;
	switch (u.type) {
		case "text_start":
			m.content[at] = { type: "text", text: "" };
			break;
		case "text_delta":
		case "text_end": {
			m.content[at] ??= { type: "text", text: "" };
			const block = m.content[at] as { text: string };
			block.text = u.type === "text_end" ? u.content! : block.text + u.delta!;
			break;
		}
		case "thinking_start":
			m.content[at] = { type: "thinking", thinking: "" };
			break;
		case "thinking_delta":
		case "thinking_end": {
			m.content[at] ??= { type: "thinking", thinking: "" };
			const block = m.content[at] as { thinking: string };
			block.thinking = u.type === "thinking_end" ? u.content! : block.thinking + u.delta!;
			break;
		}
		case "toolcall_end":
			m.content[at] = {
				type: "toolCall",
				id: u.toolCall!.id,
				name: u.toolCall!.name,
				arguments: u.toolCall!.arguments,
			};
			break;
		default:
			return m; // start, toolcall_start/delta: nothing to draw yet
	}
	m.version++;
	return m;
}
