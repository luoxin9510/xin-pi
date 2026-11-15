// The relay's orchestration: which event, which effects, in which order. The host (`RelayHost`) holds what lives as long
// as the extension; each handler call brings a `RelayCall`. A phase change is a row of the graph in `definition.ts`;
// this file reads the entries into a view, asks the graph, and carries out the effects. See docs/relay.md.

import { Type } from "typebox";
import type { Api, Model } from "xpi-ai";
import { readRelayConfig } from "./config.ts";
import {
	type Effect,
	initialView,
	type MachineConfig,
	type RelayEvent,
	type RelayView,
	transition,
} from "./definition.ts";
import { type ContextLimits, leadRefreshes, roundContextFact, roundTimeFact, spendFact } from "./facts.ts";
import type {
	HandbackParams,
	HandoverParams,
	RelayCall,
	RelayDraft,
	RelayHost,
	RelayRequestStart,
	RelayRoute,
	RelayRouteRequest,
	RelaySection,
	SettleEvent,
	SettleResult,
	ToolOutcome,
	ToolSpec,
} from "./host.ts";
import { contextLimitOf } from "./limit.ts";
import { correction, HANDBACK_FIELDS, HANDOVER_FIELDS, leadSection, reminder, workerSection } from "./prompts.ts";
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
	limitSummaries,
	RELAY_MODEL,
	RELAY_PROVIDER,
	ROUND_ENTRY,
	type RoundSummary,
	readPhase,
	readView,
	roundContext,
	storedState,
	TRANSITION_ENTRY,
	userSpokeSinceLimit,
	VERIFY_ENTRY,
	workerMadeNoCalls,
} from "./view.ts";
import { describeChanges, runAcceptance, snapshot } from "./workspace.ts";

/** The hand tools' names, for the active tool set in the direct fallback. */
const RELAY_TOOLS = [HANDOVER_TOOL, HANDBACK_TOOL];
/** The steer `/handback` sends: not a state entry, only a message for the worker. */
const REQUEST_ENTRY = "relay.request";
const CODEMODE_TOOL = "codemode";

/** Whether `model` is the relay model. */
export function isRelay(model: { provider: string; id: string } | undefined): boolean {
	return model?.provider === RELAY_PROVIDER && model.id === RELAY_MODEL;
}

function firstLine(text: string, max: number): string {
	const line = text.trim().split("\n")[0] ?? "";
	return line.length <= max ? line : `${line.slice(0, max)}...`;
}

/** Other shapes are ignored on purpose: a state this relay did not write is no transition. */
function asState(value: unknown): RelayState | undefined {
	const state = value as RelayState | undefined;
	return state && (state.phase === "lead" || state.phase === "worker") ? state : undefined;
}

export interface Relay {
	/** The physical model, the thinking level and the next stored state for one request. No side effects. */
	route(request: RelayRouteRequest, call: RelayCall): RelayRoute;
	/** The `relay` section of the system prompt. Undefined: leave the prompt alone. */
	section(call: RelayCall): RelaySection | undefined;
	handover(params: HandoverParams, signal: AbortSignal | undefined, call: RelayCall): Promise<ToolOutcome>;
	handback(params: HandbackParams, call: RelayCall): Promise<ToolOutcome>;
	/**
	 * A tool call that came from the model. Hand tools called directly while codemode is on are run through codemode by
	 * the host; this records that. Calls of other tools, nested calls and the direct fallback are ignored.
	 */
	onDirectCall(tool: { name: string; parentToolCallId?: string }, call: RelayCall): void;
	/** Tool sync at the start of a session, then pause or resume. */
	onSessionStart(call: RelayCall): void;
	/** Tool sync before a run, for when codemode was switched. */
	onBeforeAgentStart(call: RelayCall): void;
	/** Tool sync, then pause or resume the worker's phase. */
	onModelSelect(model: { provider: string; id: string } | undefined, call: RelayCall): void;
	/**
	 * The commit point of a request: the routed state is stored and the physical model resolved. A handover takes
	 * effect here, as one `relay.transition` entry and one notice. A retry meets the same stored state on both sides
	 * and writes nothing.
	 */
	onRequestStart(event: RelayRequestStart, call: RelayCall): void;
	/** The end of a run: acceptance commands, the hand-back record, continuations. Undefined: nothing to do. */
	beforeSettle(event: SettleEvent, call: RelayCall): Promise<SettleResult | undefined>;
	commands: {
		handover(args: string, call: RelayCall): Promise<void>;
		handback(call: RelayCall): void;
		status(call: RelayCall): { text: string; level: "info" | "error" };
	};
}

