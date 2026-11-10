// relay extension entry: the virtual model `relay/auto`. A strong model (the lead) explores, plans and reviews; a
// cheap model (the worker) builds. The lead gives the work away with the `handover` tool; when the worker's run ends,
// the acceptance commands are run here and the conversation is compacted to a hand-back record, which is all the lead
// reads of the worker's phase. See docs/relay.md.

import { Type } from "typebox";
import type { AgentMessage } from "xpi-agent-core";
import type { Api, Model } from "xpi-ai";
import type { ExtensionAPI, ExtensionContext, SessionBoundaryDraft } from "../../core/extensions/types.ts";
import type { SessionEntry } from "../../core/session-manager.ts";
import { getVirtualModelState } from "../../core/virtual-models.ts";
import { type RelayConfig, readRelayConfig, splitModelRef } from "./config.ts";
import {
	type AcceptanceResult,
	acceptancePassed,
	buildRecord,
	describeAcceptance,
	type Handover,
	type Spoken,
} from "./record.ts";
import { HANDBACK_TOOL, HANDOVER_TOOL, nextState, type RelayState, USER_HANDOVER_MARKER } from "./router.ts";
import { describeChanges, runAcceptance, snapshot } from "./workspace.ts";

export const RELAY_PROVIDER = "relay";
export const RELAY_MODEL = "auto";

/** Session entries the extension writes. They hold what the conversation does not, on the branch it belongs to. */
export const HANDOVER_ENTRY = "relay.handover";
const HANDBACK_ENTRY = "relay.handback";
const VERIFY_ENTRY = "relay.verify";
const ROUND_ENTRY = "relay.round";

interface Handback {
	status: "done" | "blocked";
	report: string;
}

interface RoundSummary {
	round: number;
	line: string;
}

function isRelay(model: { provider: string; id: string } | undefined): boolean {
	return model?.provider === RELAY_PROVIDER && model.id === RELAY_MODEL;
}

function firstLine(text: string, max: number): string {
	const line = text.trim().split("\n")[0] ?? "";
	return line.length <= max ? line : `${line.slice(0, max)}...`;
}

