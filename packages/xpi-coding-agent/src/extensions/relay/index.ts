// relay extension entry: the virtual model `relay/auto`. A strong model (the lead) explores, plans and reviews; a
// cheap model (the worker) builds. The lead gives the work away with the `handover` tool, called from a codemode
// script; when the worker's run ends, the acceptance commands are run here and the conversation is compacted to a
// hand-back record, which is all the lead reads of the worker's phase. Every phase change is a row of the table in
// `machine.ts`; this file reads the session into a view, asks the machine, and carries out the effects.
// See docs/relay.md.

import { Type } from "typebox";
import type { Api, Model } from "xpi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionToolContext,
	SessionBoundaryDraft,
} from "../../core/extensions/types.ts";
import { readRelayConfig, splitModelRef } from "./config.ts";
import { roundTimeFact, spendFact } from "./facts.ts";
import { type Effect, type MachineConfig, type RelayEvent, type RelayView, transition } from "./machine.ts";
import {
	correction,
	HANDBACK_FIELDS,
	HANDOVER_FIELDS,
	leadSection,
	RELAY_SECTION,
	reminder,
	workerSection,
} from "./prompts.ts";
import { type AcceptanceResult, acceptancePassed, buildRecord, describeAcceptance, type Handover } from "./record.ts";
import { HANDBACK_TOOL, HANDOVER_TOOL, nextState, type RelayState, USER_HANDOVER_MARKER } from "./router.ts";
import {
	assistantText,
	DIRECT_ENTRY,
	describeHistory,
	endedAfterRelayError,
	HANDBACK_ENTRY,
	HANDOVER_ENTRY,
	type Handback,
	handoverLanded,
	RELAY_MODEL,
	RELAY_PROVIDER,
	ROUND_ENTRY,
	type RoundSummary,
	readPhase,
	readView,
	storedState,
	TRANSITION_ENTRY,
	VERIFY_ENTRY,
	workerMadeNoCalls,
} from "./view.ts";
import { describeChanges, runAcceptance, snapshot } from "./workspace.ts";

export { HANDOVER_ENTRY, RELAY_MODEL, RELAY_PROVIDER, readPhase } from "./view.ts";

/** The hand tools' names, for the active tool set in the direct fallback. */
const RELAY_TOOLS = [HANDOVER_TOOL, HANDBACK_TOOL];
/** The steer `/handback` sends: not a state entry, only a message for the worker. */
const REQUEST_ENTRY = "relay.request";
const CODEMODE_TOOL = "codemode";

function isRelay(model: { provider: string; id: string } | undefined): boolean {
	return model?.provider === RELAY_PROVIDER && model.id === RELAY_MODEL;
}

function firstLine(text: string, max: number): string {
	const line = text.trim().split("\n")[0] ?? "";
	return line.length <= max ? line : `${line.slice(0, max)}...`;
}

type Level = "info" | "warning" | "error";