export function createRelay(host: RelayHost): Relay {
	const config = () => readRelayConfig(host.settings());
	const machineConfig = (): MachineConfig => {
		const cfg = config();
		return { maxRounds: cfg.maxRounds, whenStuck: cfg.workerContext.whenStuck };
	};
	// /handback: the next end of a worker run hands back without running the acceptance commands.
	let userAsked = false;
	const viewOf = (call: RelayCall): RelayView => readView(call.entries, userAsked);

	const physical = (call: RelayCall, ref: string, key: string): Model<Api> => {
		const model = call.findModel(ref);
		if (!model) throw new Error(`relay.${key}: model ${ref} is not in the catalog`);
		return model;
	};

	/** The limits in prompt tokens of both roles under the settings now; throws for a limit a compaction cannot get under. */
	const limitsOf = (call: RelayCall): ContextLimits => {
		const cfg = config();
		const keep = () => host.keepRecentTokens();
		return {
			worker:
				cfg.workerContext.limit === "off"
					? undefined
					: contextLimitOf(cfg.workerContext, "workerContext", call.findModel(cfg.worker), keep()),
			lead:
				cfg.leadContext.limit === "off"
					? undefined
					: contextLimitOf(cfg.leadContext, "leadContext", call.findModel(cfg.lead), keep()),
		};
	};

	/** The worker's configured limit, for the facts after a hand back; unknown (undefined) when the settings are wrong. */
	const workerLimit = (call: RelayCall): number | undefined => {
		try {
			return limitsOf(call).worker;
		} catch {
			return undefined;
		}
	};

	/** A phase change that took effect: one entry on the branch and one line for the user. */
	const recordTransition = (call: RelayCall, from: string, to: string, event: string, round: number) => {
		host.appendEntry(TRANSITION_ENTRY, { from, to, event, round, at: Date.now() });
		call.notify(`relay: ${from} → ${to} (round ${round})`);
	};

	// ---- The hand tools ------------------------------------------------------------------------------------------

	/** Whether the hand tools are direct tools: codemode is not active, so the model has no other way to reach them. */
	const codemodeOff = () => !host.activeTools().includes(CODEMODE_TOOL);
	/** How the tools are registered now. Exposure is fixed at registration, so a change re-registers them. */
	let registeredDirect = false;

	/** What a tool call does, from its effects: the entries it writes, then the result. */
	function carryOut(
		effects: readonly Effect[],
		call: RelayCall,
		view: RelayView,
		own: { handover?: Handover; handback?: Handback },
	) {
		let result: Extract<Effect, { type: "result" }> | undefined;
		for (const effect of effects) {
			if (effect.type === "append_entry") {
				const at = Date.now();
				if (effect.entry === "relay.handover" && own.handover) host.appendEntry(HANDOVER_ENTRY, own.handover);
				else if (effect.entry === "relay.handback")
					host.appendEntry(
						HANDBACK_ENTRY,
						effect.data ?? (own.handback as Record<string, unknown> | undefined) ?? {},
					);
				else host.appendEntry(effect.entry, { ...effect.data, round: view.round, phase: view.phase, at });
			} else if (effect.type === "notify") call.notify(effect.text, effect.level ?? "info");
			else if (effect.type === "result") result = effect;
		}
		return result;
	}

	const toolResult = (result: Extract<Effect, { type: "result" }> | undefined, hint: string): ToolOutcome => {
		if (!result) throw new Error("Nothing to do.");
		if (result.isError) throw new Error(hint || result.text);
		return {
			text: result.text,
			...(result.terminate ? { terminate: true } : {}),
			...(result.signal ? { signal: result.signal } : {}),
		};
	};

	async function handover(
		params: HandoverParams,
		signal: AbortSignal | undefined,
		call: RelayCall,
	): Promise<ToolOutcome> {
		if (!isRelay(call.model))
			throw new Error(`${HANDOVER_TOOL} works only with the ${RELAY_PROVIDER}/${RELAY_MODEL} model`);
		// The snapshot takes time: it is made before the view is read, so that reading the view, deciding and
		// writing the entry happen without a pause another call could slip into (two parallel handovers).
		let base: string | undefined;
		const early = viewOf(call);
		if (!early.pending && early.phase === "lead" && params.plan.trim()) base = await snapshot(call.cwd);
		// A call cut off while the snapshot was made (its script ended, or Esc) must write nothing: its result
		// never reached the model, so the handover did not happen.
		if (signal?.aborted) throw new Error("Operation aborted");
		const view = viewOf(call);
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
		const result = carryOut(effects, call, view, own);
		return toolResult(result, event.type === "wrong_role" ? correction("handover", registeredDirect) : "");
	}

	async function handback(params: HandbackParams, call: RelayCall): Promise<ToolOutcome> {
		if (!isRelay(call.model))
			throw new Error(`${HANDBACK_TOOL} works only with the ${RELAY_PROVIDER}/${RELAY_MODEL} model`);
		const view = viewOf(call);
		const event: RelayEvent =
			!view.pending && view.phase === "lead"
				? { type: "wrong_role", tool: "handback" }
				: { type: "handback", status: params.status, byUser: false };
		const { effects } = transition(view, event, machineConfig());
		const result = carryOut(effects, call, view, {
			handback: { status: params.status, report: params.report },
		});
		return toolResult(result, event.type === "wrong_role" ? correction("handback", registeredDirect) : "");
	}

	const toolSpecs = (direct: boolean): ToolSpec[] => [
		{
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
			execute: (params, signal, call) => handover(params as HandoverParams, signal, call),
		},
		{
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
			execute: (params, _signal, call) => handback(params as HandbackParams, call),
		},
	];

	const registerTools = (direct: boolean) => {
		registeredDirect = direct;
		host.registerTools(toolSpecs(direct));
	};
	registerTools(false);

	// The two tools are in the active set only in the direct fallback, and only while the relay model is selected.
	const syncTools = (model: { provider: string; id: string } | undefined) => {
		const active = host.activeTools();
		const want = registeredDirect && isRelay(model);
		const has = RELAY_TOOLS.every((name) => active.includes(name));
		if (want && !has) host.setActiveTools([...active.filter((name) => !RELAY_TOOLS.includes(name)), ...RELAY_TOOLS]);
		else if (!want && active.some((name) => RELAY_TOOLS.includes(name))) {
			host.setActiveTools(active.filter((name) => !RELAY_TOOLS.includes(name)));
		}
	};
	/** Register the tools the way codemode's state asks for, and only when that state changed since the last time. */
	const syncRegistration = (model: { provider: string; id: string } | undefined) => {
		const direct = codemodeOff();
		if (direct !== registeredDirect) registerTools(direct);
		syncTools(model);
	};

	/** Pause or resume the worker's phase when the selection leaves or returns to the relay model. */
	const followSelection = (call: RelayCall, model: { provider: string; id: string } | undefined) => {
		const view = viewOf(call);
		const { effects } = transition(
			view,
			isRelay(model) ? { type: "model_back" } : { type: "model_away" },
			machineConfig(),
		);
		for (const effect of effects) {
			if (effect.type === "append_entry")
				host.appendEntry(effect.entry, { ...effect.data, phase: view.phase, at: Date.now() });
			else if (effect.type === "notify") call.notify(effect.text, effect.level ?? "info");
		}
	};

	return {
		route(request, call) {
			const cfg = config();
			// Requests outside the agent loop (the summary of an ordinary compaction) are not the lead's work.
			if (request.reason === "direct") {
				return { model: physical(call, cfg.worker, "worker"), thinkingLevel: cfg.workerThinking };
			}
			let state = nextState(request.state, request.messages);
			const worker = state.phase === "worker";
			// The lead's lifted limit lasts until the user speaks again: the guard is for one stretch of work, and a long
			// conversation must not lose the limit for good.
			if (!worker && state.limit === "lifted" && userSpokeSinceLimit(call.entries)) {
				state = { phase: state.phase, round: state.round };
			}
			const model = physical(call, worker ? cfg.worker : cfg.lead, worker ? "worker" : "lead");
			const context = worker ? cfg.workerContext : cfg.leadContext;
			let contextLimit =
				context.limit === "off"
					? undefined
					: contextLimitOf(context, worker ? "workerContext" : "leadContext", model, host.keepRecentTokens());
			// A worker limit a compaction cannot get under is reported before the handover, not after it: the lead's section
			// states that limit, and a wrong one must end the request here instead of silently dropping the section.
			if (!worker && cfg.workerContext.limit !== "off") {
				contextLimitOf(cfg.workerContext, "workerContext", call.findModel(cfg.worker), host.keepRecentTokens());
			}
			let next = state;
			// The stuck guard: a phase that has written `maxCompactions` summaries under its limit is stuck. The decision is
			// the state returned here; `onRequestStart` acts on the change.
			if (contextLimit !== undefined && context.maxCompactions > 0) {
				if (state.limit === "lifted") contextLimit = undefined;
				else {
					const summaries = limitSummaries(call.entries, state.phase);
					if (summaries >= context.maxCompactions) {
						const asks = worker && cfg.workerContext.whenStuck === "handback";
						if (asks && summaries < context.maxCompactions + 2) {
							if (state.limit !== "asked") next = { ...state, limit: "asked" };
						} else {
							next = { ...state, limit: "lifted" };
							contextLimit = undefined;
						}
					}
				}
			} else if (state.limit === "lifted") contextLimit = undefined;
			const limited = contextLimit === undefined ? {} : { contextLimit };
			if (worker) {
				const cache = cfg.warmLead ? { key: "worker", holdPrefix: "lead" } : { key: "worker" };
				return { model, thinkingLevel: cfg.workerThinking, state: next, ...limited, cache };
			}
			return {
				cache: { key: "lead" },
				model,
				thinkingLevel: state.round === 0 ? cfg.leadThinking.plan : cfg.leadThinking.review,
				state: next,
				...limited,
			};
		},

		onRequestStart(event, call) {
			if (!isRelay(call.model)) return;
			const before = asState(event.previousRouterState) ?? { phase: "lead", round: 0 };
			const state = asState(event.routerState);
			// Only a handover takes effect here; the hand back is written where the record is made.
			if (state && before.phase === "lead" && state.phase === "worker") {
				recordTransition(call, "lead", "worker", "handover", state.round);
			}
			// The stuck guard changed the state of this phase: the entry, the notice and the steer are this row's effects.
			if (
				state?.limit &&
				state.limit !== before.limit &&
				state.phase === before.phase &&
				state.round === before.round
			) {
				const view = initialView({ phase: state.phase, round: state.round });
				const compactions = limitSummaries(call.entries, state.phase);
				const { effects } = transition(
					view,
					{ type: "limit_reached", compactions, to: state.limit },
					machineConfig(),
				);
				for (const effect of effects) {
					if (effect.type === "append_entry")
						host.appendEntry(effect.entry, {
							...effect.data,
							round: view.round,
							phase: view.phase,
							at: Date.now(),
						});
					else if (effect.type === "notify") call.notify(effect.text, effect.level ?? "info");
					else if (effect.type === "steer" && effect.kind === "limit" && !userAsked) {
						host.sendMessage(
							{
								customType: REQUEST_ENTRY,
								display: true,
								content: `The context limit keeps compacting your work (${compactions} summaries in this round). Stop working and hand back with status "blocked": say what is done and what is left, so the lead can split the rest.`,
							},
							{ triggerTurn: true, deliverAs: "steer" },
						);
					}
				}
			}
		},

		section(call) {
			if (!isRelay(call.model)) return { text: undefined };
			try {
				const cfg = config();
				const branch = call.entries;
				return {
					text:
						storedState(branch).phase === "worker"
							? workerSection(readPhase(branch).handover, cfg, registeredDirect)
							: leadSection(
									cfg,
									call.findModel(cfg.lead),
									call.findModel(cfg.worker),
									registeredDirect,
									limitsOf(call),
								),
				};
			} catch {
				// Wrong settings end the request with an error that names the key, from the router.
				return undefined;
			}
		},

		handover,
		handback,

		onDirectCall(tool, call) {
			if (registeredDirect || tool.parentToolCallId !== undefined) return;
			if (tool.name !== HANDOVER_TOOL && tool.name !== HANDBACK_TOOL) return;
			const role = storedState(call.entries).phase;
			host.appendEntry(DIRECT_ENTRY, { tool: tool.name, role, at: Date.now() });
			call.notify(`relay: direct ${tool.name}(...) run as a codemode call`, "warning");
		},

		onSessionStart(call) {
			syncRegistration(call.model);
			if (isRelay(call.model)) followSelection(call, call.model);
		},

		onModelSelect(model, call) {
			syncRegistration(model);
			followSelection(call, model);
		},

		onBeforeAgentStart(call) {
			syncRegistration(call.model);
		},

		async beforeSettle(event, call) {
			if (!isRelay(call.model) || event.outcome !== "completed") return undefined;
			const branch = call.entries;
			const view = viewOf(call);
			const cfg = config();
			const machine = machineConfig();
			const phase = readPhase(branch);
			const drafts: RelayDraft[] = [];
			let goOn = false;
			let touched = false;
			/** A hand back the machine made for the worker (blocked): the branch does not hold it yet. */
			let handbackMade: Handback | undefined = phase.handback;
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
							handbackMade = effect.data as unknown as Handback;
							drafts.push({ type: "custom", customType: HANDBACK_ENTRY, data: effect.data });
						} else if (effect.entry === "relay.verify") {
							drafts.push({
								type: "custom",
								customType: VERIFY_ENTRY,
								data: { round: view.round, attempt: phase.failedRounds + 1, ms: attemptMs },
							});
						} else if (effect.entry === "relay.transition") {
							drafts.push({ type: "custom", customType: TRANSITION_ENTRY, data: { ...effect.data, at } });
							call.notify(`relay: worker → lead (round ${view.round})`);
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
						call.notify(effect.text, effect.level ?? "info");
						break;
					case "run_acceptance": {
						const handoverNote = phase.handover;
						const commands = handoverNote?.acceptance ?? [];
						if (commands.length > 0) {
							call.notify(`relay: running ${commands.length} acceptance command(s)`);
							const started = Date.now();
							results = await runAcceptance(commands, call.cwd, cfg.acceptanceTimeoutMs, call.signal);
							attemptMs = Date.now() - started;
							acceptanceMs += attemptMs;
							if (call.signal?.aborted) return undefined;
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
						const handoverNote = phase.handover;
						if (!handoverNote) break;
						const lastText = [...event.contextMessages]
							.reverse()
							.map(assistantText)
							.find((text) => text.trim() !== "");
						const status = handbackMade?.status ?? (view.userAsked || view.blocked ? "stopped" : "done");
						const contextLine = roundContextFact(roundContext(branch), workerLimit(call));
						const record = buildRecord({
							handover: handoverNote,
							conversation: phase.conversation,
							earlierSummary: phase.earlierSummary,
							earlierRounds: phase.earlierRounds,
							status,
							report: handbackMade?.report ?? lastText ?? "",
							changes: await describeChanges(call.cwd, handoverNote.base, cfg.diffChars),
							acceptance: results,
							failedRounds: phase.failedRounds,
							repairs: phase.repairs,
							contextLine,
						});
						const passed =
							results.length > 0
								? acceptancePassed(results)
									? ", acceptance passed"
									: ", acceptance failed"
								: "";
						const round: RoundSummary = {
							round: handoverNote.round,
							line: `Round ${handoverNote.round}: ${firstLine(handoverNote.plan, 160)} (${status}${passed})`,
						};
						call.notify(`relay: round ${handoverNote.round} handed back to the lead (${status}${passed})`);
						drafts.push(
							{ type: "custom", customType: ROUND_ENTRY, data: round },
							{
								type: "compaction",
								summary: record,
								firstKeptEntryId: null,
								details: { relay: true, round: handoverNote.round },
							},
							{
								type: "custom_message",
								customType: "relay.review",
								display: true,
								content: [
									`You are the lead again. The record above is what the worker did in round ${handoverNote.round}.`,
									roundTimeFact(handoverNote.round, phase.startedAt, acceptanceMs),
									spendFact(branch, cfg),
									contextLine,
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
			if (!touched) return undefined;
			return { entries: drafts, continue: goOn };
		},

		commands: {
			async handover(args, call) {
				if (!isRelay(call.model))
					return call.notify(`/handover works with the ${RELAY_PROVIDER}/${RELAY_MODEL} model`, "warning");
				if (!call.isIdle()) return call.notify("relay: wait for the lead to finish, or stop it first", "warning");
				const view = viewOf(call);
				const { effects } = transition(view, { type: "handover", byUser: true }, machineConfig());
				const refusal = effects.find((effect) => effect.type === "result");
				if (refusal) return call.notify(`relay: ${refusal.text}`, "warning");
				const instructions = args.trim();
				const note: Handover = {
					round: view.round + 1,
					plan: instructions || "Carry on with the task discussed above.",
					acceptance: [],
					base: await snapshot(call.cwd),
					byUser: true,
				};
				host.appendEntry(HANDOVER_ENTRY, note);
				userAsked = false;
				host.sendMessage(
					{
						customType: HANDOVER_ENTRY,
						display: true,
						content: `${USER_HANDOVER_MARKER}\nThe user gives the work to the worker model directly (round ${note.round}): ${note.plan}`,
					},
					{ triggerTurn: true },
				);
			},

			handback(call) {
				if (!isRelay(call.model))
					return call.notify(`/handback works with the ${RELAY_PROVIDER}/${RELAY_MODEL} model`, "warning");
				const { effects } = transition(
					viewOf(call),
					{ type: "handback", status: "blocked", byUser: true },
					machineConfig(),
				);
				const refusal = effects.find((effect) => effect.type === "result");
				if (refusal) return call.notify(`relay: ${refusal.text}`, "warning");
				userAsked = true;
				host.sendMessage(
					{
						customType: REQUEST_ENTRY,
						display: true,
						content: `The user asks for a hand back now. Stop working and hand back with status "blocked" and a report of where things stand.`,
					},
					{ triggerTurn: true, deliverAs: "steer" },
				);
			},

			status(call) {
				try {
					const cfg = config();
					const branch = call.entries;
					const view = viewOf(call);
					const selected = isRelay(call.model) ? "" : ` (not selected: /model ${RELAY_PROVIDER}/${RELAY_MODEL})`;
					const lines = [
						`relay${selected}: ${view.paused ? "paused, the worker has the work" : `${view.phase} has the work`}, round ${view.round}. lead ${cfg.lead}, worker ${cfg.worker}`,
					];
					if (registeredDirect) lines.push("codemode is off: the hand tools are direct tools");
					const history = describeHistory(branch);
					if (history.length > 0) lines.push("this round:", ...history.map((line) => `  ${line}`));
					const spend = spendFact(branch, cfg);
					if (spend) lines.push(spend);
					if (cfg.warmLead) {
						const refreshes = leadRefreshes(branch);
						lines.push(
							`lead prefix kept warm during worker phases: ${refreshes.count} refresh${refreshes.count === 1 ? "" : "es"}, $${Number(refreshes.cost.toFixed(4))}`,
						);
					} else lines.push("lead prefix is not kept warm (relay.warmLead is false)");
					return { text: lines.join("\n"), level: "info" };
				} catch (error) {
					return { text: `relay: ${(error as Error).message}`, level: "error" };
				}
			},
		},
	};
}
