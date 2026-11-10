// The hand-back record: what the lead reads in place of the conversation when a worker phase ends. The lead's own
// words (its handover note, its earlier replies) and the user's are kept as written; the worker contributes its report;
// the rest is facts a machine produced (the diff, the acceptance commands' output).

import { RECORD_MARKER } from "./router.ts";

/** What the lead wrote in its `handover` call, plus where the work tree stood. Stored as a session entry. */
export interface Handover {
	round: number;
	plan: string;
	acceptance: string[];
	criteria?: string;
	findings?: string;
	stopWhen?: string;
	/** Commit to diff against (a snapshot of the work tree at the handover). Absent outside a git repository. */
	base?: string;
	/** Given by the user with /handover, not by the lead. */
	byUser?: boolean;
}

export interface AcceptanceResult {
	command: string;
	/** Exit status; null when the command was killed. */
	code: number | null;
	timedOut: boolean;
	/** The end of the combined output. */
	output: string;
}

export interface Spoken {
	who: "user" | "lead";
	text: string;
}

export interface RecordInput {
	handover: Handover;
	conversation: Spoken[];
	/** Summary of an ordinary compaction earlier on the branch. */
	earlierSummary?: string;
	/** One line per earlier round. */
	earlierRounds: string[];
	status: "done" | "blocked" | "stopped";
	report: string;
	changes: string;
	acceptance: AcceptanceResult[];
	/** Times the acceptance commands failed and the work went back to the worker. */
	failedRounds: number;
}

const USER_CHARS = 12_000;
const LEAD_CHARS = 3000;
const CONVERSATION_CHARS = 40_000;

function clip(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}\n[... ${text.length - max} more characters removed]`;
}

/** The user's and the lead's words, oldest lead replies dropped first when the whole is too long. */
export function renderConversation(conversation: readonly Spoken[]): string {
	const items = conversation.map((item) => ({
		who: item.who,
		text: clip(item.text.trim(), item.who === "user" ? USER_CHARS : LEAD_CHARS),
	}));
	let size = items.reduce((sum, item) => sum + item.text.length, 0);
	let dropped = 0;
	for (let i = 0; i < items.length && size > CONVERSATION_CHARS; i++) {
		if (items[i]!.who !== "lead" || items[i]!.text === "") continue;
		size -= items[i]!.text.length;
		items[i]!.text = "";
		dropped++;
	}
	const lines = items
		.filter((item) => item.text !== "")
		.map((item) => `[${item.who === "user" ? "User" : "Lead"}]: ${item.text}`);
	if (dropped > 0) lines.unshift(`[${dropped} earlier lead replies removed for length]`);
	return lines.join("\n\n");
}

export function describeAcceptance(result: AcceptanceResult): string {
	const outcome = result.timedOut
		? "timed out"
		: result.code === 0
			? "passed (exit 0)"
			: `failed (exit ${result.code})`;
	const output = result.output.trim();
	return `\`${result.command}\`: ${outcome}${output ? `\n\`\`\`\n${output}\n\`\`\`` : ""}`;
}

export function acceptancePassed(results: readonly AcceptanceResult[]): boolean {
	return results.every((result) => result.code === 0 && !result.timedOut);
}

function section(title: string, body: string | undefined): string[] {
	return body?.trim() ? [`### ${title}`, body.trim(), ""] : [];
}

export function buildRecord(input: RecordInput): string {
	const { handover } = input;
	const lines: string[] = [
		`${RECORD_MARKER} round="${handover.round}" status="${input.status}">`,
		`The worker model finished round ${handover.round} and handed back. Its transcript is not kept: this record replaces the conversation so far.`,
		"",
	];
	if (input.earlierSummary?.trim()) lines.push("## Earlier summary", input.earlierSummary.trim(), "");
	const conversation = renderConversation(input.conversation);
	if (conversation)
		lines.push("## Conversation (the user's and the lead's words; tool activity removed)", conversation, "");
	if (input.earlierRounds.length > 0) lines.push("## Earlier rounds", ...input.earlierRounds.map((l) => `- ${l}`), "");
	lines.push(
		handover.byUser
			? "## Handover (given by the user with /handover)"
			: "## Handover note (written by the lead, word for word)",
		...section("Plan", handover.plan),
		...section("Acceptance commands", handover.acceptance.map((command) => `- \`${command}\``).join("\n")),
		...section("Criteria", handover.criteria),
		...section("Findings", handover.findings),
		...section("Stop when", handover.stopWhen),
		`## Worker report (status: ${input.status})`,
		input.report.trim() || "(the worker gave no report)",
		"",
		"## Changes since the handover",
		input.changes.trim() || "(none)",
		"",
	);
	if (input.acceptance.length > 0) {
		lines.push(
			"## Acceptance",
			...(input.failedRounds > 0
				? [
						`The commands failed ${input.failedRounds} time(s) before this run and the work went back to the worker.`,
					]
				: []),
			...input.acceptance.map(describeAcceptance),
			"",
		);
	} else if (handover.acceptance.length > 0) {
		lines.push("## Acceptance", "Not run: the worker handed back before it was done.", "");
	}
	lines.push("</relay-hand-back>");
	return lines.join("\n");
}
