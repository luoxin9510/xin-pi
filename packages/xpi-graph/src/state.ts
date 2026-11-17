// The state of a graph is the session branch: entries the host wrote, folded here. Nothing else is stored, so resuming a
// session or moving to another branch of it moves the graph too. The package reads entries and never writes them.

import { checkGraph } from "./check.ts";
import { parseGraph } from "./parse.ts";
import type { Edge, Graph } from "./types.ts";

/** The custom entry types of a graph. None of them is sent to the model. */
export const GRAPH_START = "graph.start";
export const GRAPH_NODE = "graph.node";
export const GRAPH_MOVE = "graph.move";
export const GRAPH_HALT = "graph.halt";
export const GRAPH_BLOCKED = "graph.blocked";
export const GRAPH_END = "graph.end";

/** The custom messages of a graph, which the model does see. */
export const GRAPH_ENTER = "graph.enter";
export const GRAPH_COMMAND = "graph.command";
export const GRAPH_REMINDER = "graph.reminder";

/** A model selection: the virtual or physical model and the thinking level. */
export interface Selection {
	provider: string;
	id: string;
	thinking: string;
}

/** `graph.start`: the whole graph as its file's literal, and the selection to restore at the end. */
export interface StartData {
	graph: unknown;
	path: string;
	selection: Selection;
}

export type MoveVia = "model" | "approve" | "pass" | "fail";
export type NodeVia = "start" | "goto" | MoveVia;

/** `graph.node`: a node was entered. `edge` is the index of the edge taken; absent for `start` and `goto`. */
export interface NodeData {
	node: string;
	via: NodeVia;
	edge?: number;
	report?: string;
}

/** `graph.move`: a move that is accepted and not entered yet. */
export interface MoveData {
	edge: number;
	via: MoveVia;
	report?: string;
}

/** `graph.halt`: the graph stopped and waits for the user. */
export interface HaltData {
	reason: string;
}

export type EndReason = "done" | "stopped" | "model_changed";

/** `graph.end`: the graph is over. */
export interface EndData {
	reason: EndReason;
}

/**
 * What the package reads of a session entry. The host's own entry type must be assignable to it: custom entries carry
 * `customType` and `data`, custom messages `customType`, messages a `message` with its role.
 */
export interface GraphEntry {
	type: string;
	customType?: string;
	data?: unknown;
	message?: { role: string };
}

export interface RunningState {
	status: "running";
	graph: Graph;
	/** Where the graph file was when the graph started. */
	path: string;
	/** The selection before the graph, restored when it ends. */
	selection: Selection;
	/** The current node. */
	node: string;
	/** The nodes entered on this branch, oldest first, the current one last. */
	visited: string[];
	/** How many times each edge was taken since the start or the last goto, by edge index. */
	counts: number[];
	/** The index of the edge that entered the current node; absent after a start or a goto. */
	lastEdge?: number;
	/** A move that is accepted and not entered yet. */
	pending?: MoveData;
	/** The reason of the halt the graph is in. */
	halted?: string;
	/** A reminder was sent in this visit of the node, or since the last halt was left. */
	reminded: boolean;
}

export type GraphState =
	/** No graph runs on this branch. `ended` is the last graph that did. */
	| { status: "none"; ended?: { selection: Selection; reason: EndReason } }
	/** The entries cannot be read as a graph. The host halts and tells the user; it never guesses. */
	| { status: "error"; message: string; selection?: Selection }
	| RunningState;

type Fields = Record<string, unknown>;

function isFields(value: unknown): value is Fields {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readSelection(value: unknown): Selection | undefined {
	if (!isFields(value)) return undefined;
	const { provider, id, thinking } = value;
	if (typeof provider !== "string" || typeof id !== "string" || typeof thinking !== "string") return undefined;
	return { provider, id, thinking };
}

function readIndex(value: unknown, edges: readonly Edge[]): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < edges.length
		? value
		: undefined;
}

const MOVE_VIAS: readonly MoveVia[] = ["model", "approve", "pass", "fail"];
const END_REASONS: readonly EndReason[] = ["done", "stopped", "model_changed"];

