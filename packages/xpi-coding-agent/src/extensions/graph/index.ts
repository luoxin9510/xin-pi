// graph extension entry: flow control by a graph (docs/graph.md, spec .scratch/xpi-graph/01-graph.md). A graph file
// gives a flow nodes and edges; the model works freely inside a node and can leave it only by a declared edge, with
// the `next` tool. The pure part (the file format, the checks, the state folded from the session branch) is the
// `xpi-graph` package; this file runs a graph on the agent core: the virtual model `graph/auto` routes each request to
// the current node's model, `next` records a move, the move is entered when the turn ends, and a command node is run
// by this file, never by the model.
//
// Nothing is kept in memory about a graph: every handler reads the state from the session branch, so a resumed session
// and another branch of the session tree are at the node their entries say.

import { Type } from "typebox";
import type { Api, Model, ModelThinkingLevel } from "xpi-ai";
import {
	type Edge,
	END,
	exits,
	GRAPH_BLOCKED,
	GRAPH_COMMAND,
	GRAPH_END,
	GRAPH_ENTER,
	GRAPH_HALT,
	GRAPH_MOVE,
	GRAPH_NODE,
	GRAPH_REMINDER,
	GRAPH_START,
	type Graph,
	type GraphEntry,
	type GraphState,
	type MoveData,
	type NodeData,
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
import { type CheckRunner, type RunResult, runCheckCommand } from "../checks/runner.ts";
import { realPathOf } from "../protect/match.ts";
import { discoverGraphs, graphDirs, readGraphFile } from "./files.ts";
import { blockedBy, LIMITS_ENV, limitsOf, type NodeLimits, readLimitsEnv } from "./limits.ts";

export const GRAPH_PROVIDER = "graph";
export const GRAPH_MODEL = "auto";
export const NEXT_TOOL = "next";
/** The section name in the leading system message. */
export const GRAPH_SECTION = "graph";

const CODEMODE_TOOL = "codemode";
const THINKING_LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
/** How much of a command's output the session keeps. */
const OUTPUT_LINES = 200;
const APPROVE = "Approve";
const SEND_BACK = "Send back";
const STOP = "Stop the graph";

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
 * What the model is told on entering a node: the report of the node it comes from, its role, what it may not write,
 * where it may go, how to leave. `repeat` is the same text said again after a compaction.
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
	const readOnly = spec.kind === "model" ? spec.readOnly : [];
	return [
		`[graph ${graph.name}] ${came.repeat ? "You are still" : "You are now"} in node "${node}".`,
		...(came.report === undefined ? [] : ["", `Report of node "${came.from}":`, came.report]),
		"",
		spec.kind === "model" ? spec.prompt : "",
		...(readOnly.length === 0
			? []
			: [
					"",
					`In this node you must not write these paths (gitignore patterns): ${readOnly.join(", ")}. That holds for`,
					"shell commands too, not only for the file tools.",
				]),
		"",
		"When the work of this node is done, call tools.next({ to, report }) from codemode. `report` says what you did and",
		"what the next node must know. You may go to:",
		...out.map(line),
		"Call it once, then end your turn. If you need the user, ask and end your turn without calling it.",
	].join("\n");
}

/** What the session keeps of a command node's run: the command, how it ended, the end of its output. */
export function commandText(graph: string, node: string, run: string, result: RunResult): string {
	const lines = result.output.replace(/\n+$/, "").split("\n");
	const cut = lines.length > OUTPUT_LINES ? [`(the last ${OUTPUT_LINES} of ${lines.length} lines)`] : [];
	const how = result.timedOut ? "timed out" : result.code === 0 ? "passed (exit 0)" : `failed (exit ${result.code})`;
	return [`[graph ${graph}] Command node "${node}" ${how}.`, `$ ${run}`, ...cut, ...lines.slice(-OUTPUT_LINES)].join(
		"\n",
	);
}

/** Where entering a move, or running a command node, has led. */
type Outcome =
	/** A model node is entered; `text` is its entry message, not written yet. */
	| { kind: "model"; text: string }
	| { kind: "end"; graph: string }
	| { kind: "halt"; reason: string; onCommand: boolean }
	/** A command's result is recorded as a pending move: a turn runs, and the move is entered when it ends. */
	| { kind: "wait" };

