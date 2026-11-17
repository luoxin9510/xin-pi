// What each role is told, as the `relay` section of the system prompt (one per role, the same text for every request of
// a role in a round), and the short texts of corrections and reminders. Each role learns only its own hand tool.

import type { RelayConfig } from "./config.ts";
import { type ContextLimits, leadFacts } from "./facts.ts";
import { LEAD_WORK_TAG } from "./quote.ts";
import type { Handover } from "./record.ts";
import { HANDBACK_TOOL, HANDOVER_TOOL, handoverResultStart } from "./router.ts";

/** The section name in the leading system message. */
export const RELAY_SECTION = "relay";

type Priced = Parameters<typeof leadFacts>[1];

/** `handover` and `handback` take these fields; the tool schemas and the prompt both read them from here. */
export const HANDOVER_FIELDS = {
	plan: "The steps, in order, specific enough to follow without the lead.",
	acceptance:
		"Shell commands that must exit 0 when the work is done (tests, a type check, a grep). Run in the session's directory after the worker hands back.",
	criteria: "What done means beyond the commands. You review the result against this.",
	findings: "What you learned and must not lose: the files involved, constraints, traps.",
	stopWhen: "When the worker must stop and hand back instead of pushing on.",
} as const;

export const HANDBACK_FIELDS = {
	status: '"done" or "blocked".',
	report: "What you changed, where you left the plan and why, what is unresolved.",
} as const;

/** How a role calls its tool: from a codemode script, or directly when codemode is off. */
export function callOf(tool: string, direct: boolean): string {
	return direct ? `${tool}({...})` : `tools.${tool}({...})`;
}

function fieldLines(fields: Record<string, string>, optional: readonly string[]): string[] {
	return Object.entries(fields).map(
		([name, text]) => `- ${name}${optional.includes(name) ? " (optional)" : ""}: ${text}`,
	);
}

/** `tools.handover({...}) from codemode`, or `handover({...})` when codemode is off. */
function invoke(tool: string, isDirect: boolean): string {
	return `${callOf(tool, isDirect)}${isDirect ? "" : " from codemode"}`;
}

export function leadSection(
	config: RelayConfig,
	lead: Priced,
	worker: Priced,
	isDirect: boolean,
	limits: ContextLimits = {},
): string {
	return [
		`<relay role="lead">`,
		`You are the lead in relay mode; the worker is ${config.worker}. To give the work away call ${invoke(HANDOVER_TOOL, isDirect)}.`,
		...fieldLines(HANDOVER_FIELDS, ["acceptance", "criteria", "findings", "stopWhen"]),
		...leadFacts(config, lead, worker, limits),
		`</relay>`,
	].join("\n");
}

function section(title: string, body: string | undefined): string[] {
	return body?.trim() ? [`${title}:`, body.trim()] : [];
}

export function workerSection(
	handover: Handover | undefined,
	config: RelayConfig,
	isDirect: boolean,
	quoted = false,
): string {
	const lines = [
		`<relay role="worker">`,
		`You are the worker in relay mode. When done or stuck, call ${invoke(HANDBACK_TOOL, isDirect)}.`,
		quoted
			? `The handover has already happened. The conversation before it is quoted in the \`<${LEAD_WORK_TAG}>\` message: the lead, a different model, wrote it, not you. Do not continue it, and do not wait for a worker, because you are the worker. Start on the plan now.`
			: `The handover has already happened. The assistant messages before ${
					handover?.byUser
						? "the `<relay-handover-by-user>` line"
						: `the handover (a tool result that contains \`${handoverResultStart(handover?.round)}\`, or its mention in a summary of this conversation)`
				} were written by the lead, a different model, not by you: do not continue them, and do not wait for a worker, because you are the worker. Start on the plan now.`,
		...fieldLines(HANDBACK_FIELDS, []),
	];
	if (handover) {
		lines.push(
			"",
			handover.byUser
				? `The handover (round ${handover.round}, given by the user):`
				: `The handover (round ${handover.round}, from the lead):`,
			...section("Plan", handover.plan),
			...section("Criteria", handover.criteria),
			...section("Findings", handover.findings),
			...section("Stop when", handover.stopWhen),
		);
	}
	lines.push(
		"",
		"Your duties:",
		"- Carry out the plan as written. Everything earlier in this conversation is context you may rely on.",
		`- When the work is done, hand back with status "done" and a report: what you changed, where you left the plan and why, what is unresolved.`,
		`- When you cannot go on (the plan does not fit what you find, a stop condition is met, the same failure keeps coming back), hand back with status "blocked" and say what stops you. Do not improvise a different design.`,
	);
	if (handover && handover.acceptance.length > 0) {
		lines.push(
			`- After your hand back these commands are run and must exit 0; run them yourself first. If they fail, their output comes back to you (at most ${config.maxRounds} times):`,
			...handover.acceptance.map((command) => `  - \`${command}\``),
		);
	}
	lines.push(`</relay>`);
	return lines.join("\n");
}

/** The error a role gets for calling the other role's tool. */
export function correction(tool: "handover" | "handback", isDirect: boolean): string {
	return tool === "handover"
		? `Only the lead hands over. You are the worker: do the work in your handover, then call ${callOf(HANDBACK_TOOL, isDirect)}.`
		: `Only the worker hands back. You are the lead: answer the user, or call ${callOf(HANDOVER_TOOL, isDirect)} to give the work away.`;
}

/** What a role is told when it stopped right after a relay error and is continued. */
export function reminder(role: "lead" | "worker", isDirect: boolean, reason: "error" | "idle" = "error"): string {
	if (role === "worker" && reason === "idle") {
		return `You answered without doing any work. You are the worker, and the handover has already happened: the earlier assistant messages were the lead's. Start on the plan in your system prompt now, and when done or stuck call ${invoke(HANDBACK_TOOL, isDirect)}.`;
	}
	return role === "worker"
		? `You stopped after a relay error. You are the worker: carry on with the plan in your system prompt, and when done or stuck call ${invoke(HANDBACK_TOOL, isDirect)}.`
		: `You stopped after a relay error. You are the lead: answer the user, or call ${invoke(HANDOVER_TOOL, isDirect)} to give the work away.`;
}