function assistantText(message: AgentMessage): string {
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
interface Phase {
	handover?: Handover;
	/** The worker's `handback` call, unless acceptance failed after it and the worker went on. */
	handback?: Handback;
	failedRounds: number;
	conversation: Spoken[];
	earlierSummary?: string;
	earlierRounds: string[];
}

export function readPhase(branch: readonly SessionEntry[]): Phase {
	const phase: Phase = { failedRounds: 0, conversation: [], earlierRounds: [] };
	let working = false;
	for (const entry of branch) {
		if (entry.type === "custom") {
			if (entry.customType === HANDOVER_ENTRY) {
				phase.handover = entry.data as Handover;
				phase.handback = undefined;
				phase.failedRounds = 0;
				working = true;
			} else if (entry.customType === HANDBACK_ENTRY) {
				phase.handback = entry.data as Handback;
			} else if (entry.customType === VERIFY_ENTRY) {
				phase.failedRounds++;
				phase.handback = undefined;
			} else if (entry.customType === ROUND_ENTRY) {
				phase.earlierRounds.push((entry.data as RoundSummary).line);
				working = false;
			}
		} else if (entry.type === "compaction") {
			// The record of an earlier round is rebuilt from the entries; only an ordinary summary is carried along.
			if (!(entry.details as { relay?: boolean } | undefined)?.relay) phase.earlierSummary = entry.summary;
		} else if (entry.type === "message") {
			const user = userText(entry.message).trim();
			if (user) phase.conversation.push({ who: "user", text: user });
			const lead = working ? "" : assistantText(entry.message).trim();
			if (lead) phase.conversation.push({ who: "lead", text: lead });
		}
	}
	return phase;
}

const LEAD_RULES = [
	`With the relay model you are the lead: explore, decide, then call ${HANDOVER_TOOL} so that a cheaper worker model carries the plan out. Your tokens are the expensive ones: spend them on reading what the decision depends on, on the plan and on the review, not on mechanical edits.`,
	`Call ${HANDOVER_TOOL} once the plan is settled and more than a few edits remain. A task of a few edits you finish yourself.`,
	`The worker reads this whole conversation, but write the ${HANDOVER_TOOL} note to stand alone: after the worker is done the conversation is replaced by a record that keeps your note, the user's messages and your replies, the worker's report, the diff and the acceptance output. What you learned and want to keep goes into findings.`,
	`After a hand back, judge the diff against your criteria. Then either answer the user, fix a small thing yourself, or call ${HANDOVER_TOOL} again with a correction.`,
];

function workerBrief(handover: Handover, config: RelayConfig): string {
	const lines = [
		`Handover accepted (round ${handover.round}). From this message on a different model answers: the worker.`,
		"",
		"You are the worker. Carry out the plan in the handover call above, as written. Everything earlier in this conversation is context you may rely on.",
		`- Do not call ${HANDOVER_TOOL}: only the lead hands over.`,
		`- When the work is done, call ${HANDBACK_TOOL} with status "done" and a report: what you changed, where you left the plan and why, what is unresolved.`,
		`- When you cannot go on (the plan does not fit what you find, a stop condition is met, the same failure keeps coming back), call ${HANDBACK_TOOL} with status "blocked" and say what stops you. Do not improvise a different design.`,
	];
	if (handover.acceptance.length > 0) {
		lines.push(
			`- After your hand back these commands are run and must exit 0; run them yourself first. If they fail, their output comes back to you (at most ${config.maxRounds} times):`,
			...handover.acceptance.map((command) => `  - \`${command}\``),
		);
	}
	return lines.join("\n");
}

export default function relay(pi: ExtensionAPI) {
	// Subagent children are workers already: they never get the relay model or its tools.
	if (process.env.XPI_SUBAGENT_DEPTH) return;

	const config = () => readRelayConfig((pi.getSettings() as { relay?: unknown }).relay);
	const stateOf = (ctx: ExtensionContext): RelayState =>
		(getVirtualModelState(ctx.sessionManager.getBranch(), RELAY_PROVIDER, RELAY_MODEL) as RelayState | undefined) ?? {
			phase: "lead",
			round: 0,
		};
	const notify = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info") => {
		if (ctx.hasUI) ctx.ui.notify(message, level);
	};
	// /handback: the next end of a worker run hands back without running the acceptance commands.
	let forced = false;

	const physical = (ctx: ExtensionContext, ref: string, key: string): Model<Api> => {
		const { provider, id } = splitModelRef(ref);
		const model = ctx.modelRegistry.find(provider, id);
		if (!model) throw new Error(`relay.${key}: model ${ref} is not in the catalog`);
		return model;
	};

	pi.registerVirtualModel<RelayState>({
		provider: RELAY_PROVIDER,
		id: RELAY_MODEL,
		name: "Relay (lead plans and reviews, worker builds)",
		route(request, ctx) {
			const cfg = config();
			// Requests outside the agent loop (the summary of an ordinary compaction) are not the lead's work.
			if (request.reason === "direct") {
				return { model: physical(ctx, cfg.worker, "worker"), thinkingLevel: cfg.workerThinking };
			}
			const state = nextState(request.state, request.messages);
			if (state.phase === "worker") {
				return { model: physical(ctx, cfg.worker, "worker"), thinkingLevel: cfg.workerThinking, state };
			}
			return {
				model: physical(ctx, cfg.lead, "lead"),
				thinkingLevel: state.round === 0 ? cfg.leadThinking.plan : cfg.leadThinking.review,
				state,
			};
		},
	});

	pi.registerTool({
		name: HANDOVER_TOOL,
		label: "Handover",
		description:
			"Relay mode, lead only: give the work to the worker model. Write a plan it can follow without you, the commands that must pass, and what you learned that must not be lost. The worker continues from here; you get a record back when it is done.",
		promptGuidelines: LEAD_RULES,
		defaultActive: false,
		parameters: Type.Object({
			plan: Type.String({ description: "The steps, in order, specific enough to follow without the lead." }),
			acceptance: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Shell commands that must exit 0 when the work is done (tests, a type check, a grep). Run in the session's directory after the worker hands back.",
				}),
			),
			criteria: Type.Optional(
				Type.String({ description: "What done means beyond the commands. You review the result against this." }),
			),
			findings: Type.Optional(
				Type.String({
					description: "What you learned and must not lose: the files involved, constraints, traps.",
				}),
			),
			stopWhen: Type.Optional(
				Type.String({ description: "When the worker must stop and hand back instead of pushing on." }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!isRelay(ctx.model))
				throw new Error(`${HANDOVER_TOOL} works only with the ${RELAY_PROVIDER}/${RELAY_MODEL} model`);
			const state = stateOf(ctx);
			if (state.phase === "worker") {
				throw new Error(`Only the lead hands over. You are the worker: do the work, then call ${HANDBACK_TOOL}.`);
			}
			if (!params.plan.trim()) throw new Error("plan is empty");
			const cfg = config();
			const handover: Handover = {
				round: state.round + 1,
				plan: params.plan,
				acceptance: (params.acceptance ?? []).filter((command) => command.trim() !== ""),
				criteria: params.criteria,
				findings: params.findings,
				stopWhen: params.stopWhen,
				base: await snapshot(ctx.cwd),
			};
			pi.appendEntry(HANDOVER_ENTRY, handover);
			return { content: [{ type: "text", text: workerBrief(handover, cfg) }], details: { round: handover.round } };
		},
	});

	pi.registerTool({
		name: HANDBACK_TOOL,
		label: "Handback",
		description:
			"Relay mode, worker only: give the work back to the lead, done or blocked, with a report. The acceptance commands of the handover are run after this call.",
		defaultActive: false,
		parameters: Type.Object({
			status: Type.Union([Type.Literal("done"), Type.Literal("blocked")]),
			report: Type.String({
				description: "What you changed, where you left the plan and why, what is unresolved.",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!isRelay(ctx.model))
				throw new Error(`${HANDBACK_TOOL} works only with the ${RELAY_PROVIDER}/${RELAY_MODEL} model`);
			if (stateOf(ctx).phase === "lead") {
				throw new Error(`Only the worker hands back. You are the lead: answer the user, or call ${HANDOVER_TOOL}.`);
			}
			const handback: Handback = { status: params.status, report: params.report };
			pi.appendEntry(HANDBACK_ENTRY, handback);
			// The run ends here; the hand back itself happens when it settles.
			return { content: [{ type: "text", text: "Handed back." }], details: {}, terminate: true };
		},
	});

	// The two tools are in the tool list only while the relay model is selected.
	const syncTools = (model: { provider: string; id: string } | undefined) => {
		const active = pi.getActiveTools();
		const relayTools = [HANDOVER_TOOL, HANDBACK_TOOL];
		const has = relayTools.every((name) => active.includes(name));
		if (isRelay(model) && !has)
			pi.setActiveTools([...active.filter((name) => !relayTools.includes(name)), ...relayTools]);
		else if (!isRelay(model) && active.some((name) => relayTools.includes(name))) {
			pi.setActiveTools(active.filter((name) => !relayTools.includes(name)));
		}
	};
	pi.on("session_start", async (_event, ctx) => syncTools(ctx.model));
	pi.on("model_select", async (event) => syncTools(event.model));

	// The end of a worker run: verify, then hand back.
	pi.on("agent_before_settle", async (event, ctx) => {
		if (!isRelay(ctx.model) || event.outcome !== "completed") return;
		if (stateOf(ctx).phase !== "worker") return;
		const phase = readPhase(ctx.sessionManager.getBranch());
		const handover = phase.handover;
		if (!handover) return;
		const cfg = config();
		const skipAcceptance = forced || phase.handback?.status === "blocked";
		forced = false;

		let results: AcceptanceResult[] = [];
		if (!skipAcceptance && handover.acceptance.length > 0) {
			notify(ctx, `relay: running ${handover.acceptance.length} acceptance command(s)`);
			results = await runAcceptance(handover.acceptance, ctx.cwd, cfg.acceptanceTimeoutMs, ctx.signal);
			if (ctx.signal?.aborted) return;
			if (!acceptancePassed(results) && phase.failedRounds < cfg.maxRounds) {
				const attempt = phase.failedRounds + 1;
				notify(ctx, `relay: acceptance failed (${attempt} of ${cfg.maxRounds}), back to the worker`, "warning");
				const drafts: SessionBoundaryDraft[] = [
					...event.entries,
					{ type: "custom", customType: VERIFY_ENTRY, data: { round: handover.round, attempt } },
					{
						type: "custom_message",
						customType: VERIFY_ENTRY,
						display: true,
						content: [
							`The acceptance commands were run after your hand back and did not all pass (attempt ${attempt} of ${cfg.maxRounds}). Fix the work, then call ${HANDBACK_TOOL} again. If the commands cannot pass with this plan, hand back with status "blocked" and say why.`,
							"",
							...results.map(describeAcceptance),
						].join("\n"),
					},
				];
				return { entries: drafts, continue: true };
			}
		}

		const lastText = [...event.context.contextMessages]
			.reverse()
			.map(assistantText)
			.find((text) => text.trim() !== "");
		const status = phase.handback?.status ?? (skipAcceptance ? "stopped" : "done");
		const record = buildRecord({
			handover,
			conversation: phase.conversation,
			earlierSummary: phase.earlierSummary,
			earlierRounds: phase.earlierRounds,
			status,
			report: phase.handback?.report ?? lastText ?? "",
			changes: await describeChanges(ctx.cwd, handover.base, cfg.diffChars),
			acceptance: results,
			failedRounds: phase.failedRounds,
		});
		const passed =
			results.length > 0 ? (acceptancePassed(results) ? ", acceptance passed" : ", acceptance failed") : "";
		const round: RoundSummary = {
			round: handover.round,
			line: `Round ${handover.round}: ${firstLine(handover.plan, 160)} (${status}${passed})`,
		};
		notify(ctx, `relay: round ${handover.round} handed back to the lead (${status}${passed})`);
		const drafts: SessionBoundaryDraft[] = [
			...event.entries,
			{ type: "custom", customType: ROUND_ENTRY, data: round },
			{
				type: "compaction",
				summary: record,
				firstKeptEntryId: null,
				details: { relay: true, round: handover.round },
			},
			{
				type: "custom_message",
				customType: "relay.review",
				display: true,
				content: `You are the lead again. The record above is what the worker did in round ${handover.round}. Check the changes against your criteria (read the files or run commands where the diff is not enough), then answer the user, fix a small thing yourself, or call ${HANDOVER_TOOL} again with a correction.`,
			},
		];
		return { entries: drafts, continue: true };
	});

	pi.registerCommand("handover", {
		description: "Relay: give the work to the worker model now, without a plan from the lead",
		handler: async (args, ctx) => {
			if (!isRelay(ctx.model))
				return notify(ctx, `/handover works with the ${RELAY_PROVIDER}/${RELAY_MODEL} model`, "warning");
			const state = stateOf(ctx);
			if (state.phase === "worker") return notify(ctx, "relay: the worker already has the work", "warning");
			if (!ctx.isIdle()) return notify(ctx, "relay: wait for the lead to finish, or stop it first", "warning");
			const instructions = args.trim();
			const handover: Handover = {
				round: state.round + 1,
				plan: instructions || "Carry on with the task discussed above.",
				acceptance: [],
				base: await snapshot(ctx.cwd),
				byUser: true,
			};
			pi.appendEntry(HANDOVER_ENTRY, handover);
			pi.sendMessage(
				{
					customType: HANDOVER_ENTRY,
					display: true,
					content: `${USER_HANDOVER_MARKER}\nThe user gives the work to the worker model directly (round ${handover.round}). You are the worker: ${handover.plan}\nWhen the work is done or you cannot go on, call ${HANDBACK_TOOL} with a report. Do not call ${HANDOVER_TOOL}.`,
				},
				{ triggerTurn: true },
			);
		},
	});

	pi.registerCommand("handback", {
		description: "Relay: wake the lead now; the worker reports where things stand",
		handler: async (_args, ctx) => {
			if (!isRelay(ctx.model))
				return notify(ctx, `/handback works with the ${RELAY_PROVIDER}/${RELAY_MODEL} model`, "warning");
			if (stateOf(ctx).phase !== "worker") return notify(ctx, "relay: the lead already has the work", "warning");
			forced = true;
			pi.sendMessage(
				{
					customType: HANDBACK_ENTRY,
					display: true,
					content: `The user asks for a hand back now. Stop working and call ${HANDBACK_TOOL} with status "blocked" and a report of where things stand.`,
				},
				{ triggerTurn: true, deliverAs: "steer" },
			);
		},
	});

	pi.registerCommand("relay", {
		description: "Relay: show who has the work, the round and the two models",
		handler: async (_args, ctx) => {
			try {
				const cfg = config();
				const state = stateOf(ctx);
				const selected = isRelay(ctx.model) ? "" : ` (not selected: /model ${RELAY_PROVIDER}/${RELAY_MODEL})`;
				notify(
					ctx,
					`relay${selected}: ${state.phase} has the work, round ${state.round}. lead ${cfg.lead}, worker ${cfg.worker}`,
				);
			} catch (error) {
				notify(ctx, `relay: ${(error as Error).message}`, "error");
			}
		},
	});
}
