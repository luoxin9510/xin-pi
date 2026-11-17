// graph extension entry: flow control by a graph (docs/graph.md, spec .scratch/xpi-graph/01-graph.md). A graph file
// gives a flow nodes and edges; the model works freely inside a node and can leave it only by a declared edge, with
// the `next` tool. The pure part (the file format, the checks, the state folded from the session branch) is the
// `xpi-graph` package; this file runs a graph on the agent core: the virtual model `graph/auto` routes each request to
// the current node's model, `next` records a move, and the move is entered when the turn ends.
//
// Nothing is kept in memory about a graph: every handler reads the state from the session branch, so a resumed session
// and another branch of the session tree are at the node their entries say.

import { Type } from "typebox";
import type { Api, Model, ModelThinkingLevel } from "xpi-ai";
import {
	type Edge,
	END,
	exits,
	GRAPH_END,
	GRAPH_ENTER,
	GRAPH_HALT,
	GRAPH_MOVE,
	GRAPH_NODE,
	GRAPH_START,
	type Graph,
	type GraphEntry,
	type GraphState,
	type MoveData,
	type NodeData,
	type RunningState,
	readState,
	type Selection,
	type StartData,
} from "xpi-graph";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionBoundaryDraft,
} from "../../core/extensions/types.ts";
import { isVirtualModel } from "../../core/virtual-models.ts";
import { discoverGraphs, graphDirs, readGraphFile } from "./files.ts";

export const GRAPH_PROVIDER = "graph";
export const GRAPH_MODEL = "auto";
export const NEXT_TOOL = "next";
/** The section name in the leading system message. */
export const GRAPH_SECTION = "graph";

const CODEMODE_TOOL = "codemode";
const THINKING_LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** The same text in every node, so a move between two nodes on one model keeps the prompt cache. */
const SECTION_TEXT = [
	"<graph>",
	"A graph controls the flow of this session. You are in one node of it at a time. The latest message that starts",
	'with "[graph" names the node, gives your role in it and lists the nodes you may go to next.',
	"Do the work of the current node only. Leave it by calling tools.next({ to, report }) from codemode, once, and then",
	"end your turn: the next node starts after it. You cannot go to a node that is not listed.",
	"</graph>",
].join("\n");

const isGraphModel = (model: { provider: string; id: string } | undefined) =>
	model?.provider === GRAPH_PROVIDER && model.id === GRAPH_MODEL;

/**
 * What the model is told on entering a node: the report of the node it comes from, its role, where it may go, how to
 * leave. `repeat` is the same text said again after a compaction.
 */
export function enterText(
	graph: Graph,
	node: string,
	came: { from?: string; report?: string; repeat?: boolean } = {},
): string {
	const spec = graph.nodes[node];
	const out = graph.edges.filter((edge) => edge.from === node);
	const line = (edge: Edge) => {
		const target = edge.to === END ? `"${END}" (the graph is finished)` : `"${edge.to}"`;
		const approval = edge.exit === "approve" ? " (the user is asked to approve)" : "";
		return `- ${target}${edge.label ? `: ${edge.label}` : ""}${approval}`;
	};
	return [
		`[graph ${graph.name}] ${came.repeat ? "You are still" : "You are now"} in node "${node}".`,
		...(came.report === undefined ? [] : ["", `Report of node "${came.from}":`, came.report]),
		"",
		spec.kind === "model" ? spec.prompt : "",
		"",
		"When the work of this node is done, call tools.next({ to, report }) from codemode. `report` says what you did and",
		"what the next node must know. You may go to:",
		...out.map(line),
		"Call it once, then end your turn. If you need the user, ask and end your turn without calling it.",
	].join("\n");
}

