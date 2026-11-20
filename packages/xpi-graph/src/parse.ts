// `parseGraph`: the literal of a graph file, or the copy stored in a session, to a `Graph`. This is the trust boundary:
// the value comes from a file a person wrote or from a session file, so every field is checked here and nowhere else.

import {
	type CommandNode,
	type Edge,
	END,
	type Exit,
	type Graph,
	GraphError,
	type GraphNode,
	type ModelNode,
	type Problem,
	type Requirement,
} from "./types.ts";

export const GRAPH_NAME = /^[a-z0-9][a-z0-9-]*$/;
const NODE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const MODEL_REF = /^[^/\s]+\/\S+$/;
const TIMEOUT = /^([1-9][0-9]*)(s|m|h)$/;
const REPLAY = /^(safe|unsafe)$/;
const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000 };
const EXITS: readonly Exit[] = ["model", "approve", "pass", "fail"];

export const DEFAULT_TIMEOUT_MS = 600_000;

type Fields = Record<string, unknown>;

function isFields(value: unknown): value is Fields {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The checks of one object: each reads a key, reports what is wrong with it, and returns the value when it is right. */
class Reader {
	private readonly problems: Problem[];
	private readonly at: string;
	private readonly fields: Fields;

	constructor(problems: Problem[], at: string, fields: Fields, allowed: readonly string[]) {
		this.problems = problems;
		this.at = at;
		this.fields = fields;
		for (const key of Object.keys(fields)) {
			if (!allowed.includes(key)) this.report(key, `unknown key (known: ${allowed.join(", ")})`);
		}
	}

	report(key: string, message: string): void {
		this.problems.push({ at: this.at === "" ? key : `${this.at}.${key}`, message });
	}

	has(key: string): boolean {
		return this.fields[key] !== undefined;
	}

	/** A non-empty string. */
	text(key: string, required: boolean): string | undefined {
		const value = this.fields[key];
		if (value === undefined) {
			if (required) this.report(key, "is required");
			return undefined;
		}
		if (typeof value !== "string" || value.trim() === "") {
			this.report(key, "must be a non-empty string");
			return undefined;
		}
		return value;
	}

	/** A non-empty string that matches. */
	match(key: string, required: boolean, pattern: RegExp, form: string): string | undefined {
		const value = this.text(key, required);
		if (value === undefined) return undefined;
		if (!pattern.test(value)) {
			this.report(key, `must be ${form}`);
			return undefined;
		}
		return value;
	}

	/** A list of non-empty strings; absent is the empty list. */
	texts(key: string): string[] {
		const value = this.fields[key];
		if (value === undefined) return [];
		if (!Array.isArray(value)) {
			this.report(key, "must be a list of strings");
			return [];
		}
		const list: string[] = [];
		value.forEach((item: unknown, index) => {
			if (typeof item === "string" && item.trim() !== "") list.push(item);
			else this.report(`${key}[${index}]`, "must be a non-empty string");
		});
		return list;
	}
}

function parseNode(problems: Problem[], at: string, value: unknown): GraphNode | undefined {
	if (!isFields(value)) {
		problems.push({ at, message: "must be an object" });
		return undefined;
	}
	if (value.run !== undefined) {
		const reader = new Reader(problems, at, value, ["run", "timeout", "replay"]);
		const run = reader.text("run", true);
		const timeout = reader.match("timeout", false, TIMEOUT, 'a number and a unit, as in "30s", "10m" or "1h"');
		const replay = reader.match("replay", false, REPLAY, '"safe" or "unsafe"');
		if (run === undefined || (reader.has("timeout") && timeout === undefined)) return undefined;
		if (reader.has("replay") && replay === undefined) return undefined;
		const parts = timeout === undefined ? null : TIMEOUT.exec(timeout);
		const node: CommandNode = {
			kind: "command",
			run,
			timeoutMs: parts ? Number(parts[1]) * UNIT_MS[parts[2] as keyof typeof UNIT_MS] : DEFAULT_TIMEOUT_MS,
			replay: replay === "safe" ? "safe" : "unsafe",
		};
		return node;
	}
	const reader = new Reader(problems, at, value, ["prompt", "model", "thinking", "deny", "readOnly"]);
	const prompt = reader.text("prompt", true);
	const model = reader.match("model", false, MODEL_REF, 'a "provider/model" reference');
	const thinking = reader.text("thinking", false);
	const deny = reader.texts("deny");
	const readOnly = reader.texts("readOnly");
	if (prompt === undefined) return undefined;
	const node: ModelNode = { kind: "model", prompt, deny, readOnly };
	if (model !== undefined) node.model = model;
	if (thinking !== undefined) node.thinking = thinking;
	return node;
}

function parseEdge(problems: Problem[], at: string, value: unknown): Edge | undefined {
	if (!isFields(value)) {
		problems.push({ at, message: "must be an object" });
		return undefined;
	}
	const reader = new Reader(problems, at, value, ["from", "to", "exit", "label", "max"]);
	const from = reader.text("from", true);
	const to = reader.text("to", true);
	const exit = reader.text("exit", true);
	const label = reader.text("label", false);
	const max = value.max;
	let exitKind: Exit | undefined;
	if (exit !== undefined) {
		exitKind = EXITS.find((kind) => kind === exit);
		if (exitKind === undefined) reader.report("exit", `must be one of ${EXITS.join(", ")}`);
	}
	const maxValid = max === undefined || (typeof max === "number" && Number.isInteger(max) && max >= 1);
	if (!maxValid) reader.report("max", "must be a whole number, 1 or more");
	if (from === undefined || to === undefined || exitKind === undefined || !maxValid) return undefined;
	const edge: Edge = { from, to, exit: exitKind };
	if (label !== undefined) edge.label = label;
	if (typeof max === "number") edge.max = max;
	return edge;
}

function parseRequirement(problems: Problem[], at: string, value: unknown): Requirement | undefined {
	if (!isFields(value)) {
		problems.push({ at, message: "must be an object" });
		return undefined;
	}
	const reader = new Reader(problems, at, value, ["before", "passed", "notAfter"]);
	const before = reader.text("before", true);
	const passed = reader.text("passed", true);
	const notAfter = reader.texts("notAfter");
	if (before === undefined || passed === undefined) return undefined;
	return { before, passed, notAfter };
}

/**
 * Read a graph from the literal of its file. Checks every field's form; `checkGraph` checks how the nodes and edges fit
 * together. Throws one `GraphError` that lists every problem.
 */
export function parseGraph(value: unknown): Graph {
	if (!isFields(value)) throw new GraphError("?", [{ at: "graph", message: "must be an object" }]);
	const problems: Problem[] = [];
	const reader = new Reader(problems, "", value, ["name", "start", "nodes", "edges", "requires"]);
	const name = reader.match("name", true, GRAPH_NAME, "lower-case letters, digits and dashes");
	const start = reader.text("start", true);

	const nodes: Record<string, GraphNode> = {};
	if (!isFields(value.nodes)) reader.report("nodes", "is required and must be an object of nodes");
	else {
		if (Object.keys(value.nodes).length === 0) reader.report("nodes", "must have at least one node");
		for (const [id, raw] of Object.entries(value.nodes)) {
			if (id === END) reader.report(`nodes.${id}`, `"${END}" is reserved: it is the target that ends the graph`);
			else if (!NODE_ID.test(id))
				reader.report(`nodes.${id}`, "a node id is letters, digits, dashes and underscores");
			else {
				const node = parseNode(problems, `nodes.${id}`, raw);
				if (node) nodes[id] = node;
			}
		}
	}

	const edges: Edge[] = [];
	if (!Array.isArray(value.edges)) reader.report("edges", "is required and must be a list of edges");
	else {
		value.edges.forEach((raw: unknown, index) => {
			const edge = parseEdge(problems, `edges[${index}]`, raw);
			if (edge) edges.push(edge);
		});
	}

	const requires: Requirement[] = [];
	if (value.requires !== undefined) {
		if (!Array.isArray(value.requires)) reader.report("requires", "must be a list");
		else {
			value.requires.forEach((raw: unknown, index) => {
				const requirement = parseRequirement(problems, `requires[${index}]`, raw);
				if (requirement) requires.push(requirement);
			});
		}
	}

	if (problems.length > 0 || name === undefined || start === undefined) {
		throw new GraphError(typeof value.name === "string" ? value.name : "?", problems);
	}
	return { name, start, nodes, edges, requires };
}
