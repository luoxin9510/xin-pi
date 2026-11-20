// The graph as the package holds it, after `parseGraph` has read the file's literal. See README.md for the file format.

/** The reserved target of an edge that ends the graph. It is not a node. */
export const END = "end";

/** A stretch of work by a model: a role prompt, a model, and what the node may not do. */
export interface ModelNode {
	kind: "model";
	prompt: string;
	/** A `provider/model` reference; absent: the model selected when the graph started. */
	model?: string;
	/** Absent: the thinking level selected when the graph started. */
	thinking?: string;
	/** Command text the node may not run, matched by substring. */
	deny: string[];
	/** Gitignore patterns of paths the node may not write. */
	readOnly: string[];
}

/**
 * Whether a command may run again after it may have run, fully or in part: after a crash, a safe command runs again and
 * any other one stops the graph for the user.
 */
export type Replay = "safe" | "unsafe";

/** A command the engine runs; its exit code picks the edge. */
export interface CommandNode {
	kind: "command";
	run: string;
	timeoutMs: number;
	/** Absent in the file: `"unsafe"`. */
	replay: Replay;
}

export type GraphNode = ModelNode | CommandNode;

/** What lets an edge be taken: the model picks it, the user approves it, or a command passed or failed. */
export type Exit = "model" | "approve" | "pass" | "fail";

export interface Edge {
	from: string;
	/** A node id, or `end`. */
	to: string;
	exit: Exit;
	/** What the edge means, shown to the model. */
	label?: string;
	/** How many times the edge may be taken in one run. `checkGraph` sets it on every edge that is on a loop. */
	max?: number;
}

/** On every path to `before`, after the last entry into a node of `notAfter` there is a pass of `passed`. */
export interface Requirement {
	before: string;
	passed: string;
	notAfter: string[];
}

export interface Graph {
	name: string;
	start: string;
	nodes: Record<string, GraphNode>;
	edges: Edge[];
	requires: Requirement[];
}

export interface Problem {
	/** Where in the file, as a person would write it: `edges[3].to`. */
	at: string;
	message: string;
}

/** Every problem found in one graph, in one error. */
export class GraphError extends Error {
	readonly problems: readonly Problem[];

	constructor(graphName: string, problems: readonly Problem[]) {
		const lines = problems.map((problem) => `  ${problem.at}: ${problem.message}`);
		super(`graph ${graphName}: ${problems.length} problem${problems.length === 1 ? "" : "s"}\n${lines.join("\n")}`);
		this.name = "GraphError";
		this.problems = problems;
	}
}