export default function relay(pi: ExtensionAPI) {
	// Subagent children are workers already: they never get the relay model or its tools.
	if (process.env.XPI_SUBAGENT_DEPTH) return;

	const config = () => readRelayConfig((pi.getSettings() as { relay?: unknown }).relay);
	const machineConfig = (): MachineConfig => ({ maxRounds: config().maxRounds });
	/** A line for the user: a notification in the TUI, stderr with --verbose in print mode. Never a message. */
	const show = (ctx: ExtensionContext, message: string, level: Level = "info") => {
		if (ctx.hasUI) ctx.ui.notify(message, level);
		else if (process.argv.includes("--verbose")) process.stderr.write(`${message}\n`);
	};
	// /handback: the next end of a worker run hands back without running the acceptance commands.
	let userAsked = false;
	const viewOf = (ctx: ExtensionContext): RelayView => readView(ctx.sessionManager.getBranch(), userAsked);

	const physical = (ctx: ExtensionContext, ref: string, key: string): Model<Api> => {
		const { provider, id } = splitModelRef(ref);
		const model = ctx.modelRegistry.find(provider, id);
		if (!model) throw new Error(`relay.${key}: model ${ref} is not in the catalog`);
		return model;
	};

	/** A phase change that took effect: one entry on the branch and one line for the user. */
	const recordTransition = (ctx: ExtensionContext, from: string, to: string, event: string, round: number) => {
		pi.appendEntry(TRANSITION_ENTRY, { from, to, event, round, at: Date.now() });
		show(ctx, `relay: ${from} → ${to} (round ${round})`);
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
			const before = request.state ?? { phase: "lead", round: 0 };
			const state = nextState(request.state, request.messages);
			if (state.phase === "worker") {
				// The model first: a router that fails writes nothing, so a retry cannot write a second transition.
				const model = physical(ctx, cfg.worker, "worker");
				// Only a handover takes effect here; the hand back is written where the record is made.
				if (before.phase === "lead") recordTransition(ctx, "lead", "worker", "handover", state.round);
				return { model, thinkingLevel: cfg.workerThinking, state };
			}
			return {
				model: physical(ctx, cfg.lead, "lead"),
				thinkingLevel: state.round === 0 ? cfg.leadThinking.plan : cfg.leadThinking.review,
				state,
			};
		},
	});

	// ---- The hand tools ------------------------------------------------------------------------------------------

	/** Whether the hand tools are direct tools: codemode is not active, so the model has no other way to reach them. */
	const codemodeOff = () => !pi.getActiveTools().includes(CODEMODE_TOOL);
	/** How the tools are registered now. Exposure is fixed at registration, so a change re-registers them. */
	let registeredDirect = false;

	/** What a tool call does, from its effects: the entries it writes, then the result. */
	async function carryOut(
		effects: readonly Effect[],
		ctx: ExtensionToolContext,
		view: RelayView,
		own: { handover?: Handover; handback?: Handback },
	) {
		let result: Extract<Effect, { type: "result" }> | undefined;
		for (const effect of effects) {
			if (effect.type === "append_entry") {
				const at = Date.now();
				if (effect.entry === "relay.handover" && own.handover) pi.appendEntry(HANDOVER_ENTRY, own.handover);
				else if (effect.entry === "relay.handback")
					pi.appendEntry(
						HANDBACK_ENTRY,
						effect.data ?? (own.handback as Record<string, unknown> | undefined) ?? {},
					);
				else pi.appendEntry(effect.entry, { ...effect.data, round: view.round, phase: view.phase, at });
			} else if (effect.type === "notify") show(ctx, effect.text, effect.level ?? "info");
			else if (effect.type === "result") result = effect;
		}
		return result;
	}

	const toolResult = (result: Extract<Effect, { type: "result" }> | undefined, hint: string) => {
		if (!result) throw new Error("Nothing to do.");
		if (result.isError) throw new Error(hint || result.text);
		return {
			content: [{ type: "text" as const, text: result.text }],
			details: {},
			...(result.terminate ? { terminate: true } : {}),
		};
	};

	const registerHandover = (direct: boolean) =>
		pi.registerTool({
			name: HANDOVER_TOOL,
			label: "Handover",
			effect: "write",
			description:
				"Relay mode: give the work to the worker model. It continues from this conversation; when it is done you get a record back in place of the conversation (your note, the user's messages, your replies, its report, the diff, the acceptance output).",
			exposure: direct ? "direct" : "deferred",
			listed: false,
			defaultActive: false,
			parameters: Type.Object({
				plan: Type.String({ description: HANDOVER_FIELDS.plan }),
				acceptance: Type.Optional(Type.Array(Type.String(), { description: HANDOVER_FIELDS.acceptance })),
				criteria: Type.Optional(Type.String({ description: HANDOVER_FIELDS.criteria })),
				findings: Type.Optional(Type.String({ description: HANDOVER_FIELDS.findings })),
				stopWhen: Type.Optional(Type.String({ description: HANDOVER_FIELDS.stopWhen })),
			}),
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				if (!isRelay(ctx.model))
					throw new Error(`${HANDOVER_TOOL} works only with the ${RELAY_PROVIDER}/${RELAY_MODEL} model`);
				// The snapshot takes time: it is made before the view is read, so that reading the view, deciding and
				// writing the entry happen without a pause another call could slip into (two parallel handovers).
				let base: string | undefined;
				const early = viewOf(ctx);
				if (!early.pending && early.phase === "lead" && params.plan.trim()) base = await snapshot(ctx.cwd);
				// A call cut off while the snapshot was made (its script ended, or Esc) must write nothing: its result
				// never reached the model, so the handover did not happen.
				if (signal?.aborted) throw new Error("Operation aborted");
				const view = viewOf(ctx);
				const event: RelayEvent =
					!view.pending && view.phase === "worker"
						? { type: "wrong_role", tool: "handover" }
						: { type: "handover", byUser: false };
				if (event.type === "handover" && !view.pending && !params.plan.trim()) throw new Error("plan is empty");
				const { effects } = transition(view, event, machineConfig());
				const own: { handover?: Handover } = {};
				if (effects.some((effect) => effect.type === "append_entry" && effect.entry === "relay.handover")) {
					own.handover = {
						round: view.round + 1,
						plan: params.plan,
						acceptance: (params.acceptance ?? []).filter((command) => command.trim() !== ""),
						criteria: params.criteria,
						findings: params.findings,
						stopWhen: params.stopWhen,
						base,
					};
				}
				const result = await carryOut(effects, ctx, view, own);
				return toolResult(result, event.type === "wrong_role" ? correction("handover", registeredDirect) : "");
			},
		});

	const registerHandback = (direct: boolean) =>
		pi.registerTool({
			name: HANDBACK_TOOL,
			label: "Handback",
			effect: "write",
			description:
				"Relay mode: give the work back to the lead, done or blocked, with a report. The acceptance commands of the handover are run after this call.",
			exposure: direct ? "direct" : "deferred",
			listed: false,
			defaultActive: false,
			parameters: Type.Object({
				status: Type.Union([Type.Literal("done"), Type.Literal("blocked")], {
					description: HANDBACK_FIELDS.status,
				}),
				report: Type.String({ description: HANDBACK_FIELDS.report }),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				if (!isRelay(ctx.model))
					throw new Error(`${HANDBACK_TOOL} works only with the ${RELAY_PROVIDER}/${RELAY_MODEL} model`);
				const view = viewOf(ctx);
				const event: RelayEvent =
					!view.pending && view.phase === "lead"
						? { type: "wrong_role", tool: "handback" }
						: { type: "handback", status: params.status, byUser: false };
				const { effects } = transition(view, event, machineConfig());
				const result = await carryOut(effects, ctx, view, {
					handback: { status: params.status, report: params.report },
				});
				return toolResult(result, event.type === "wrong_role" ? correction("handback", registeredDirect) : "");
			},
		});

	const registerTools = (direct: boolean) => {
		registeredDirect = direct;
		registerHandover(direct);
		registerHandback(direct);
	};
	registerTools(false);

	// The two tools are in the active set only in the direct fallback, and only while the relay model is selected.
	const syncTools = (model: { provider: string; id: string } | undefined) => {
		const active = pi.getActiveTools();
		const want = registeredDirect && isRelay(model);
		const has = RELAY_TOOLS.every((name) => active.includes(name));
		if (want && !has) pi.setActiveTools([...active.filter((name) => !RELAY_TOOLS.includes(name)), ...RELAY_TOOLS]);
		else if (!want && active.some((name) => RELAY_TOOLS.includes(name))) {
			pi.setActiveTools(active.filter((name) => !RELAY_TOOLS.includes(name)));
		}
	};
	/** Register the tools the way codemode's state asks for, and only when that state changed since the last time. */
	const syncRegistration = (model: { provider: string; id: string } | undefined) => {
		const direct = codemodeOff();
		if (direct !== registeredDirect) registerTools(direct);
		syncTools(model);
	};

	// A hand tool called directly while codemode is on is run through codemode by the agent loop (seam C): say so.
	pi.on("tool_call", async (event, ctx) => {
		if (registeredDirect || event.parentToolCallId !== undefined) return;
		if (event.toolName !== HANDOVER_TOOL && event.toolName !== HANDBACK_TOOL) return;
		const role = storedState(ctx.sessionManager.getBranch()).phase;
		pi.appendEntry(DIRECT_ENTRY, { tool: event.toolName, role, at: Date.now() });
		show(ctx, `relay: direct ${event.toolName}(...) run as a codemode call`, "warning");
		return undefined;
	});

	// ---- The role section of the system prompt -------------------------------------------------------------------

	pi.on("context_with_system", async (event, ctx) => {
		const head = event.messages[0];
		if (!head || head.role !== "system") return undefined;
		const sections = { ...head.sections };
		let text: string | undefined;
		if (isRelay(ctx.model)) {
			try {
				const cfg = config();
				const branch = ctx.sessionManager.getBranch();
				const find = (ref: string) => {
					const { provider, id } = splitModelRef(ref);
					return ctx.modelRegistry.find(provider, id);
				};
				text =
					storedState(branch).phase === "worker"
						? workerSection(readPhase(branch).handover, cfg, registeredDirect)
						: leadSection(cfg, find(cfg.lead), find(cfg.worker), registeredDirect);
			} catch {
				// Wrong settings end the request with an error that names the key, from the router.
				return undefined;
			}
		}
		if (text === undefined) {
			if (!(RELAY_SECTION in sections)) return undefined;
			delete sections[RELAY_SECTION];
		} else {
			if (sections[RELAY_SECTION] === text) return undefined;
			sections[RELAY_SECTION] = text;
		}
		return { messages: [{ ...head, sections }, ...event.messages.slice(1)] };
	});

	// ---- Session and model events --------------------------------------------------------------------------------

	/** Pause or resume the worker's phase when the selection leaves or returns to the relay model. */
	const followSelection = (ctx: ExtensionContext, model: { provider: string; id: string } | undefined) => {
		const view = viewOf(ctx);
		const { effects } = transition(
			view,
			isRelay(model) ? { type: "model_back" } : { type: "model_away" },
			machineConfig(),
		);
		for (const effect of effects) {
			if (effect.type === "append_entry")
				pi.appendEntry(effect.entry, { ...effect.data, phase: view.phase, at: Date.now() });
			else if (effect.type === "notify") show(ctx, effect.text, effect.level ?? "info");
		}
	};
	pi.on("session_start", async (_event, ctx) => {
		syncRegistration(ctx.model);
		if (isRelay(ctx.model)) followSelection(ctx, ctx.model);
	});
	pi.on("model_select", async (event, ctx) => {
		syncRegistration(event.model);
		followSelection(ctx, event.model);
	});
	pi.on("before_agent_start", async (_event, ctx) => {
		syncRegistration(ctx.model);
		return undefined;
	});

	// ---- The end of a run ----------------------------------------------------------------------------------------

	pi.on("agent_before_settle", async (event, ctx) => {
		if (!isRelay(ctx.model) || event.outcome !== "completed") return;
		const branch = ctx.sessionManager.getBranch();
		const view = viewOf(ctx);
		const cfg = config();
		const machine = machineConfig();
		const phase = readPhase(branch);
		const drafts: SessionBoundaryDraft[] = [...event.entries];
		let goOn = false;
		let touched = false;
		/** A hand back the machine made for the worker (blocked): the branch does not hold it yet. */
		let handback: Handback | undefined = phase.handback;
		let results: AcceptanceResult[] = [];
		let acceptanceMs = phase.acceptanceMs;
		let attemptMs = 0;

		const pending: Effect[] = [
			...transition(
				view,
				{
					type: "run_end",
					afterRelayError: endedAfterRelayError(branch),
					handoverLanded: view.pending !== "handover" || handoverLanded(branch, view.round + 1),
					workerIdle: view.phase === "worker" && !view.pending && workerMadeNoCalls(branch),
				},
				machine,
			).effects,
		];
		while (pending.length > 0) {
			const effect = pending.shift() as Effect;
			touched = true;
			switch (effect.type) {
				case "append_entry": {
					const at = Date.now();
					if (effect.entry === "relay.handback") {
						handback = effect.data as unknown as Handback;
						drafts.push({ type: "custom", customType: HANDBACK_ENTRY, data: effect.data });
					} else if (effect.entry === "relay.verify") {
						drafts.push({
							type: "custom",
							customType: VERIFY_ENTRY,
							data: { round: view.round, attempt: phase.failedRounds + 1, ms: attemptMs },
						});
					} else if (effect.entry === "relay.transition") {
						drafts.push({ type: "custom", customType: TRANSITION_ENTRY, data: { ...effect.data, at } });
						show(ctx, `relay: worker → lead (round ${view.round})`);
					} else {
						drafts.push({
							type: "custom",
							customType: effect.entry,
							data: { ...effect.data, round: view.round, phase: view.phase, at },
						});
					}
					break;
				}
				case "notify":
					show(ctx, effect.text, effect.level ?? "info");
					break;
				case "run_acceptance": {
					const handover = phase.handover;
					const commands = handover?.acceptance ?? [];
					if (commands.length > 0) {
						show(ctx, `relay: running ${commands.length} acceptance command(s)`);
						const started = Date.now();
						results = await runAcceptance(commands, ctx.cwd, cfg.acceptanceTimeoutMs, ctx.signal);
						attemptMs = Date.now() - started;
						acceptanceMs += attemptMs;
						if (ctx.signal?.aborted) return;
					}
					pending.unshift(
						...transition(
							view,
							{ type: "acceptance", passed: acceptancePassed(results), attempt: phase.failedRounds },
							machine,
						).effects,
					);
					break;
				}
				case "continue_with": {
					goOn = true;
					if (effect.kind === "role_reminder") {
						drafts.push({
							type: "custom_message",
							customType: "relay.stall",
							display: true,
							content: reminder(view.phase, registeredDirect, effect.reason),
						});
					} else if (effect.kind === "acceptance_failure") {
						const attempt = phase.failedRounds + 1;
						drafts.push({
							type: "custom_message",
							customType: VERIFY_ENTRY,
							display: true,
							content: [
								`The acceptance commands were run after your hand back and did not all pass (attempt ${attempt} of ${cfg.maxRounds}). Fix the work, then hand back again. If the commands cannot pass with this plan, hand back with status "blocked" and say why.`,
								"",
								...results.map(describeAcceptance),
							].join("\n"),
						});
					}
					break;
				}
				case "compact_record": {
					const handover = phase.handover;
					if (!handover) break;
					const lastText = [...event.context.contextMessages]
						.reverse()
						.map(assistantText)
						.find((text) => text.trim() !== "");
					const status = handback?.status ?? (view.userAsked || view.blocked ? "stopped" : "done");
					const record = buildRecord({
						handover,
						conversation: phase.conversation,
						earlierSummary: phase.earlierSummary,
						earlierRounds: phase.earlierRounds,
						status,
						report: handback?.report ?? lastText ?? "",
						changes: await describeChanges(ctx.cwd, handover.base, cfg.diffChars),
						acceptance: results,
						failedRounds: phase.failedRounds,
						repairs: phase.repairs,
					});
					const passed =
						results.length > 0 ? (acceptancePassed(results) ? ", acceptance passed" : ", acceptance failed") : "";
					const round: RoundSummary = {
						round: handover.round,
						line: `Round ${handover.round}: ${firstLine(handover.plan, 160)} (${status}${passed})`,
					};
					show(ctx, `relay: round ${handover.round} handed back to the lead (${status}${passed})`);
					drafts.push(
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
							content: [
								`You are the lead again. The record above is what the worker did in round ${handover.round}.`,
								roundTimeFact(handover.round, phase.startedAt, acceptanceMs),
								spendFact(branch, cfg),
								`Nothing is final: you can read files, run commands, change things yourself, answer the user, or call ${HANDOVER_TOOL} again.`,
							]
								.filter(Boolean)
								.join(" "),
						},
					);
					userAsked = false;
					goOn = true;
					break;
				}
				case "result":
				case "steer":
					break;
			}
		}
		if (!touched) return;
		return { entries: drafts, continue: goOn };
	});

	// ---- Commands ------------------------------------------------------------------------------------------------

	pi.registerCommand("handover", {
		description: "Relay: give the work to the worker model now, without a plan from the lead",
		handler: async (args, ctx) => {
			if (!isRelay(ctx.model))
				return show(ctx, `/handover works with the ${RELAY_PROVIDER}/${RELAY_MODEL} model`, "warning");
			if (!ctx.isIdle()) return show(ctx, "relay: wait for the lead to finish, or stop it first", "warning");
			const view = viewOf(ctx);
			const { effects } = transition(view, { type: "handover", byUser: true }, machineConfig());
			const refusal = effects.find((effect) => effect.type === "result");
			if (refusal) return show(ctx, `relay: ${refusal.text}`, "warning");
			const instructions = args.trim();
			const handover: Handover = {
				round: view.round + 1,
				plan: instructions || "Carry on with the task discussed above.",
				acceptance: [],
				base: await snapshot(ctx.cwd),
				byUser: true,
			};
			pi.appendEntry(HANDOVER_ENTRY, handover);
			userAsked = false;
			pi.sendMessage(
				{
					customType: HANDOVER_ENTRY,
					display: true,
					content: `${USER_HANDOVER_MARKER}\nThe user gives the work to the worker model directly (round ${handover.round}): ${handover.plan}`,
				},
				{ triggerTurn: true },
			);
		},
	});

	pi.registerCommand("handback", {
		description: "Relay: wake the lead now; the worker reports where things stand",
		handler: async (_args, ctx) => {
			if (!isRelay(ctx.model))
				return show(ctx, `/handback works with the ${RELAY_PROVIDER}/${RELAY_MODEL} model`, "warning");
			const { effects } = transition(
				viewOf(ctx),
				{ type: "handback", status: "blocked", byUser: true },
				machineConfig(),
			);
			const refusal = effects.find((effect) => effect.type === "result");
			if (refusal) return show(ctx, `relay: ${refusal.text}`, "warning");
			userAsked = true;
			pi.sendMessage(
				{
					customType: REQUEST_ENTRY,
					display: true,
					content: `The user asks for a hand back now. Stop working and hand back with status "blocked" and a report of where things stand.`,
				},
				{ triggerTurn: true, deliverAs: "steer" },
			);
		},
	});

	pi.registerCommand("relay", {
		description: "Relay: show who has the work, the round, the two models, this round's history and the spend",
		handler: async (_args, ctx) => {
			try {
				const cfg = config();
				const branch = ctx.sessionManager.getBranch();
				const view = viewOf(ctx);
				const selected = isRelay(ctx.model) ? "" : ` (not selected: /model ${RELAY_PROVIDER}/${RELAY_MODEL})`;
				const lines = [
					`relay${selected}: ${view.paused ? "paused, the worker has the work" : `${view.phase} has the work`}, round ${view.round}. lead ${cfg.lead}, worker ${cfg.worker}`,
				];
				if (registeredDirect) lines.push("codemode is off: the hand tools are direct tools");
				const history = describeHistory(branch);
				if (history.length > 0) lines.push("this round:", ...history.map((line) => `  ${line}`));
				const spend = spendFact(branch, cfg);
				if (spend) lines.push(spend);
				show(ctx, lines.join("\n"));
			} catch (error) {
				show(ctx, `relay: ${(error as Error).message}`, "error");
			}
		},
	});
}
