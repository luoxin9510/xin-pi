// The TUI line for a checks message: collapsed it is one line, expanded it lists the errors from `details`.

import { Box, Text } from "xpi-tui";
import type { MessageRenderer } from "../../core/extensions/types.ts";
import type { CheckError } from "./parse.ts";
import { formatError } from "./parse.ts";

export const CHECKS_MESSAGE_TYPE = "checks";

export interface ChecksDetails {
	/** The errors shown to the model (at most maxErrors). */
	errors: CheckError[];
	/** Errors beyond the ones listed. */
	more: number;
	/** Commands that timed out and were skipped. */
	timedOut: string[];
}

export function summarize(details: ChecksDetails): string {
	const total = details.errors.length + details.more;
	const parts: string[] = [];
	if (total > 0) parts.push(`${total} new error${total === 1 ? "" : "s"}`);
	if (details.timedOut.length > 0) parts.push(`${details.timedOut.length} timed out`);
	return `checks: ${parts.join(", ")}`;
}

export const renderChecksMessage: MessageRenderer<ChecksDetails> = (message, { expanded, outputPad }, theme) => {
	const details = message.details;
	if (!details) return undefined;
	const hasErrors = details.errors.length + details.more > 0;
	let text = theme.fg(hasErrors ? "error" : "warning", summarize(details));
	if (expanded) {
		for (const error of details.errors) text += `\n${theme.fg("dim", `  ${formatError(error)}`)}`;
		if (details.more > 0) text += `\n${theme.fg("dim", `  and ${details.more} more`)}`;
		for (const command of details.timedOut) text += `\n${theme.fg("dim", `  ${command}: timed out`)}`;
	}
	const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
	box.addChild(new Text(text, 0, 0));
	return box;
};
