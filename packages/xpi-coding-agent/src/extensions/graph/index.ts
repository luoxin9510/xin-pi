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
	type AskedData,
	type CommandDetails,
	checkGraph,
	commandCondition,
	type Edge,
	END,
	type EndReason,
	exits,
	formatDuration,
	formatReport,
	GRAPH_ASKED,
	GRAPH_BLOCKED,
	GRAPH_COMMAND,
	GRAPH_END,
	GRAPH_ENTER,
	GRAPH_HALT,
	GRAPH_MOVE,
	GRAPH_NODE,
	GRAPH_REMINDER,
	GRAPH_RUN,
	GRAPH_START,
	type Graph,
	type GraphEntry,
	type GraphReport,
	type GraphState,
	type HaltData,
	interruptions,
	type MoveData,
	mermaid,
	type NodeData,
	parseGraph,
	type ReportEntry,
	type RunData,
	type RunningState,
	readState,
	report,
	type Selection,
	type StartData,
} from "xpi-graph";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionBoundaryDraft,
} from "../../core/extensions/types.ts";
import type { SessionEntry } from "../../core/session-manager.ts";
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
const USAGE = "usage: /graph [--json] | /graph start <name> | /graph goto <node> | /graph stop";
/** How many lines of a running command's output the widget shows. */
const LIVE_LINES = 5;
const LIVE_LINE_WIDTH = 200;
/** A replay-safe command interrupted this many times in one visit is treated as unsafe. */
const MAX_INTERRUPTIONS = 3;

/**
 * The extension bus channel of each graph record (spec 02, section 7). Each event has `{ graph, node, visit, at }`
 * and the record's own fields; `graph:command` has the command's details, `graph:run` the command about to run.
 */
export const GRAPH_EVENTS = {
	[GRAPH_START]: "graph:start",
	[GRAPH_MOVE]: "graph:move",
	[GRAPH_NODE]: "graph:enter",
	[GRAPH_RUN]: "graph:run",
	[GRAPH_COMMAND]: "graph:command",
	[GRAPH_ASKED]: "graph:asked",
	[GRAPH_BLOCKED]: "graph:blocked",
	[GRAPH_HALT]: "graph:halt",
	[GRAPH_END]: "graph:end",
} as const;

type RecordType = keyof typeof GRAPH_EVENTS;

/** The graph record an entry is, if it is one: a custom entry of the graph, or a command node's message. */
function recordOf(entry: SessionEntry): { type: RecordType; data: Record<string, unknown> } | undefined {
	const fields = (value: unknown) =>
		typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
	if (entry.type === "custom" && Object.hasOwn(GRAPH_EVENTS, entry.customType) && entry.customType !== GRAPH_COMMAND) {
		return { type: entry.customType as RecordType, data: fields(entry.data) };
	}
	if (entry.type === "custom_message" && entry.customType === GRAPH_COMMAND) {
		return { type: GRAPH_COMMAND, data: fields(entry.details) };
	}
	return undefined;
}

/** A line of command output as the widget shows it: no colour codes, the last state of a `\r` progress line. */
function liveLine(line: string): string {
	const plain = line.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
	const last = plain.slice(plain.lastIndexOf("\r") + 1);
	return last.length > LIVE_LINE_WIDTH ? `${last.slice(0, LIVE_LINE_WIDTH - 1)}…` : last;
}

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
	| { kind: "wait" }
	/** A command node is entered and its command is not run here; `at` is the entry's time, which names the visit. */
	| { kind: "command"; at: string | undefined }
	/** The graph was ended while a command ran (`/graph stop`, another model selected): nothing more is done. */
	| { kind: "gone" };

/** Where the entries and messages of a step go: drafts of a boundary, or straight to the session. */
interface Sink {
	entry(customType: string, data: unknown): void;
	message(customType: string, content: string, details?: unknown): void;
}