/** Where the entries and messages of a step go: drafts of a boundary, or straight to the session. */
interface Sink {
	entry(customType: string, data: unknown): void;
	message(customType: string, content: string): void;
}

/** `run` is the command runner; tests pass a fake. */
export function createGraphExtension(options: { run?: CheckRunner } = {}) {
	const run = options.run ?? runCheckCommand;
	return function graph(pi: ExtensionAPI) {
		// A subagent child works inside its parent's node: it gets no command, no tool and no virtual model, only the
		// limits of the node its parent was in when it started.
		if (process.env.XPI_SUBAGENT_DEPTH) {
			pi.on("tool_call", (event, ctx) => {
				const limits = readLimitsEnv(process.env[LIMITS_ENV]);
				const blocked =
					limits && blockedBy(limits, { ...event, input: event.input as Record<string, unknown> }, ctx.cwd);
				return blocked ? { block: true, reason: blocked.reason } : undefined;
			});
			return;
		}

		/** True while this extension changes the selection itself, so that its own `model_select` is not taken for the user's. */
		let selecting = false;
		let toolRegistered = false;
		/** The abort handle of a command node that runs outside a turn (`/graph start`, `/graph goto`). */
		let commandRun: AbortController | undefined;

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

		/** The limits in force for this session now, or undefined when no graph runs. */
		const limitsNow = (ctx: ExtensionContext, state: GraphState): NodeLimits | undefined => {
			if (state.status !== "running") return undefined;
			const sessionFile = ctx.sessionManager.getSessionFile();
			const kept = [
				...graphDirs(ctx.cwd, ctx.isProjectTrusted()).map((place) => place.dir),
				...(sessionFile ? [sessionFile] : []),
			].map(realPathOf);
			return limitsOf(state, kept);
		};

		/** Show the state in the footer, and leave the node's limits where a subagent child finds them. */
		const sync = (ctx: ExtensionContext, state: GraphState, running?: string) => {
			const limits = limitsNow(ctx, state);
			if (limits) process.env[LIMITS_ENV] = JSON.stringify(limits);
			else delete process.env[LIMITS_ENV];
			if (!ctx.hasUI) return;
			if (state.status === "none") return ctx.ui.setStatus("graph", undefined);
			if (state.status === "error") return ctx.ui.setStatus("graph", "graph: cannot read the state");
			const edge = state.lastEdge === undefined ? undefined : state.graph.edges[state.lastEdge];
			const count =
				edge?.max === undefined || state.lastEdge === undefined
					? ""
					: ` (${state.counts[state.lastEdge]}/${edge.max})`;
			const mark = running ? " (running)" : state.halted === undefined ? "" : " (halted)";
			ctx.ui.setStatus("graph", `graph ${state.graph.name}: ${running ?? state.node}${count}${mark}`);
		};

		/** Give the selection back as it was before the graph. */
		const restore = async (ctx: ExtensionContext, selection: Selection) => {
			const model = ctx.modelRegistry.find(selection.provider, selection.id);
			if (!model) {
				say(ctx, `the model selected before the graph, ${selection.provider}/${selection.id}, is gone`, "warning");
				return;
			}
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
			if (state.status === "none" && state.ended && isGraphModel(ctx.model))
				await restore(ctx, state.ended.selection);
		};

		const haltNotice = (ctx: ExtensionContext, reason: string, onCommand: boolean) => {
			const how = onCommand
				? "Run /graph goto <node> to go on (the same node runs its command again), or /graph stop."
				: "Answer to go on in this node, or run /graph goto <node> or /graph stop.";
			say(ctx, `halted: ${reason}. ${how}`, "warning");
		};

		const direct: Sink = {
			entry: (customType, data) => pi.appendEntry(customType, data),
			message: (customType, content) =>
				pi.sendMessage({ customType, content, display: true }, { triggerTurn: false }),
		};

		/**
		 * Go on from where the branch is: enter a pending move, run command nodes, and stop at a model node, the end, or
		 * a halt. The entries are written through `sink` and folded here as they are written, because the drafts of a
		 * boundary are not on the branch yet. `mayWait`: outside a turn, a command's result is left as a pending move
		 * when a turn has started meanwhile, so a node never changes in the middle of a turn.
		 */
		async function proceed(
			ctx: ExtensionContext,
			sink: Sink,
			signal: AbortSignal | undefined,
			mayWait: boolean,
		): Promise<Outcome> {
			const branch: readonly GraphEntry[] = ctx.sessionManager.getBranch();
			const local: GraphEntry[] = [...branch];
			const write = (customType: string, data: unknown) => {
				local.push({ type: "custom", customType, data });
				sink.entry(customType, data);
			};
			let came: { from: string; report?: string } | undefined;
			for (;;) {
				const state = readState(local);
				if (state.status !== "running") {
					return { kind: "halt", reason: "the graph's state cannot be read", onCommand: false };
				}
				const { graph: definition } = state;
				if (state.pending) {
					const edge = definition.edges[state.pending.edge];
					if (edge.to === END) {
						write(GRAPH_END, { reason: "done" });
						return { kind: "end", graph: definition.name };
					}
					const entered: NodeData = { node: edge.to, via: state.pending.via, edge: state.pending.edge };
					if (state.pending.report !== undefined) entered.report = state.pending.report;
					came = { from: edge.from, report: state.pending.report };
					write(GRAPH_NODE, entered);
					continue;
				}
				const node = definition.nodes[state.node];
				if (node.kind === "model") return { kind: "model", text: enterText(definition, state.node, came) };

				say(ctx, `running "${state.node}": ${node.run}`);
				sync(ctx, state, state.node);
				const result = await run(node.run, { cwd: ctx.cwd, timeoutMs: node.timeoutMs, signal });
				if (result.aborted) {
					const reason = `"${state.node}" was stopped while its command ran`;
					write(GRAPH_HALT, { reason });
					return { kind: "halt", reason, onCommand: true };
				}
				sink.message(GRAPH_COMMAND, commandText(definition.name, state.node, node.run, result));
				const via = result.code === 0 && !result.timedOut ? "pass" : "fail";
				const word = via === "pass" ? "passed" : result.timedOut ? "timed out" : "failed";
				const choice = exits(state).find((candidate) => candidate.edge.exit === via);
				const reason = !choice
					? `"${state.node}" ${word} and has no ${via} edge`
					: choice.open
						? undefined
						: `"${state.node}" ${word} and "${state.node}" -> "${choice.edge.to}" was taken ${choice.count} times, its limit`;
				if (!choice || reason !== undefined) {
					write(GRAPH_HALT, { reason });
					return { kind: "halt", reason: reason ?? "", onCommand: true };
				}
				const move: MoveData = { edge: choice.index, via, report: `Command node "${state.node}" ${word}.` };
				write(GRAPH_MOVE, move);
				if (mayWait && !ctx.isIdle()) return { kind: "wait" };
			}
		}

		/** Go on outside a turn (`/graph start`, `/graph goto`): the entries go straight to the session. */
		async function proceedNow(ctx: ExtensionCommandContext): Promise<void> {
			commandRun = new AbortController();
			let outcome: Outcome;
			try {
				outcome = await proceed(ctx, direct, commandRun.signal, true);
			} finally {
				commandRun = undefined;
			}
			const state = stateOf(ctx);
			if (outcome.kind === "end") {
				say(ctx, `${outcome.graph} is finished`);
				await restoreAfterEnd(ctx, state);
			} else if (outcome.kind === "halt") haltNotice(ctx, outcome.reason, outcome.onCommand);
			sync(ctx, stateOf(ctx));
			if (outcome.kind !== "model") return;
			pi.sendMessage({ customType: GRAPH_ENTER, content: outcome.text, display: true }, { triggerTurn: true });
			// Without a UI (print mode) the process ends when the command returns: wait for the graph's turns.
			if (!ctx.hasUI) await ctx.waitForIdle();
		}

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
					const stay = (text: string) => ({
						content: [{ type: "text" as const, text }],
						details: {},
						terminate: true,
					});
					const state = stateOf(ctx);
					if (state.status !== "running") throw new Error("No graph is running.");
					if (state.graph.nodes[state.node].kind === "command") {
						throw new Error(
							`The graph is on the command node "${state.node}". Only the user moves it from here (/graph goto, /graph stop): end your turn.`,
						);
					}
					if (state.halted !== undefined) {
						throw new Error(
							`The graph is halted (${state.halted}). The user decides how it goes on: end your turn.`,
						);
					}
					if (state.pending) {
						throw new Error(
							"A move is already accepted for this visit. End your turn: the next node starts after it.",
						);
					}
					if (!toolCallId.includes("/")) {
						throw new Error("next is called from a codemode script: tools.next({ to, report }).");
					}
					// A move belongs to the request that asked for it. A script that outlived that request (a background
					// script, a released call) may run in a later turn or in another node: it cannot move the graph.
					if (ctx.isIdle() || !calledByLatestRequest(ctx, toolCallId)) {
						throw new Error(
							"A move is made by a script of the node's current request, not by one that outlived its request (a background script).",
						);
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
					const route = `"${state.node}" -> "${choice.edge.to}"`;
					const halt = (reason: string) => {
						pi.appendEntry(GRAPH_HALT, { reason });
						sync(ctx, stateOf(ctx));
						haltNotice(ctx, reason, false);
					};
					if (!choice.open) {
						halt(`${route} was taken ${choice.count} times, its limit`);
						throw new Error(
							`The edge to "${params.to}" is at its limit of ${choice.count}. The graph is halted and the user decides: end your turn.`,
						);
					}
					if (choice.edge.exit === "approve") {
						if (!ctx.hasUI) {
							halt(`${route} needs the user's approval, and there is no UI to ask`);
							throw new Error(
								"This move needs the user's approval and nobody can be asked. The graph is halted: end your turn.",
							);
						}
						const answer = await ctx.ui.select(
							`Graph ${state.graph.name}: let "${state.node}" go on to "${choice.edge.to}"?`,
							[APPROVE, SEND_BACK, STOP],
						);
						if (answer === STOP) {
							pi.appendEntry(GRAPH_END, { reason: "stopped" });
							say(ctx, "stopped");
							return stay("The user stopped the graph. End your turn.");
						}
						// Dismissing the question is not an approval.
						if (answer !== APPROVE) {
							return stay("The user sent this back and will say why. End your turn and wait for the comment.");
						}
						// The question took time: only the state as it is now counts.
						const now = stateOf(ctx);
						if (now.status !== "running" || now.node !== state.node || now.pending || now.halted !== undefined) {
							throw new Error("The graph moved on while the user was asked. End your turn.");
						}
					}
					const move: MoveData = {
						edge: choice.index,
						via: choice.edge.exit === "approve" ? "approve" : "model",
						report: params.report,
					};
					pi.appendEntry(GRAPH_MOVE, move);
					const where = choice.edge.to === END ? "The graph ends" : `Node "${choice.edge.to}" starts`;
					return stay(`Move accepted. ${where} when this turn ends: end your turn now.`);
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
					// Selected by hand in a session that ran no graph: answer with the model that answered last.
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
				// On a command node (its command running, or halted there) no node is at work: the model selected before
				// the graph answers the user.
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

		// The limits of the node, on every call: a codemode script's nested calls come through here too.
		pi.on("tool_call", (event, ctx) => {
			const limits = limitsNow(ctx, stateOf(ctx));
			if (!limits) return undefined;
			const blocked = blockedBy(limits, { ...event, input: event.input as Record<string, unknown> }, ctx.cwd);
			if (!blocked) return undefined;
			pi.appendEntry(GRAPH_BLOCKED, { tool: event.toolName, rule: blocked.rule, node: limits.node });
			say(ctx, `blocked ${event.toolName} in "${limits.node}" (${blocked.rule})`, "warning");
			return { block: true, reason: blocked.reason };
		});

		// A move is entered when its turn ends, so a node never changes in the middle of a turn. A turn that was cut off
		// or failed is left alone: its move is entered before the next run.
		pi.on("agent_before_settle", async (event, ctx) => {
			const state = stateOf(ctx);
			if (state.status !== "running" || event.outcome !== "completed") return undefined;
			const drafts: SessionBoundaryDraft[] = [];
			const sink: Sink = {
				entry: (customType, data) => drafts.push({ type: "custom", customType, data }),
				message: (customType, content) =>
					drafts.push({ type: "custom_message", customType, display: true, content }),
			};
			if (state.pending) {
				const outcome = await proceed(ctx, sink, ctx.signal, false);
				if (outcome.kind === "end") say(ctx, `${outcome.graph} is finished`);
				else if (outcome.kind === "halt") haltNotice(ctx, outcome.reason, outcome.onCommand);
				else if (outcome.kind === "model") sink.message(GRAPH_ENTER, outcome.text);
				return { entries: [...event.entries, ...drafts], continue: outcome.kind === "model" };
			}
			// A turn that ended without a move. A node with an approval exit talks with the user, and so does a halted one.
			const node = state.graph.nodes[state.node];
			const talks = exits(state).some((choice) => choice.edge.exit === "approve");
			if (node.kind !== "model" || talks || state.halted !== undefined) return undefined;
			if (!state.reminded) {
				sink.message(
					GRAPH_REMINDER,
					`[graph ${state.graph.name}] You ended your turn in node "${state.node}" without leaving it. If its work is done, call tools.next({ to, report }) from codemode now. If you need the user, say what you need and end your turn.`,
				);
				return { entries: [...event.entries, ...drafts], continue: true };
			}
			const reason = `"${state.node}" ended its turn twice without a move`;
			sink.entry(GRAPH_HALT, { reason });
			haltNotice(ctx, reason, false);
			return { entries: [...event.entries, ...drafts], continue: false };
		});

		// One run can pass several nodes: the status follows at each request.
		pi.on("request_start", async (_event, ctx) => {
			if (isGraphModel(ctx.model)) sync(ctx, stateOf(ctx));
		});

		pi.on("agent_settled", async (_event, ctx) => {
			const state = stateOf(ctx);
			await restoreAfterEnd(ctx, state);
			sync(ctx, state);
		});

		// A move whose turn did not enter it (a cut-off turn, a quit, a crash) is entered before the next run starts.
		pi.on("before_agent_start", async (_event, ctx) => {
			const state = stateOf(ctx);
			if (state.status === "error") {
				say(ctx, `cannot read the graph's state (${state.message}). Run /graph stop.`, "error");
				return undefined;
			}
			if (state.status !== "running" || !state.pending) return undefined;
			const outcome = await proceed(ctx, direct, ctx.signal, false);
			if (outcome.kind === "end") {
				say(ctx, `${outcome.graph} is finished`);
				await restoreAfterEnd(ctx, stateOf(ctx));
			} else if (outcome.kind === "halt") haltNotice(ctx, outcome.reason, outcome.onCommand);
			sync(ctx, stateOf(ctx));
			return outcome.kind === "model"
				? { message: { customType: GRAPH_ENTER, content: outcome.text, display: true } }
				: undefined;
		});

		// A compaction can summarise the node's role away: say it again.
		pi.on("session_compact", async (_event, ctx) => {
			const state = stateOf(ctx);
			// With a move pending the node is about to change, and its own entry message follows. A command node has no role.
			if (state.status !== "running" || state.pending || state.graph.nodes[state.node].kind !== "model") return;
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
			sync(ctx, state);
		});

		pi.on("session_tree", async (_event, ctx) => {
			const state = stateOf(ctx);
			if (state.status === "running") registerTool();
			sync(ctx, state);
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
			commandRun?.abort();
			pi.appendEntry(GRAPH_END, { reason: "model_changed" });
			say(ctx, "ended: another model was selected", "warning");
			sync(ctx, { status: "none" });
		});

		async function start(name: string, ctx: ExtensionCommandContext): Promise<void> {
			if (stateOf(ctx).status !== "none") {
				say(ctx, "a graph already runs in this session: /graph stop ends it", "warning");
				return;
			}
			if (!pi.getActiveTools().includes(CODEMODE_TOOL)) {
				say(ctx, "a graph needs codemode: the model leaves a node with tools.next from a script", "warning");
				return;
			}
			const selected = ctx.model;
			if (!selected || isVirtualModel(selected)) {
				say(
					ctx,
					"select a physical model first: a graph falls back to the model selected when it starts",
					"warning",
				);
				return;
			}
			const files = discoverGraphs(ctx.cwd, ctx.isProjectTrusted());
			const file = files.find((candidate) => candidate.name === name);
			if (!file) {
				const known = files.map((candidate) => candidate.name).join(", ") || "none";
				say(ctx, `no graph "${name}" (found: ${known})`, "warning");
				return;
			}
			let literal: unknown;
			let definition: Graph;
			try {
				({ literal, graph: definition } = readGraphFile(file));
			} catch (error) {
				say(ctx, `${file.path}: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}
			for (const [id, node] of Object.entries(definition.nodes)) {
				if (node.kind !== "model") continue;
				if (node.model !== undefined) {
					const model = findModel(ctx, node.model);
					if (!model) {
						say(ctx, `${name}: nodes.${id}.model: no model ${node.model}`, "error");
						return;
					}
					if (isVirtualModel(model)) {
						say(ctx, `${name}: nodes.${id}.model: ${node.model} is a virtual model`, "error");
						return;
					}
				}
				if (node.thinking !== undefined && !THINKING_LEVELS.some((level) => level === node.thinking)) {
					say(ctx, `${name}: nodes.${id}.thinking: must be one of ${THINKING_LEVELS.join(", ")}`, "error");
					return;
				}
			}
			const router = ctx.modelRegistry.find(GRAPH_PROVIDER, GRAPH_MODEL);
			if (!router) {
				say(ctx, "the graph model is not registered", "error");
				return;
			}

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
				say(ctx, "could not select the graph model", "error");
				return;
			}
			say(ctx, `${name} started in "${definition.start}"`);
			await proceedNow(ctx);
		}

		async function stop(ctx: ExtensionContext): Promise<void> {
			const state = stateOf(ctx);
			if (state.status === "none") {
				say(ctx, "no graph is running", "warning");
				return;
			}
			commandRun?.abort();
			pi.appendEntry(GRAPH_END, { reason: "stopped" });
			if (state.selection && isGraphModel(ctx.model)) await restore(ctx, state.selection);
			sync(ctx, { status: "none" });
			say(ctx, "stopped");
		}

		/** The user's own jump: to any node, whatever the edges say. Recorded, and the loop counts start again. */
		async function goto(target: string, ctx: ExtensionCommandContext): Promise<void> {
			const state = stateOf(ctx);
			if (state.status !== "running") {
				say(
					ctx,
					state.status === "none" ? "no graph is running" : "the state cannot be read: run /graph stop",
					"warning",
				);
				return;
			}
			if (!Object.hasOwn(state.graph.nodes, target)) {
				say(ctx, `no node "${target}" (nodes: ${Object.keys(state.graph.nodes).join(", ")})`, "warning");
				return;
			}
			if (!ctx.isIdle() || commandRun) {
				say(ctx, "wait for the turn or the command that runs now, or stop it first", "warning");
				return;
			}
			const jump: NodeData = { node: target, via: "goto" };
			pi.appendEntry(GRAPH_NODE, jump);
			say(ctx, `"${state.node}" -> "${target}" (goto)`);
			await proceedNow(ctx);
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
						"usage: /graph start <name> | /graph goto <node> | /graph stop",
					].join("\n"),
				);
			}
		}

		pi.registerCommand("graph", {
			description: "Flow control by a graph: show the state, or [start <name> | goto <node> | stop]",
			handler: async (args, ctx) => {
				const [word, name, ...rest] = args.trim().split(/\s+/);
				if (word === "" || word === undefined) return status(ctx);
				if (word === "start" && name && rest.length === 0) return start(name, ctx);
				if (word === "goto" && name && rest.length === 0) return goto(name, ctx);
				if (word === "stop" && name === undefined) return stop(ctx);
				say(ctx, "usage: /graph [start <name> | goto <node> | stop]", "warning");
			},
		});
	};
}

export default createGraphExtension();
