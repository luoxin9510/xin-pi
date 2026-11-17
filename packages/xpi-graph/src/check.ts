// `checkGraph`: how the nodes and edges of a parsed graph fit together. A graph that fails does not start.

import { type Edge, END, type Graph, GraphError, type Problem } from "./types.ts";

/** The `max` of an edge on a loop that does not set one. */
export const DEFAULT_LOOP_MAX = 3;

/** The shortest path from `from` to `to` along `edges`, as the nodes passed; `[from]` when they are the same. */
function findPath(edges: readonly Edge[], from: string, to: string): string[] | undefined {
	const cameFrom = new Map<string, string | undefined>([[from, undefined]]);
	const queue = [from];
	for (let head = 0; head < queue.length; head++) {
		const node = queue[head];
		if (node === to) {
			const path: string[] = [];
			for (let step: string | undefined = node; step !== undefined; step = cameFrom.get(step)) path.unshift(step);
			return path;
		}
		for (const edge of edges) {
			if (edge.from !== node || cameFrom.has(edge.to)) continue;
			cameFrom.set(edge.to, node);
			queue.push(edge.to);
		}
	}
	return undefined;
}

const arrows = (path: readonly string[]) => path.join(" -> ");

/**
 * Check the structure and return the graph with `max` set on every edge that is on a loop. Throws one `GraphError` that
 * lists every problem.
 */
export function checkGraph(graph: Graph): Graph {
	const problems: Problem[] = [];
	const add = (at: string, message: string) => problems.push({ at, message });
	const isNode = (id: string) => Object.hasOwn(graph.nodes, id);

	if (!isNode(graph.start)) add("start", `no node "${graph.start}"`);

	// Each edge names nodes, and its exit fits the kind of the node it leaves.
	graph.edges.forEach((edge, index) => {
		const at = `edges[${index}]`;
		if (edge.to !== END && !isNode(edge.to)) add(`${at}.to`, `no node "${edge.to}"`);
		if (!isNode(edge.from)) {
			add(`${at}.from`, edge.from === END ? `"${END}" has no edges out` : `no node "${edge.from}"`);
			return;
		}
		const kind = graph.nodes[edge.from].kind;
		const fits =
			kind === "model"
				? edge.exit === "model" || edge.exit === "approve"
				: edge.exit === "pass" || edge.exit === "fail";
		if (!fits) {
			add(
				`${at}.exit`,
				kind === "model"
					? `"${edge.from}" is a model node: its exits are model and approve`
					: `"${edge.from}" is a command node: its exits are pass and fail`,
			);
			return;
		}
		const twin = graph.edges.findIndex(
			(other, otherIndex) =>
				otherIndex < index &&
				other.from === edge.from &&
				(kind === "model" ? other.to === edge.to : other.exit === edge.exit),
		);
		if (twin !== -1) {
			add(
				at,
				kind === "model"
					? `"${edge.from}" already has an edge to "${edge.to}" (edges[${twin}])`
					: `"${edge.from}" already has a ${edge.exit} edge (edges[${twin}])`,
			);
		}
	});

	graph.requires.forEach((requirement, requirementIndex) => {
		const at = `requires[${requirementIndex}]`;
		if (!isNode(requirement.before)) add(`${at}.before`, `no node "${requirement.before}"`);
		if (!isNode(requirement.passed)) add(`${at}.passed`, `no node "${requirement.passed}"`);
		else if (graph.nodes[requirement.passed].kind !== "command") {
			add(`${at}.passed`, `"${requirement.passed}" is not a command node: only a command can pass`);
		}
		requirement.notAfter.forEach((id, index) => {
			if (!isNode(id)) add(`${at}.notAfter[${index}]`, `no node "${id}"`);
			else if (id === requirement.before) add(`${at}.notAfter[${index}]`, `"${id}" is the node in before`);
		});
	});

	// The checks below walk the graph, which only means something when every name resolves.
	if (problems.length > 0) throw new GraphError(graph.name, problems);

	for (const id of Object.keys(graph.nodes)) {
		if (!graph.edges.some((edge) => edge.from === id)) {
			add(`nodes.${id}`, `has no edge out (an edge to "${END}" ends the graph)`);
		}
		if (!findPath(graph.edges, graph.start, id)) add(`nodes.${id}`, `cannot be reached from "${graph.start}"`);
	}
	if (!findPath(graph.edges, graph.start, END)) add("edges", `"${END}" cannot be reached from "${graph.start}"`);

	graph.requires.forEach((requirement, index) => {
		const at = `requires[${index}]`;
		const withoutPass = graph.edges.filter((edge) => !(edge.from === requirement.passed && edge.exit === "pass"));
		const unchecked = findPath(withoutPass, graph.start, requirement.before);
		if (unchecked) {
			add(
				at,
				`"${requirement.before}" can be reached without a pass of "${requirement.passed}": ${arrows(unchecked)}`,
			);
		}
		for (const id of requirement.notAfter) {
			const stale = findPath(withoutPass, id, requirement.before);
			if (stale) {
				add(
					at,
					`"${requirement.before}" can be reached from "${id}" with no pass of "${requirement.passed}" after it: ${arrows(stale)}`,
				);
			}
		}
	});

	if (problems.length > 0) throw new GraphError(graph.name, problems);

	// An edge is on a loop when its target leads back to its source.
	const edges = graph.edges.map((edge) =>
		edge.max === undefined && edge.to !== END && findPath(graph.edges, edge.to, edge.from)
			? { ...edge, max: DEFAULT_LOOP_MAX }
			: edge,
	);
	return { ...graph, edges };
}