/** `run` is the command runner; tests pass a fake. */
export function createGraphExtension(options: { run?: CheckRunner } = {}) {
	const run = options.run ?? runCheckCommand;
	/** The commands started after a turn that have not ended, for `busy` and `quiet`. */
	const tasks = new Set<Promise<void>>();
	const extension = function graph(pi: ExtensionAPI) {
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
		/**
		 * The command node whose command runs now: its abort handle, and the state the graph is in while it runs. At a
		 * turn's end that state is not on the branch yet (its entries are still drafts), so the limits read it here.
		 */
		let commandRun: { abort: AbortController; state: RunningState; startedAt: string } | undefined;

		const stateOf = (ctx: ExtensionContext): GraphState => {
			// Assignable without a cast: a core entry type the package cannot read fails to compile here.
			const branch: readonly GraphEntry[] = ctx.sessionManager.getBranch();
			return readState(branch);
		};

		/**
		 * The last graph record the bus was told of. In memory only: at `session_start` and `session_tree` it is set to
		 * the branch's latest record without telling, so history is never told again; when it is not on the branch any
		 * more, the same, and nothing is told that time.
		 */
		let told: { set: boolean; id?: string } = { set: false };
		/** Set at `session_shutdown`: the context is gone, so a command that returns after it writes nothing. */
		let closed = false;
		/**
		 * Set while a quit without a UI waits for a running command: its result and its move are written, and nothing
		 * after that (no turn, no next node).
		 */
		let stopping = false;
		/** The going-on this process started for a command node (spec 03, section 2), until it is done. */
		let commandTask: Promise<void> | undefined;
		/**
		 * The visit of a command node this process entered at the end of a turn, by its `graph.node`'s `at`: its command
		 * starts without a look at `replay`, because this process knows it has not run.
		 */
		let noted: string | undefined;

		const markLatest = (ctx: ExtensionContext) => {
			told = { set: true, id: ctx.sessionManager.getBranch().findLast((entry) => recordOf(entry))?.id };
		};

		/** Tell the bus of the graph records on the branch after the last one told, in their order. */
		const tell = (ctx: ExtensionContext) => {
			if (!told.set) return markLatest(ctx);
			const branch = ctx.sessionManager.getBranch();
			let from = 0;
			if (told.id !== undefined) {
				const at = branch.findIndex((entry) => entry.id === told.id);
				if (at < 0) return markLatest(ctx);
				from = at + 1;
			}
			let graph = "";
			let edges: { to?: unknown }[] = [];
			let node = "";
			let visit = 0;
			/** The visits of this run so far: a command's message may land after its visit, so it is matched to one. */
			let visits: { node: string; visit: number; at: string }[] = [];
			for (const [index, entry] of branch.entries()) {
				const record = recordOf(entry);
				if (!record) continue;
				if (record.type === GRAPH_START) {
					const literal = record.data.graph as { name?: unknown; edges?: unknown } | undefined;
					graph = typeof literal?.name === "string" ? literal.name : "";
					edges = Array.isArray(literal?.edges) ? (literal.edges as { to?: unknown }[]) : [];
					node = "";
					visit = 0;
					visits = [];
				} else if (record.type === GRAPH_NODE && typeof record.data.node === "string") {
					node = record.data.node;
					visit += 1;
					visits.push({ node, visit, at: String(record.data.at ?? entry.timestamp) });
				}
				if (index < from) continue;
				told = { set: true, id: entry.id };
				const at = record.data.at ?? record.data.startedAt ?? entry.timestamp;
				const { graph: _literal, ...fields } = record.data;
				let where = { node, visit };
				if (record.type === GRAPH_COMMAND && typeof fields.node === "string") {
					// By node and start time, as the report does: a message queued behind a turn lands after its visit.
					const started = Date.parse(String(fields.startedAt));
					const own =
						visits.findLast(
							(candidate) => candidate.node === fields.node && Date.parse(candidate.at) <= started,
						) ?? visits.findLast((candidate) => candidate.node === fields.node);
					if (own) where = { node: own.node, visit: own.visit };
				}
				const extra =
					record.type === GRAPH_MOVE &&
					typeof fields.edge === "number" &&
					typeof edges[fields.edge]?.to === "string"
						? { to: edges[fields.edge].to }
						: {};
				try {
					// A record's own `node` (a block names the node whose limits held) wins, except for a command's message,
					// whose visit is the one matched above.
					const matched = record.type === GRAPH_COMMAND ? where : {};
					pi.events.emit(GRAPH_EVENTS[record.type], { graph, ...where, at, ...fields, ...matched, ...extra });
				} catch {
					// a listener's error is not the graph's
				}
			}
		};

		/**
		 * The live view of a command node that runs: the elapsed time in the footer each second, and the command with the
		 * last lines of its output in a widget. Nothing without a UI. `stop` removes the widget; the caller sets the
		 * footer back.
		 */
		const liveView = (
			ctx: ExtensionContext,
			graphName: string,
			nodeName: string,
			command: string,
			signal: AbortSignal,
		) => {
			if (!ctx.hasUI) return undefined;
			const started = Date.now();
			let lines: string[] = [];
			let partial = "";
			let pending: ReturnType<typeof setTimeout> | undefined;
			let stopped = false;
			// The timers outlive nothing: a context that is gone (the session was replaced) throws, and that ends the view.
			const guarded = (draw: () => void) => () => {
				if (stopped) return;
				try {
					draw();
				} catch {
					view.stop();
				}
			};
			const status = guarded(() => {
				// A stopped command may take a while to die: its time is not shown over the status that follows.
				if (signal.aborted) return;
				ctx.ui.setStatus("graph", `graph ${graphName}: ${nodeName} ${formatDuration(Date.now() - started)}`);
			});
			const widget = guarded(() => {
				pending = undefined;
				const shown = [...lines, ...(partial === "" ? [] : [partial])].slice(-LIVE_LINES).map(liveLine);
				ctx.ui.setWidget("graph", [`$ ${liveLine(command)}`, ...shown]);
			});
			const timer = setInterval(status, 1000);
			timer.unref?.();
			const view = {
				output: (text: string) => {
					if (stopped) return;
					const parts = (partial + text).split("\n");
					partial = parts.pop() ?? "";
					lines = [...lines, ...parts].slice(-LIVE_LINES);
					pending ??= setTimeout(widget, 200);
				},
				stop: () => {
					if (stopped) return;
					stopped = true;
					clearInterval(timer);
					if (pending !== undefined) clearTimeout(pending);
					try {
						ctx.ui.setWidget("graph", undefined);
					} catch {
						// the session is gone, and its widgets with it
					}
				},
			};
			status();
			widget();
			return view;
		};

		const say = (ctx: ExtensionContext, text: string, level: "info" | "warning" | "error" = "info") => {
			if (ctx.hasUI) ctx.ui.notify(`graph: ${text}`, level);
			else if (level === "info") console.log(`graph: ${text}`);
			else console.error(`graph: ${text}`);
		};

		/** Every graph entry carries the time it was made: a draft is committed later, with others (spec 02, section 1). */
		const stamp = <T extends object>(data: T): T & { at: string } => ({ ...data, at: new Date().toISOString() });
		const append = (ctx: ExtensionContext, customType: string, data: object) => {
			pi.appendEntry(customType, stamp(data));
			tell(ctx);
		};
		/** `duringRun`: whether the usage after the end may still be the graph's (the rest of the run that ended it). */
		const endData = (ctx: ExtensionContext, reason: EndReason) => ({ reason, duringRun: !ctx.isIdle() });

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

		/** Straight to the session, and the bus is told of what is on the branch. */
		const directFor = (ctx: ExtensionContext): Sink => ({
			entry: (customType, data) => {
				pi.appendEntry(customType, data);
				tell(ctx);
			},
			message: (customType, content, details) => {
				pi.sendMessage(
					{ customType, content, display: true, ...(details === undefined ? {} : { details }) },
					{ triggerTurn: false },
				);
				tell(ctx);
			},
		});

		/**
		 * Go on from where the branch is: enter a pending move, run command nodes, and stop at a model node, the end, or
		 * a halt. The entries are written through `sink` and folded here as they are written, because the drafts of a
		 * boundary are not on the branch yet. `mayWait`: outside a turn, a command's result is left as a pending move
		 * when a turn has started meanwhile, so a node never changes in the middle of a turn. `runCommands`: false at the
		 * end of a turn, where every entry is a draft; a command node is then entered and its command started after the
		 * turn settled, so its `graph.run` is on disk before it runs (spec 03).
		 *
		 * A command runs under this function's own abort handle. Neither a command handler nor the end of a turn has an
		 * abort signal of the core (the run is over by then), so `/graph stop` and a change of model abort it here.
		 */
		async function proceed(
			ctx: ExtensionContext,
			sink: Sink,
			mayWait: boolean,
			runCommands = true,
		): Promise<Outcome> {
			const branch: readonly GraphEntry[] = ctx.sessionManager.getBranch();
			const local: GraphEntry[] = [...branch];
			/** Which graph this is: the entry that started it. A graph started after a stop is another one. */
			const startOf = () =>
				ctx.sessionManager
					.getBranch()
					.findLast((entry) => entry.type === "custom" && entry.customType === GRAPH_START)?.id;
			const mine = startOf();
			const write = (customType: string, data: object) => {
				const stamped = stamp(data);
				local.push({ type: "custom", customType, data: stamped });
				sink.entry(customType, stamped);
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
						// A pending move is entered after its turn (at the turn's end, before the next run, or outside a
						// turn): whatever run is going on now is not the graph's, even when one is.
						write(GRAPH_END, { reason: "done", duringRun: false });
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
				if (!runCommands) return { kind: "command", at: state.enteredAt };

				say(ctx, `running "${state.node}": ${node.run}`);
				sync(ctx, state, state.node);
				const startedAt = new Date();
				const runStartedAt = startedAt.toISOString();
				// The intent is on disk before the command runs: after a crash, a run with no result was interrupted.
				pi.persistSession();
				const intent: RunData = { node: state.node, run: node.run, replay: node.replay, startedAt: runStartedAt };
				write(GRAPH_RUN, intent);
				const abort = new AbortController();
				commandRun = { abort, state, startedAt: runStartedAt };
				let result: RunResult;
				const live = liveView(ctx, definition.name, state.node, node.run, abort.signal);
				try {
					result = await run(node.run, {
						cwd: ctx.cwd,
						timeoutMs: node.timeoutMs,
						signal: abort.signal,
						...(live ? { onOutput: live.output } : {}),
					});
				} finally {
					live?.stop();
					// Only its own handle: a graph started meanwhile may be running a command of its own.
					if (commandRun?.abort === abort) commandRun = undefined;
				}
				// The command took time. If the graph was ended meanwhile, on the branch itself (and maybe another started),
				// nothing more is written or run: the local copy cannot see that.
				if (closed || stateOf(ctx).status !== "running" || startOf() !== mine) return { kind: "gone" };
				// The process is going away and a signal it did not send killed the command (a closed terminal, SIGTERM):
				// that is an interruption, not a failure. Nothing is written, so the run stays without a result.
				if (stopping && result.code === null && !result.timedOut && !result.aborted) return { kind: "gone" };
				if (result.aborted) {
					const reason = `"${state.node}" was stopped while its command ran`;
					const halt: HaltData = { reason, runStartedAt };
					write(GRAPH_HALT, halt);
					return { kind: "halt", reason, onCommand: true };
				}
				const via = result.code === 0 && !result.timedOut ? "pass" : "fail";
				const output = result.output.replace(/\n+$/, "");
				const details: CommandDetails = {
					node: state.node,
					run: node.run,
					code: result.code,
					timedOut: result.timedOut,
					startedAt: runStartedAt,
					durationMs: Date.now() - startedAt.getTime(),
					lines: output === "" ? 0 : output.split("\n").length,
					outcome: via,
				};
				sink.message(GRAPH_COMMAND, commandText(definition.name, state.node, node.run, result), details);
				const word = via === "pass" ? "passed" : result.timedOut ? "timed out" : "failed";
				const choice = exits(state).find((candidate) => candidate.edge.exit === via);
				const reason = !choice
					? `"${state.node}" ${word} and has no ${via} edge`
					: choice.open
						? undefined
						: `"${state.node}" ${word} and "${state.node}" -> "${choice.edge.to}" was taken ${choice.count} times, its limit`;
				if (!choice || reason !== undefined) {
					const halt: HaltData = { reason: reason ?? "", runStartedAt };
					write(GRAPH_HALT, halt);
					return { kind: "halt", reason: reason ?? "", onCommand: true };
				}
				const move: MoveData = {
					edge: choice.index,
					via,
					report: `Command node "${state.node}" ${word}.`,
					runStartedAt,
				};
				write(GRAPH_MOVE, move);
				// A quit without a UI waits for this one run: its move is entered at the next run.
				if (stopping) return { kind: "wait" };
				if (mayWait && !ctx.isIdle()) return { kind: "wait" };
			}
		}

		/**
		 * Go on outside a turn (`/graph start`, `/graph goto`, a command started after a turn): the entries go straight
		 * to the session, and a model node that is reached starts a turn.
		 */
		async function goOn(ctx: ExtensionContext): Promise<void> {
			const outcome = await proceed(ctx, directFor(ctx), true);
			const state = stateOf(ctx);
			if (outcome.kind === "gone") {
				// The command's footer may have been drawn after the stop: show the state as it is.
				if (!closed) sync(ctx, stateOf(ctx));
				return;
			}
			if (outcome.kind === "end") {
				say(ctx, `${outcome.graph} is finished`);
				await restoreAfterEnd(ctx, state);
			} else if (outcome.kind === "halt") haltNotice(ctx, outcome.reason, outcome.onCommand);
			sync(ctx, stateOf(ctx));
			if (outcome.kind !== "model" || stopping || closed) return;
			pi.sendMessage({ customType: GRAPH_ENTER, content: outcome.text, display: true }, { triggerTurn: true });
		}

		/**
		 * Without a UI (print mode) the process ends when the command handler returns: wait until the session is idle and
		 * no command this process started is pending. A command's end can start a turn, and a turn's end a command.
		 * This relies on the core awaiting the `agent_settled` handlers before `waitForIdle` resolves, so a command that
		 * a turn's end starts is in `commandTask` by the time the loop looks.
		 */
		async function settle(ctx: ExtensionCommandContext): Promise<void> {
			for (;;) {
				await ctx.waitForIdle();
				const task = commandTask;
				if (task) {
					await task;
					continue;
				}
				if (ctx.isIdle()) return;
				// A host whose wait returns at once: let the turn go on before looking again.
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
		}

		/**
		 * Start the current command node's command and go on from its result, not awaited by the caller (spec 03,
		 * section 2): the session stays idle while it runs. Nothing when a command of this process is going on already.
		 */
		const startCommand = (ctx: ExtensionContext) => {
			if (commandTask !== undefined || commandRun !== undefined || closed) return;
			noted = undefined;
			const task = goOn(ctx)
				.catch((error: unknown) => {
					say(
						ctx,
						`the command failed to run: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
				})
				.finally(() => {
					if (commandTask === task) commandTask = undefined;
					tasks.delete(task);
				});
			commandTask = task;
			tasks.add(task);
		};

		/**
		 * What may happen to the current visit of a command node whose command is not running in this process: start it,
		 * halt because it may have run and may not run twice, or nothing (it finished, it is halted, it runs).
		 */
		const decide = (state: RunningState): "start" | "halt" | "none" => {
			const node = state.graph.nodes[state.node];
			if (node.kind !== "command" || commandTask !== undefined || commandRun !== undefined) return "none";
			const condition = commandCondition(state);
			if (condition !== "not_started" && condition !== "interrupted") return "none";
			// This process entered the visit and knows its command has not run.
			if (condition === "not_started" && state.enteredAt !== undefined && state.enteredAt === noted) return "start";
			return node.replay === "safe" && interruptions(state) < MAX_INTERRUPTIONS ? "start" : "halt";
		};

		/** The halt of a visit whose command may have run and may not run again. */
		const interruptedHalt = (state: RunningState): HaltData => {
			const last = state.runs.at(-1);
			// A safe command halts only at the limit of interruptions; an unsafe one at once.
			const reason =
				interruptions(state) >= MAX_INTERRUPTIONS
					? `"${state.node}" was interrupted ${interruptions(state)} times while its command ran`
					: `"${state.node}" may have run its command (${last ? "it was interrupted" : "it has no record of starting"}), and it is not replay-safe`;
			return last && !last.finished ? { reason, interrupted: last.startedAt } : { reason };
		};

		/**
		 * Whether a nested call was made by a script of the latest assistant message on the branch, and that message
		 * belongs to the current visit of the node (it comes after the entry that entered the node). A nested call's id
		 * is `<the script's tool call id>/<n>`.
		 */
		const calledByLatestRequest = (ctx: ExtensionContext, toolCallId: string): boolean => {
			const parent = toolCallId.slice(0, toolCallId.lastIndexOf("/"));
			const branch = ctx.sessionManager.getBranch();
			const at = branch.findLastIndex((entry) => entry.type === "message" && entry.message.role === "assistant");
			const entered = branch.findLastIndex((entry) => entry.type === "custom" && entry.customType === GRAPH_NODE);
			const latest = branch[at];
			if (at < entered || latest?.type !== "message" || latest.message.role !== "assistant") return false;
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
						append(ctx, GRAPH_HALT, { reason });
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
						const askedAt = new Date().toISOString();
						const answer = await ctx.ui.select(
							`Graph ${state.graph.name}: let "${state.node}" go on to "${choice.edge.to}"?`,
							[APPROVE, SEND_BACK, STOP],
						);
						// The answer is recorded before the move or the end it causes, whatever it is. (A graph stopped while
						// the question was open has its end first; the record then lands after it and only stays as data.)
						const asked: Omit<AskedData, "at"> = {
							node: state.node,
							to: choice.edge.to,
							answer:
								answer === APPROVE
									? "approve"
									: answer === SEND_BACK
										? "send_back"
										: answer === STOP
											? "stop"
											: "dismissed",
							askedAt,
						};
						append(ctx, GRAPH_ASKED, asked);
						if (answer === STOP) {
							append(ctx, GRAPH_END, endData(ctx, "stopped"));
							say(ctx, "stopped");
							return stay("The user stopped the graph. End your turn.");
						}
						// Dismissing the question is not an approval.
						if (answer !== APPROVE) {
							return stay("The user sent this back and will say why. End your turn and wait for the comment.");
						}
						// The question took time: only the state as it is now counts.
						const now = stateOf(ctx);
						if (
							now.status !== "running" ||
							now.visited.length !== state.visited.length ||
							now.node !== state.node ||
							now.pending ||
							now.halted !== undefined
						) {
							throw new Error("The graph moved on while the user was asked. End your turn.");
						}
					}
					const move: MoveData = {
						edge: choice.index,
						via: choice.edge.exit === "approve" ? "approve" : "model",
						report: params.report,
					};
					append(ctx, GRAPH_MOVE, move);
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
			const limits = limitsNow(ctx, commandRun?.state ?? stateOf(ctx));
			if (!limits) return undefined;
			const blocked = blockedBy(limits, { ...event, input: event.input as Record<string, unknown> }, ctx.cwd);
			if (!blocked) return undefined;
			append(ctx, GRAPH_BLOCKED, { tool: event.toolName, rule: blocked.rule, node: limits.node });
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
				message: (customType, content, details) =>
					drafts.push({
						type: "custom_message",
						customType,
						display: true,
						content,
						...(details === undefined ? {} : { details }),
					}),
			};
			if (state.pending) {
				const outcome = await proceed(ctx, sink, false, false);
				if (outcome.kind === "gone") return undefined;
				if (outcome.kind === "end") say(ctx, `${outcome.graph} is finished`);
				else if (outcome.kind === "halt") haltNotice(ctx, outcome.reason, outcome.onCommand);
				else if (outcome.kind === "model") sink.message(GRAPH_ENTER, outcome.text);
				// A command node: its entry is a draft now, and its command starts once the turn has settled.
				else if (outcome.kind === "command") noted = outcome.at;
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
			sink.entry(GRAPH_HALT, stamp({ reason }));
			haltNotice(ctx, reason, false);
			return { entries: [...event.entries, ...drafts], continue: false };
		});

		// One run can pass several nodes: the status follows at each request.
		pi.on("request_start", async (_event, ctx) => {
			if (isGraphModel(ctx.model)) sync(ctx, stateOf(ctx));
		});

		pi.on("agent_settled", async (event, ctx) => {
			// The drafts of the turn end are on the branch now.
			tell(ctx);
			const state = stateOf(ctx);
			await restoreAfterEnd(ctx, state);
			sync(ctx, state);
			// The command node this turn's end entered: its command starts now. After an Esc it waits for the next action.
			if (event.aborted || state.status !== "running" || noted === undefined || state.enteredAt !== noted) return;
			if (decide(state) === "start") startCommand(ctx);
		});

		// A move whose turn did not enter it (a cut-off turn, a quit, a crash) is entered before the next run starts.
		pi.on("before_agent_start", async (_event, ctx) => {
			const state = stateOf(ctx);
			if (state.status === "error") {
				say(ctx, `cannot read the graph's state (${state.message}). Run /graph stop.`, "error");
				return undefined;
			}
			if (state.status !== "running") return undefined;
			if (!state.pending) {
				// A command node whose command is not running here: it starts (not awaited, so this message is answered at
				// once by the model selected before the graph), or the graph halts because it may have run (R8, R12).
				const choice = decide(state);
				if (choice === "start") startCommand(ctx);
				else if (choice === "halt") {
					const halt = interruptedHalt(state);
					append(ctx, GRAPH_HALT, halt);
					haltNotice(ctx, halt.reason, true);
					sync(ctx, stateOf(ctx));
				}
				return undefined;
			}
			const outcome = await proceed(ctx, directFor(ctx), false, false);
			if (outcome.kind === "end") {
				say(ctx, `${outcome.graph} is finished`);
				await restoreAfterEnd(ctx, stateOf(ctx));
			} else if (outcome.kind === "halt") haltNotice(ctx, outcome.reason, outcome.onCommand);
			sync(ctx, stateOf(ctx));
			if (outcome.kind === "command") {
				noted = outcome.at;
				startCommand(ctx);
			}
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
			markLatest(ctx);
			const state = stateOf(ctx);
			if (state.status === "running") registerTool();
			await restoreAfterEnd(ctx, state);
			sync(ctx, state);
			// A command the last process did not live through: told only, since this process may only be looking (R8).
			if (state.status === "running") {
				const node = state.graph.nodes[state.node];
				const condition = commandCondition(state);
				const choice = decide(state);
				if (node.kind === "command" && choice !== "none") {
					const name = state.graph.name;
					const goOnText = `(any message, or /graph goto ${state.node})`;
					say(
						ctx,
						choice === "start"
							? condition === "interrupted"
								? `${name}: "${state.node}" was interrupted while its command ran; it runs again when you go on ${goOnText}`
								: `${name}: "${state.node}" was entered and its command has no record of starting; it runs when you go on ${goOnText}`
							: `${name}: "${state.node}" may have run its command (${interruptions(state) >= MAX_INTERRUPTIONS ? `interrupted ${interruptions(state)} times` : condition === "interrupted" ? "it was interrupted" : "it has no record"}). Check, then /graph goto ${state.node} to run it again, /graph goto <node> to go on, or /graph stop`,
						"warning",
					);
				}
			}
		});

		// The session is replaced or the process ends: a command that runs is stopped, and nothing is written after it.
		pi.on("session_shutdown", async (event, ctx) => {
			// A quit without a UI (`xpi -p`) waits for a command this process started, so the process does not kill it; its
			// result and move are written, and nothing after them. A quit with a UI, and a session replaced, stop it.
			const task = commandTask;
			if (event.reason === "quit" && !ctx.hasUI && task !== undefined && !closed) {
				stopping = true;
				await task;
			}
			closed = true;
			commandRun?.abort.abort();
		});

		pi.on("session_tree", async (_event, ctx) => {
			markLatest(ctx);
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
			commandRun?.abort.abort();
			append(ctx, GRAPH_END, endData(ctx, "model_changed"));
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
			append(ctx, GRAPH_START, begin);
			append(ctx, GRAPH_NODE, first);
			registerTool();
			selecting = true;
			let selectedRouter: boolean;
			try {
				selectedRouter = await pi.setModel(router);
			} finally {
				selecting = false;
			}
			if (!selectedRouter) {
				append(ctx, GRAPH_END, endData(ctx, "stopped"));
				say(ctx, "could not select the graph model", "error");
				return;
			}
			say(ctx, `${name} started in "${definition.start}"`);
			await goOn(ctx);
			if (!ctx.hasUI) await settle(ctx);
		}

		async function stop(ctx: ExtensionContext): Promise<void> {
			const state = stateOf(ctx);
			if (state.status === "none") {
				say(ctx, "no graph is running", "warning");
				return;
			}
			commandRun?.abort.abort();
			append(ctx, GRAPH_END, endData(ctx, "stopped"));
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
			if (!ctx.isIdle() || commandRun !== undefined || commandTask !== undefined) {
				say(ctx, "wait for the turn or the command that runs now, or stop it first", "warning");
				return;
			}
			// A command that may have run and may not run twice: the record says so before the user's own jump.
			if (decide(state) === "halt") append(ctx, GRAPH_HALT, interruptedHalt(state));
			const jump: NodeData = { node: target, via: "goto" };
			append(ctx, GRAPH_NODE, jump);
			say(ctx, `"${state.node}" -> "${target}" (goto)`);
			await goOn(ctx);
			if (!ctx.hasUI) await settle(ctx);
		}

		/** The report of the branch's last run (spec 02). */
		const reportOf = (ctx: ExtensionContext): GraphReport | undefined => {
			const branch: readonly ReportEntry[] = ctx.sessionManager.getBranch();
			return report(branch, Date.now(), {
				// The command that runs now has no result yet, and is not an interrupted one.
				...(commandRun ? { running: commandRun.startedAt } : {}),
				isVirtual: (key) => {
					const slash = key.indexOf("/");
					const model =
						slash === -1 ? undefined : ctx.modelRegistry.find(key.slice(0, slash), key.slice(slash + 1));
					return model ? isVirtualModel(model) : key === `${GRAPH_PROVIDER}/${GRAPH_MODEL}`;
				},
			});
		};

		/** Text for a program: no prefix, nothing else around it. */
		const raw = (ctx: ExtensionContext, text: string) => {
			if (ctx.hasUI) ctx.ui.notify(text, "info");
			else console.log(text);
		};

		/** The graph of the last run, for its Mermaid text. */
		const graphOfRun = (ctx: ExtensionContext): Graph | undefined => {
			const begin = ctx.sessionManager
				.getBranch()
				.findLast((entry) => entry.type === "custom" && entry.customType === GRAPH_START);
			if (begin?.type !== "custom") return undefined;
			const data = begin.data as Partial<StartData> | undefined;
			try {
				return checkGraph(parseGraph(data?.graph));
			} catch {
				return undefined;
			}
		};

		function status(ctx: ExtensionContext, json: boolean): void {
			const state = stateOf(ctx);
			const run = reportOf(ctx);
			if (json) {
				raw(ctx, JSON.stringify(run ?? { schemaVersion: 1, status: "none" }));
				return;
			}
			if (run) {
				const loops =
					state.status === "running"
						? exits(state)
								.filter((choice) => choice.edge.max !== undefined)
								.map((choice) => `  "${state.node}" -> "${choice.edge.to}": ${choice.count}/${choice.edge.max}`)
						: [];
				const definition = graphOfRun(ctx);
				say(
					ctx,
					[
						formatReport(run),
						...(loops.length > 0 ? ["limits of the edges out:", ...loops] : []),
						...(state.status === "error" ? ["Run /graph stop."] : []),
						...(definition ? ["", mermaid(definition, run)] : []),
						"",
						USAGE,
					].join("\n"),
					state.status === "error" ? "error" : "info",
				);
			} else if (state.status === "error") {
				say(ctx, `cannot read the state: ${state.message}\nRun /graph stop.`, "error");
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
						USAGE,
					].join("\n"),
				);
			}
		}

		pi.registerCommand("graph", {
			description:
				"Flow control by a graph: the report of the last run [--json], or [start <name> | goto <node> | stop]",
			handler: async (args, ctx) => {
				const [word, name, ...rest] = args.trim().split(/\s+/);
				if (word === "" || word === undefined) return status(ctx, false);
				if (word === "--json" && name === undefined) return status(ctx, true);
				if (word === "start" && name && rest.length === 0) return start(name, ctx);
				if (word === "goto" && name && rest.length === 0) return goto(name, ctx);
				if (word === "stop" && name === undefined) return stop(ctx);
				say(ctx, USAGE, "warning");
			},
		});
	};
	return Object.assign(extension, {
		/** Whether a command started after a turn is still going on (tests: it is not part of the agent's run). */
		busy: () => tasks.size > 0,
		/** Wait until no command started after a turn is going on. */
		quiet: async () => {
			while (tasks.size > 0) await Promise.all(tasks);
		},
	});
}

export default createGraphExtension();
