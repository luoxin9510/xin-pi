// relay extension entry: the virtual model `relay/auto`. A strong model (the lead) explores, plans and reviews; a
// cheap model (the worker) builds. The logic is the `xpi-relay` package (docs/relay.md, packages/xpi-relay/README.md);
// this file wires it to the agent core: it implements `RelayHost` on the extension API, builds a `RelayCall` from each
// handler's context, and forwards. No decision is taken here.

import type { AgentMessage } from "xpi-agent-core";
import {
	createRelay,
	isRelay,
	RELAY_MODEL,
	RELAY_PROVIDER,
	RELAY_SECTION,
	type RelayCall,
	type RelayDraft,
	type RelayEntry,
	type RelayState,
	splitModelRef,
	type ToolSpec,
} from "xpi-relay";
import type { ExtensionAPI, ExtensionContext, SessionBoundaryDraft } from "../../core/extensions/types.ts";
import { convertToLlm } from "../../core/messages.ts";
import { SETTINGS_DEFAULTS } from "../../core/settings-defaults.ts";

export { HANDOVER_ENTRY, RELAY_MODEL, RELAY_PROVIDER, readPhase } from "xpi-relay";

type Level = "info" | "warning" | "error";

/** The key of the step list's widget. */
const STEPS_WIDGET = "relay-steps";