/** Apply one graph entry to a running state. Returns the next state, or a message when the entry cannot be read. */
function step(state: RunningState, type: string, data: unknown): RunningState | string {
	// Other extensions write custom entries too, and `graph.blocked` is a record that changes nothing.
	if (type !== GRAPH_NODE && type !== GRAPH_MOVE && type !== GRAPH_HALT) return state;
	if (!isFields(data)) return `${type}: no data`;
	const { graph } = state;
	const report = typeof data.report === "string" ? { report: data.report } : {};
	if (type === GRAPH_NODE) {
		const { node, via } = data;
		if (typeof node !== "string" || !Object.hasOwn(graph.nodes, node)) return `${type}: no node "${String(node)}"`;
		const entered = {
			node,
			visited: [...state.visited, node],
			lastEdge: undefined,
			pending: undefined,
			halted: undefined,
			reminded: false,
		};
		// The first entry of a run is the start node, and only the first is.
		if (state.node === "" || via === "start") {
			if (state.node !== "") return `${type}: a second start entry`;
			if (via !== "start" || node !== graph.start) return `${type}: the first entry must be the start node`;
			return { ...state, ...entered };
		}
		if (via === "goto") return { ...state, ...entered, counts: graph.edges.map(() => 0) };
		const edge = readIndex(data.edge, graph.edges);
		if (edge === undefined || !MOVE_VIAS.some((kind) => kind === via)) return `${type}: no such edge or via`;
		if (graph.edges[edge].from !== state.node || graph.edges[edge].to !== node) {
			return `${type}: edge ${edge} does not go from "${state.node}" to "${node}"`;
		}
		if (graph.edges[edge].exit !== via) return `${type}: edge ${edge} is not taken by ${String(via)}`;
		if (state.pending !== undefined && state.pending.edge !== edge) {
			return `${type}: edge ${edge} is not the pending move (edge ${state.pending.edge})`;
		}
		return {
			...state,
			...entered,
			lastEdge: edge,
			counts: state.counts.map((count, index) => (index === edge ? count + 1 : count)),
		};
	}
	if (type === GRAPH_MOVE) {
		const edge = readIndex(data.edge, graph.edges);
		const via = MOVE_VIAS.find((kind) => kind === data.via);
		if (edge === undefined || via === undefined) return `${type}: no such edge or via`;
		if (graph.edges[edge].from !== state.node) return `${type}: edge ${edge} does not leave "${state.node}"`;
		if (graph.edges[edge].exit !== via) return `${type}: edge ${edge} is not taken by ${via}`;
		if (state.pending !== undefined) return `${type}: a move is already pending (edge ${state.pending.edge})`;
		return { ...state, pending: { edge, via, ...report } };
	}
	return typeof data.reason === "string" ? { ...state, halted: data.reason } : `${type}: no reason`;
}

/**
 * The state of the branch: the entries from the last `graph.start` on. A graph that ended leaves `none`; entries that
 * cannot be read leave `error`.
 */
export function readState(entries: readonly GraphEntry[]): GraphState {
	let state: GraphState = { status: "none" };
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === GRAPH_START) {
			const data = isFields(entry.data) ? entry.data : {};
			const selection = readSelection(data.selection);
			if (state.status === "running") {
				state = { status: "error", message: `${GRAPH_START}: a graph already runs`, selection: state.selection };
			} else if (selection === undefined || typeof data.path !== "string") {
				state = { status: "error", message: `${GRAPH_START}: no selection or path` };
			} else {
				try {
					const graph = checkGraph(parseGraph(data.graph));
					state = {
						status: "running",
						graph,
						path: data.path,
						selection,
						node: "",
						visited: [],
						counts: graph.edges.map(() => 0),
						reminded: false,
					};
				} catch (error) {
					state = { status: "error", message: error instanceof Error ? error.message : String(error), selection };
				}
			}
			continue;
		}
		if (state.status === "none") continue;
		if (entry.type === "custom" && entry.customType === GRAPH_END) {
			const data = isFields(entry.data) ? entry.data : {};
			const reason = END_REASONS.find((kind) => kind === data.reason);
			if (reason === undefined) {
				state = { status: "error", message: `${GRAPH_END}: no reason`, selection: state.selection };
			} else {
				state = state.selection
					? { status: "none", ended: { selection: state.selection, reason } }
					: { status: "none" };
			}
			continue;
		}
		if (state.status === "error") continue;
		if (entry.type === "custom" && entry.customType !== undefined) {
			const next = step(state, entry.customType, entry.data);
			state = typeof next === "string" ? { status: "error", message: next, selection: state.selection } : next;
		} else if (entry.type === "custom_message" && entry.customType === GRAPH_REMINDER) {
			state = { ...state, reminded: true };
		} else if (entry.type === "message" && entry.message?.role === "user") {
			// The user's message leaves a halt on a model node, and the idle count of the visit starts again. A halt on a
			// command node is left only by a goto or a stop.
			if (state.halted !== undefined && state.node !== "" && state.graph.nodes[state.node].kind === "model") {
				state = { ...state, halted: undefined, reminded: false };
			}
		}
	}
	if (state.status === "running" && state.node === "") {
		return { status: "error", message: `${GRAPH_START}: no node was entered`, selection: state.selection };
	}
	return state;
}

/** An edge the current node may take, with how often it was taken. */
export interface ExitChoice {
	/** The index of the edge in `graph.edges`, as `graph.move` and `graph.node` record it. */
	index: number;
	edge: Edge;
	count: number;
	/** False when the edge is at its `max`. */
	open: boolean;
}

/** The edges out of the current node. */
export function exits(state: RunningState): ExitChoice[] {
	const choices: ExitChoice[] = [];
	state.graph.edges.forEach((edge, index) => {
		if (edge.from !== state.node) return;
		const count = state.counts[index];
		choices.push({ index, edge, count, open: edge.max === undefined || count < edge.max });
	});
	return choices;
}
