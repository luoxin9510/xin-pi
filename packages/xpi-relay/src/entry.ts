// The shape of a session entry that relay reads. The host's own entry type must be assignable to `RelayEntry`; the
// package never writes entries of this shape (it hands the host drafts, see `host.ts`).

import type { AgentMessage } from "xpi-agent-core";

interface EntryBase {
	id: string;
	timestamp: string;
}

export interface MessageEntry extends EntryBase {
	type: "message";
	message: AgentMessage;
}

export interface CustomEntry extends EntryBase {
	type: "custom";
	customType: string;
	data?: unknown;
}

export interface CustomMessageEntry extends EntryBase {
	type: "custom_message";
	customType: string;
	content: unknown;
	display: boolean;
}

export interface CompactionEntry extends EntryBase {
	type: "compaction";
	summary: string;
	details?: unknown;
	/** The route context limit that triggered this compaction, written by the core. */
	contextLimit?: number;
}

/** Entry types relay does not read. Listed so that every one is a member of the union and `type` still narrows. */
export interface OtherEntry extends EntryBase {
	type:
		| "thinking_level_change"
		| "model_change"
		| "usage"
		| "branch_summary"
		| "context_edit"
		| "label"
		| "session_info";
}

export type RelayEntry = MessageEntry | CustomEntry | CustomMessageEntry | CompactionEntry | OtherEntry;
