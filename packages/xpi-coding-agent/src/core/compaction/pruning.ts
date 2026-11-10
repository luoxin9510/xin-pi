/**
 * Drop old tool output before a compaction summary is made.
 *
 * Old file reads and command output are usually most of a long context and the model no longer
 * needs them verbatim. Replacing them with a short placeholder often brings the context under
 * the threshold without summarising the conversation itself. Selection is pure; the session
 * records each choice as a `context_edit`, so the original output stays in the session file.
 */

import type { AgentMessage } from "xpi-agent-core";
import type { ToolResultMessage } from "xpi-ai/compat";
import type { SessionProjection } from "../session-manager.ts";
import { estimateTokens } from "./compaction.ts";

export interface PruneSettings {
	enabled: boolean;
	/** Newest tool output kept whole, in estimated tokens. */
	protectTokens: number;
	/** Nothing is pruned unless the total saving reaches this many estimated tokens. */
	minSavingsTokens: number;
}

/** Results smaller than this are not worth an edit entry. */
export const PRUNE_MIN_RESULT_TOKENS = 50;

const PLACEHOLDER_PREFIX = "[Tool output removed to save context";

export function prunedToolOutputText(tokens: number): string {
	return `${PLACEHOLDER_PREFIX}: about ${tokens} tokens. Run the tool again if you need it.]`;
}

export interface PruneTarget {
	/** Session entry id of the tool result entry. */
	entryId: string;
	/** Estimated tokens of the output being removed. */
	tokens: number;
}

export interface PrunePlan {
	targets: PruneTarget[];
	/** Estimated tokens saved by all targets, net of the placeholders. */
	savedTokens: number;
}

function isPrunedResult(message: ToolResultMessage): boolean {
	const [first] = message.content;
	return message.content.length === 1 && first.type === "text" && first.text.startsWith(PLACEHOLDER_PREFIX);
}

/** Paths of read calls by tool call id, from the assistant messages in the projected context. */
function collectReadPaths(messages: AgentMessage[]): Map<string, string> {
	const paths = new Map<string, string>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type !== "toolCall" || block.name !== "read") continue;
			const path = (block.arguments as { path?: unknown }).path;
			if (typeof path === "string") paths.set(block.id, path);
		}
	}
	return paths;
}

/**
 * Choose the tool results to prune from the current branch's projection (which already starts
 * at the latest compaction).
 *
 * Walk newest to oldest. Results inside the newest `protectTokens` of tool output stay, as do
 * already pruned results (which count toward the window), results under
 * {@link PRUNE_MIN_RESULT_TOKENS}, and reads of skill files. If the total saving is under
 * `minSavingsTokens`, nothing is chosen.
 */
export function planToolOutputPruning(
	projection: SessionProjection,
	settings: PruneSettings,
	isSkillFile: (path: string) => boolean,
): PrunePlan {
	const readPaths = collectReadPaths(projection.messages);
	const targets: PruneTarget[] = [];
	let windowTokens = 0;
	let savedTokens = 0;

	for (let i = projection.entries.length - 1; i >= 0; i--) {
		const { sourceEntry, messages } = projection.entries[i];
		if (sourceEntry.type !== "message" || sourceEntry.message.role !== "toolResult") continue;
		const [message] = messages;
		if (message?.role !== "toolResult") continue; // omitted by an edit

		const tokens = estimateTokens(message);
		if (windowTokens < settings.protectTokens || isPrunedResult(message)) {
			windowTokens += tokens;
			continue;
		}
		const readPath = readPaths.get(message.toolCallId);
		if (tokens < PRUNE_MIN_RESULT_TOKENS || (readPath !== undefined && isSkillFile(readPath))) {
			continue;
		}

		const placeholder: ToolResultMessage = {
			...message,
			content: [{ type: "text", text: prunedToolOutputText(tokens) }],
		};
		const saving = tokens - estimateTokens(placeholder);
		if (saving <= 0) continue;
		targets.push({ entryId: sourceEntry.id, tokens });
		savedTokens += saving;
	}

	if (targets.length === 0 || savedTokens < settings.minSavingsTokens) return { targets: [], savedTokens: 0 };
	return { targets, savedTokens };
}