export default function graph(pi: ExtensionAPI) {
	// A subagent child works inside its parent's node: it gets no command, no tool and no virtual model.
	if (process.env.XPI_SUBAGENT_DEPTH) return;

	/** True while this extension changes the selection itself, so that its own `model_select` is not taken for the user's. */
	let selecting = false;
	let toolRegistered = false;

	const stateOf = (ctx: ExtensionContext): GraphState => {
		// Assignable without a cast: a core entry type the package cannot read fails to compile here.
		const branch: readonly GraphEntry[] = ctx.sessionManager.getBranch();
		return readState(branch);
	};

	const say = (ctx: ExtensionContext, text: string, level: "info" | "warning" | "error" = "info") => {
		if (ctx.hasUI) ctx.ui.notify(`graph: ${text}`, level);
		else if (level === "info") console.log(`graph: ${text}`);
		else console.error(`graph: ${text}`);
	};

	const findModel = (ctx: ExtensionContext, ref: string): Model<Api> | undefined => {
		const slash = ref.indexOf("/");
		return slash === -1 ? undefined : ctx.modelRegistry.find(ref.slice(0, slash), ref.slice(slash + 1));
	};

	const showStatus = (ctx: ExtensionContext, state: GraphState) => {
		if (!ctx.hasUI) return;
		if (state.status === "none") return ctx.ui.setStatus("graph", undefined);
		if (state.status === "error") return ctx.ui.setStatus("graph", "graph: cannot read the state");
		const edge = state.lastEdge === undefined ? undefined : state.graph.edges[state.lastEdge];
		const count =
			edge?.max === undefined || state.lastEdge === undefined
				? ""
				: ` (${state.counts[state.lastEdge]}/${edge.max})`;
		ctx.ui.setStatus(
			"graph",
			`graph ${state.graph.name}: ${state.node}${count}${state.halted === undefined ? "" : " (halted)"}`,
		);
	};

	/** Give the selection back as it was before the graph. */
	const restore = async (ctx: ExtensionContext, selection: Selection) => {
		const model = ctx.modelRegistry.find(selection.provider, selection.id);
		if (!model)
			return say(
				ctx,
				`the model selected before the graph, ${selection.provider}/${selection.id}, is gone`,
				"warning",
			);
		selecting = true;
		try {
			await pi.setModel(model);
			const level = THINKING_LEVELS.find((known) => known === selection.thinking);
			if (level) pi.setThinkingLevel(level);
		} finally {
			selecting = false;
		}
	};

	/** A graph that ended while `graph/auto` is still selected (the end is written before the model can be changed). */
	const restoreAfterEnd = async (ctx: ExtensionContext, state: GraphState) => {
		if (state.status === "none" && state.ended && isGraphModel(ctx.model)) await restore(ctx, state.ended.selection);
	};

	const halt = (ctx: ExtensionContext, reason: string) => {
		pi.appendEntry(GRAPH_HALT, { reason });
		showStatus(ctx, stateOf(ctx));
		say(ctx, `halted: ${reason}. Answer to go on in this node, or run /graph stop.`, "warning");
	};

	/** The entries that enter a pending move: the next node, or the end of the graph. */
	const enterDrafts = (state: RunningState, move: MoveData): { node: NodeData; text: string } | "end" => {
		const edge = state.graph.edges[move.edge];
		if (edge.to === END) return "end";
		const node: NodeData = { node: edge.to, via: move.via, edge: move.edge };
		if (move.report !== undefined) node.report = move.report;
		return { node, text: enterText(state.graph, edge.to, { from: edge.from, report: move.report }) };
	};

	/**
	 * Whether a nested call was made by a script of the latest assistant message on the branch. A nested call's id is
	 * `<the script's tool call id>/<n>`.
	 */
	const calledByLatestRequest = (ctx: ExtensionContext, toolCallId: string): boolean => {
		const parent = toolCallId.slice(0, toolCallId.lastIndexOf("/"));
		const latest = ctx.sessionManager
			.getBranch()
			.findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
		if (latest?.type !== "message" || latest.message.role !== "assistant") return false;
		return latest.message.content.some((block) => block.type === "toolCall" && block.id === parent);
	};

	const registerTool = () => {
		if (toolRegistered) return;
		toolRegistered = true;
		pi.registerTool({
			name: NEXT_TOOL,
			label: "Next",
			effect: "write",
			description:
				"Graph mode: leave the current node of the graph for one of the nodes it may go to. Call it once when the node's work is done, then end your turn.",
			exposure: "deferred",
			listed: false,
			defaultActive: false,
			parameters: Type.Object({
				to: Type.String({ description: "The node to go to: one of those the current node lists." }),
				report: Type.String({ description: "What you did in this node and what the next node must know." }),
			}),
			async execute(toolCallId, params, _signal, _onUpdate, ctx) {
				const state = stateOf(ctx);
				if (state.status !== "running") throw new Error("No graph is running.");
				if (state.halted !== undefined) {
					throw new Error(
						`The graph is halted (${state.halted}). The user decides how it goes on: end your turn.`,
					);
				}
				if (state.pending)
					throw new Error(
						"A move is already accepted for this visit. End your turn: the next node starts after it.",
					);
				// A move belongs to the request that asked for it. A script that outlived that request (a background
				// script, a released call) may run in a later turn or in another node: it cannot move the graph.
				if (ctx.isIdle() || !calledByLatestRequest(ctx, toolCallId)) {
					throw new Error("A move is made in the turn of its node, not from a background script.");
				}
				const choices = exits(state).filter(
					(choice) => choice.edge.exit === "model" || choice.edge.exit === "approve",
				);
				const choice = choices.find((candidate) => candidate.edge.to === params.to);
				if (!choice) {
					const list = choices.map(
						(candidate) => `"${candidate.edge.to}"${candidate.edge.label ? ` (${candidate.edge.label})` : ""}`,
					);
					throw new Error(
						`"${params.to}" is not a node "${state.node}" may go to. It may go to: ${list.join(", ")}.`,
					);
				}
				if (!choice.open) {
					halt(ctx, `"${state.node}" -> "${choice.edge.to}" was taken ${choice.count} times, its limit`);
					throw new Error(
						`The edge to "${params.to}" is at its limit of ${choice.count}. The graph is halted and the user decides: end your turn.`,
					);
				}
				const move: MoveData = { edge: choice.index, via: "model", report: params.report };
				pi.appendEntry(GRAPH_MOVE, move);
				const where = choice.edge.to === END ? "The graph ends" : `Node "${choice.edge.to}" starts`;
				return {
					content: [
						{ type: "text" as const, text: `Move accepted. ${where} when this turn ends: end your turn now.` },
					],
					details: {},
					terminate: true,
				};
			},
		});
	};

	pi.registerVirtualModel({
		provider: GRAPH_PROVIDER,
		id: GRAPH_MODEL,
		name: "Graph (set by /graph start: each node's own model)",
		route: (request, ctx) => {
			const state = stateOf(ctx);
			// A graph that just ended, with the selection not given back yet (a queued message of the same run): the
			// model selected before the graph answers.
			const ended = state.status === "none" ? state.ended?.selection : undefined;
			const before = ended ? ctx.modelRegistry.find(ended.provider, ended.id) : undefined;
			if (ended && before) {
				return {
					model: before,
					thinkingLevel: THINKING_LEVELS.find((level) => level === ended.thinking) ?? request.thinkingLevel,
				};
			}
			if (state.status === "none" || (state.status === "error" && !state.selection)) {
				// Selected by hand with no graph running: answer with the model that answered last.
				if (request.previous) {
					return {
						model: request.previous.model,
						thinkingLevel: request.previous.thinkingLevel ?? request.thinkingLevel,
					};
				}
				throw new Error("No graph is running. Start one with /graph start <name>, or select another model.");
			}
			const selection = state.selection;
			if (selection === undefined) throw new Error("graph: no selection to fall back to");
			const node = state.status === "running" ? state.graph.nodes[state.node] : undefined;
			const ref = node?.kind === "model" && node.model ? node.model : `${selection.provider}/${selection.id}`;
			const model = findModel(ctx, ref);
			if (!model) throw new Error(`graph: the model ${ref} is not available`);
			const wanted = node?.kind === "model" && node.thinking ? node.thinking : selection.thinking;
			return { model, thinkingLevel: THINKING_LEVELS.find((level) => level === wanted) ?? request.thinkingLevel };
		},
	});

	pi.on("context_with_system", async (event, ctx) => {
		const head = event.messages[0];
		if (!head || head.role !== "system") return undefined;
		const running = stateOf(ctx).status === "running";
		if (running === (head.sections?.[GRAPH_SECTION] === SECTION_TEXT)) return undefined;
		const sections = { ...head.sections };
		if (running) sections[GRAPH_SECTION] = SECTION_TEXT;
		else delete sections[GRAPH_SECTION];
		return { messages: [{ ...head, sections }, ...event.messages.slice(1)] };
	});

	// A move is entered when its turn ends, whatever ended it, so a node never changes in the middle of a turn.
	pi.on("agent_before_settle", async (event, ctx) => {
		const state = stateOf(ctx);
		if (state.status !== "running" || !state.pending) return undefined;
		const entered = enterDrafts(state, state.pending);
		if (entered === "end") {
			const drafts: SessionBoundaryDraft[] = [{ type: "custom", customType: GRAPH_END, data: { reason: "done" } }];
			say(ctx, `${state.graph.name} is finished`);
			return { entries: [...event.entries, ...drafts], continue: false };
		}
		const drafts: SessionBoundaryDraft[] = [
			{ type: "custom", customType: GRAPH_NODE, data: entered.node },
			{ type: "custom_message", customType: GRAPH_ENTER, display: true, content: entered.text },
		];
		// A turn the user cut off, or one that failed, gets no request of its own: the node starts with the next message.
		return { entries: [...event.entries, ...drafts], continue: event.outcome === "completed" };
	});

	// One run can pass several nodes: the status follows at each request.
	pi.on("request_start", async (_event, ctx) => {
		if (isGraphModel(ctx.model)) showStatus(ctx, stateOf(ctx));
	});

	pi.on("agent_settled", async (_event, ctx) => {
		const state = stateOf(ctx);
		await restoreAfterEnd(ctx, state);
		showStatus(ctx, state);
	});

	// A move whose turn never settled (a quit, a crash) is entered before the next run starts.
	pi.on("before_agent_start", async (_event, ctx) => {
		const state = stateOf(ctx);
		if (state.status === "error") {
			say(ctx, `cannot read the graph's state (${state.message}). Run /graph stop.`, "error");
			return undefined;
		}
		if (state.status !== "running" || !state.pending) return undefined;
		const entered = enterDrafts(state, state.pending);
		if (entered === "end") {
			pi.appendEntry(GRAPH_END, { reason: "done" });
			say(ctx, `${state.graph.name} is finished`);
			await restoreAfterEnd(ctx, stateOf(ctx));
			return undefined;
		}
		pi.appendEntry(GRAPH_NODE, entered.node);
		return { message: { customType: GRAPH_ENTER, content: entered.text, display: true } };
	});

	// A compaction can summarise the node's role away: say it again.
	pi.on("session_compact", async (_event, ctx) => {
		const state = stateOf(ctx);
		// With a move pending the node is about to change, and its own entry message follows.
		if (state.status !== "running" || state.pending) return;
		// Never a turn of its own: a compaction after a turn must not start another request.
		pi.sendMessage(
			{ customType: GRAPH_ENTER, content: enterText(state.graph, state.node, { repeat: true }), display: false },
			{ triggerTurn: false },
		);
	});

	pi.on("session_start", async (_event, ctx) => {
		const state = stateOf(ctx);
		if (state.status === "running") registerTool();
		await restoreAfterEnd(ctx, state);
		showStatus(ctx, state);
	});

	pi.on("session_tree", async (_event, ctx) => {
		const state = stateOf(ctx);
		if (state.status === "running") registerTool();
		showStatus(ctx, state);
	});

	pi.on("model_select", async (event, ctx) => {
		// A resumed session restores its selection, and this extension changes it at the start and the end of a graph.
		if (selecting || event.source === "restore") return;
		const state = stateOf(ctx);
		if (isGraphModel(event.model)) {
			if (state.status === "none") say(ctx, "no graph is running: start one with /graph start <name>", "warning");
			return;
		}
		if (state.status === "none") return;
		pi.appendEntry(GRAPH_END, { reason: "model_changed" });
		say(ctx, "ended: another model was selected", "warning");
		showStatus(ctx, { status: "none" });
	});

	/** Why this graph cannot run yet, or undefined. Milestone 2 runs model nodes and `model` edges only. */
	const notSupportedYet = (graph: Graph): string | undefined => {
		for (const [id, node] of Object.entries(graph.nodes)) {
			if (node.kind === "command") return `node "${id}" is a command node`;
			if (node.deny.length > 0 || node.readOnly.length > 0) return `node "${id}" has limits (deny, readOnly)`;
		}
		const approve = graph.edges.find((edge) => edge.exit === "approve");
		return approve ? `the edge "${approve.from}" -> "${approve.to}" needs an approval` : undefined;
	};

	async function start(name: string, ctx: ExtensionCommandContext): Promise<void> {
		if (stateOf(ctx).status !== "none")
			return say(ctx, "a graph already runs in this session: /graph stop ends it", "warning");
		if (!pi.getActiveTools().includes(CODEMODE_TOOL)) {
			return say(ctx, "a graph needs codemode: the model leaves a node with tools.next from a script", "warning");
		}
		const selected = ctx.model;
		if (!selected || isVirtualModel(selected)) {
			return say(
				ctx,
				"select a physical model first: a graph falls back to the model selected when it starts",
				"warning",
			);
		}
		const files = discoverGraphs(ctx.cwd, ctx.isProjectTrusted());
		const file = files.find((candidate) => candidate.name === name);
		if (!file) {
			const known = files.map((candidate) => candidate.name).join(", ") || "none";
			return say(ctx, `no graph "${name}" (found: ${known})`, "warning");
		}
		let literal: unknown;
		let definition: Graph;
		try {
			({ literal, graph: definition } = readGraphFile(file));
		} catch (error) {
			return say(ctx, `${file.path}: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
		const missing = notSupportedYet(definition);
		if (missing) return say(ctx, `${name} cannot run yet: ${missing}, which is not supported yet`, "warning");
		for (const [id, node] of Object.entries(definition.nodes)) {
			if (node.kind !== "model") continue;
			if (node.model !== undefined) {
				const model = findModel(ctx, node.model);
				if (!model) return say(ctx, `${name}: nodes.${id}.model: no model ${node.model}`, "error");
				if (isVirtualModel(model))
					return say(ctx, `${name}: nodes.${id}.model: ${node.model} is a virtual model`, "error");
			}
			if (node.thinking !== undefined && !THINKING_LEVELS.some((level) => level === node.thinking)) {
				return say(ctx, `${name}: nodes.${id}.thinking: must be one of ${THINKING_LEVELS.join(", ")}`, "error");
			}
		}
		const router = ctx.modelRegistry.find(GRAPH_PROVIDER, GRAPH_MODEL);
		if (!router) return say(ctx, "the graph model is not registered", "error");

		const begin: StartData = {
			graph: literal,
			path: file.path,
			selection: { provider: selected.provider, id: selected.id, thinking: pi.getThinkingLevel() },
		};
		const first: NodeData = { node: definition.start, via: "start" };
		pi.appendEntry(GRAPH_START, begin);
		pi.appendEntry(GRAPH_NODE, first);
		registerTool();
		selecting = true;
		let selectedRouter: boolean;
		try {
			selectedRouter = await pi.setModel(router);
		} finally {
			selecting = false;
		}
		if (!selectedRouter) {
			pi.appendEntry(GRAPH_END, { reason: "stopped" });
			return say(ctx, "could not select the graph model", "error");
		}
		showStatus(ctx, stateOf(ctx));
		say(ctx, `${name} started in "${definition.start}"`);
		pi.sendMessage(
			{ customType: GRAPH_ENTER, content: enterText(definition, definition.start), display: true },
			{ triggerTurn: true },
		);
		// Without a UI (print mode) the process ends when the command returns: wait for the graph's turns.
		if (!ctx.hasUI) await ctx.waitForIdle();
	}

	async function stop(ctx: ExtensionContext): Promise<void> {
		const state = stateOf(ctx);
		if (state.status === "none") return say(ctx, "no graph is running", "warning");
		pi.appendEntry(GRAPH_END, { reason: "stopped" });
		if (state.selection && isGraphModel(ctx.model)) await restore(ctx, state.selection);
		showStatus(ctx, { status: "none" });
		say(ctx, "stopped");
	}

	function status(ctx: ExtensionContext): void {
		const state = stateOf(ctx);
		if (state.status === "error") {
			say(ctx, `cannot read the state: ${state.message}\nRun /graph stop.`, "error");
		} else if (state.status === "running") {
			const loops = exits(state)
				.filter((choice) => choice.edge.max !== undefined)
				.map((choice) => `  "${state.node}" -> "${choice.edge.to}": ${choice.count}/${choice.edge.max}`);
			say(
				ctx,
				[
					`${state.graph.name} (${state.path})`,
					`node: ${state.node}${state.halted === undefined ? "" : ` (halted: ${state.halted})`}`,
					`visited: ${state.visited.join(" -> ")}`,
					...(loops.length > 0 ? ["limits of the edges out:", ...loops] : []),
				].join("\n"),
			);
		} else {
			const trusted = ctx.isProjectTrusted();
			const files = discoverGraphs(ctx.cwd, trusted);
			const dirs = graphDirs(ctx.cwd, trusted).map((place) => `  ${place.dir}`);
			say(
				ctx,
				[
					"no graph is running",
					...(files.length > 0
						? ["graphs:", ...files.map((file) => `  ${file.name} (${file.path})`)]
						: ["no graph files found in:", ...dirs]),
					"usage: /graph start <name> | /graph stop",
				].join("\n"),
			);
		}
	}

	pi.registerCommand("graph", {
		description: "Flow control by a graph: show the state, or [start <name> | stop]",
		handler: async (args, ctx) => {
			const [word, name, ...rest] = args.trim().split(/\s+/);
			if (word === "" || word === undefined) return status(ctx);
			if (word === "start" && name && rest.length === 0) return start(name, ctx);
			if (word === "stop" && name === undefined) return stop(ctx);
			say(ctx, "usage: /graph [start <name> | stop]", "warning");
		},
	});
}