export default function relay(pi: ExtensionAPI) {
	// Subagent children are workers already: they never get the relay model or its tools.
	if (process.env.XPI_SUBAGENT_DEPTH) return;

	/** What one handler call carries, read from its context at each use. */
	const callOf = (ctx: ExtensionContext): RelayCall => ({
		get entries() {
			// Assignable without a cast: a new core entry type fails to compile here until `RelayEntry` lists it.
			const branch: readonly RelayEntry[] = ctx.sessionManager.getBranch();
			return branch;
		},
		get model() {
			return ctx.model;
		},
		get cwd() {
			return ctx.cwd;
		},
		get signal() {
			return ctx.signal;
		},
		findModel(ref) {
			const { provider, id } = splitModelRef(ref);
			return ctx.modelRegistry.find(provider, id);
		},
		notify(text: string, level: Level = "info") {
			if (ctx.hasUI) ctx.ui.notify(text, level);
			else if (process.argv.includes("--verbose")) process.stderr.write(`${text}\n`);
		},
		isIdle: () => ctx.isIdle(),
	});

	/** The step list above the editor: who has the work, the round, the steps. Set again only when it changed. */
	let shownSteps = "";
	const showSteps = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const lines = relayHost.stepsWidget(callOf(ctx));
		const key = lines?.join("\n") ?? "";
		if (key === shownSteps) return;
		shownSteps = key;
		ctx.ui.setWidget(STEPS_WIDGET, lines);
	};

	const registerTool = (spec: ToolSpec) =>
		pi.registerTool({
			name: spec.name,
			label: spec.label,
			effect: spec.effect,
			description: spec.description,
			exposure: spec.exposure,
			listed: spec.listed,
			defaultActive: spec.defaultActive,
			parameters: spec.parameters,
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				const outcome = await spec.execute(params, signal, callOf(ctx));
				return {
					content: [{ type: "text" as const, text: outcome.text }],
					details: {},
					...(outcome.terminate ? { terminate: true } : {}),
					...(outcome.signal ? { signal: outcome.signal } : {}),
				};
			},
		});

	const relayHost = createRelay({
		appendEntry: (type, data) => pi.appendEntry(type, data),
		settings: () => (pi.getSettings() as { relay?: unknown }).relay,
		// The compaction setting as the core resolves it for the selected model, which is relay/auto: its override first.
		keepRecentTokens: () => {
			const compaction = pi.getSettings().compaction;
			return (
				compaction?.modelOverrides?.[`${RELAY_PROVIDER}/${RELAY_MODEL}`]?.keepRecentTokens ??
				compaction?.keepRecentTokens ??
				SETTINGS_DEFAULTS.compaction.keepRecentTokens
			);
		},
		sendMessage: (message, options) => pi.sendMessage(message, options),
		activeTools: () => pi.getActiveTools(),
		setActiveTools: (names) => pi.setActiveTools(names),
		registerTools: (specs) => {
			for (const spec of specs) registerTool(spec);
		},
	});

	pi.registerVirtualModel<RelayState>({
		provider: RELAY_PROVIDER,
		id: RELAY_MODEL,
		name: "Relay (lead plans and reviews, worker builds)",
		route: (request, ctx) => {
			const { model, thinkingLevel, state, contextLimit, cache } = relayHost.route(request, callOf(ctx));
			// Left out here, the limit would be dropped at the host boundary and the core would never compact by it.
			return {
				model,
				thinkingLevel,
				state,
				...(contextLimit !== undefined ? { contextLimit } : {}),
				...(cache ? { cache } : {}),
			};
		},
	});

	pi.on("request_start", async (event, ctx) => {
		relayHost.onRequestStart(event, callOf(ctx));
		showSteps(ctx);
	});
	// A tick shows as soon as its call ends, and the hand back when the run does.
	pi.on("tool_execution_end", async (_event, ctx) => showSteps(ctx));
	pi.on("agent_end", async (_event, ctx) => showSteps(ctx));

	pi.on("tool_call", async (event, ctx) => {
		relayHost.onDirectCall({ name: event.toolName, parentToolCallId: event.parentToolCallId }, callOf(ctx));
		return undefined;
	});

	pi.on("context_with_system", async (event, ctx) => {
		const call = callOf(ctx);
		// The worker reads the lead's work as a quote, not as assistant messages it would take for its own. The quote is
		// made from what the provider would get: session-only kinds (bash runs, custom messages, summaries) converted.
		const quoted = isRelay(call.model) ? relayHost.quoteLead(convertToLlm(event.messages), call) : undefined;
		const messages: AgentMessage[] = quoted ?? event.messages;
		const head = messages[0];
		if (!head || head.role !== "system") return quoted ? { messages } : undefined;
		const section = relayHost.section(call, quoted !== undefined);
		if (!section) return quoted ? { messages } : undefined;
		const sections = { ...head.sections };
		if (section.text === undefined) {
			if (!(RELAY_SECTION in sections)) return quoted ? { messages } : undefined;
			delete sections[RELAY_SECTION];
		} else {
			if (sections[RELAY_SECTION] === section.text) return quoted ? { messages } : undefined;
			sections[RELAY_SECTION] = section.text;
		}
		return { messages: [{ ...head, sections }, ...messages.slice(1)] };
	});

	pi.on("session_start", async (_event, ctx) => {
		relayHost.onSessionStart(callOf(ctx));
		showSteps(ctx);
	});
	pi.on("model_select", async (event, ctx) => {
		relayHost.onModelSelect(event.model, callOf(ctx));
		showSteps(ctx);
	});
	pi.on("before_agent_start", async (_event, ctx) => {
		relayHost.onBeforeAgentStart(callOf(ctx));
		return undefined;
	});

	pi.on("agent_before_settle", async (event, ctx) => {
		const result = await relayHost.beforeSettle(
			{ outcome: event.outcome, contextMessages: event.context.contextMessages },
			callOf(ctx),
		);
		if (!result) return undefined;
		return { entries: [...event.entries, ...result.entries.map(boundaryDraft)], continue: result.continue };
	});

	pi.registerCommand("handover", {
		description: "Relay: give the work to the worker model now, without a plan from the lead",
		handler: (args, ctx) => relayHost.commands.handover(args, callOf(ctx)),
	});

	pi.registerCommand("handback", {
		description: "Relay: wake the lead now; the worker reports where things stand",
		handler: async (_args, ctx) => relayHost.commands.handback(callOf(ctx)),
	});

	pi.registerCommand("relay", {
		description: "Relay: show who has the work, the round, the two models, this round's history and the spend",
		handler: async (_args, ctx) => {
			const call = callOf(ctx);
			const status = relayHost.commands.status(call);
			call.notify(status.text, status.level);
		},
	});
}

/** A draft of the package is a draft of the core. */
function boundaryDraft(draft: RelayDraft): SessionBoundaryDraft {
	return draft;
}
