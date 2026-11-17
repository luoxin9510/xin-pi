// Graph files: `<name>.js` in `.pi/graphs/` of the project (from the cwd up to the repository root, closest wins; only
// in a trusted project), then in `<agent dir>/graphs/`. The first statement is `export default <literal>`. The literal
// is parsed, never run, so listing or starting a graph runs no code from the project.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { checkGraph, GRAPH_NAME, type Graph, parseGraph } from "xpi-graph";
import { getAgentDir } from "../../config.ts";
import { LiteralParser } from "../../utils/literal.ts";
import { projectDirs } from "../subagent/discovery.ts";

export interface GraphFile {
	name: string;
	path: string;
	source: "project" | "user";
}

/** The directories graphs are read from, highest priority first. */
export function graphDirs(
	cwd: string,
	trusted: boolean,
	agentDir = getAgentDir(),
): { dir: string; source: GraphFile["source"] }[] {
	const project = trusted
		? projectDirs(cwd).map((dir) => ({ dir: join(dir, ".pi", "graphs"), source: "project" as const }))
		: [];
	return [...project, { dir: join(agentDir, "graphs"), source: "user" }];
}

/** The graph files there are, by name. A name found earlier hides the same name later. The files are not read. */
export function discoverGraphs(cwd: string, trusted: boolean, agentDir = getAgentDir()): GraphFile[] {
	const found = new Map<string, GraphFile>();
	for (const { dir, source } of graphDirs(cwd, trusted, agentDir)) {
		if (!existsSync(dir)) continue;
		let entries: string[];
		try {
			entries = readdirSync(dir).sort();
		} catch {
			continue;
		}
		for (const entry of entries) {
			const name = entry.slice(0, -3);
			if (!entry.endsWith(".js") || !GRAPH_NAME.test(name) || found.has(name)) continue;
			const path = join(dir, entry);
			if (statSync(path).isFile()) found.set(name, { name, path, source });
		}
	}
	return [...found.values()];
}

const DEFAULT_START = /^\s*(?:(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/)\s*)*export\s+default\s*/;
const ONLY_SPACE_AND_COMMENTS = /^(?:\s|;|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*$/;

/** The literal of a graph file's text. Throws with the reason when the text is not one. */
export function parseGraphText(text: string): unknown {
	const start = DEFAULT_START.exec(text);
	if (!start) throw new Error("the first statement must be `export default { name, start, nodes, edges }`");
	const parser = new LiteralParser(text.slice(start[0].length));
	let literal: unknown;
	try {
		literal = parser.value();
	} catch (error) {
		throw new Error(`the graph is not a plain literal: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!ONLY_SPACE_AND_COMMENTS.test(text.slice(start[0].length + parser.end))) {
		throw new Error("nothing may follow the graph: a graph file is data, not a script");
	}
	return literal;
}

/** Read and check a graph file. `literal` is what the session stores; `graph` is what runs. Throws with the reason. */
export function readGraphFile(file: GraphFile): { literal: unknown; graph: Graph } {
	const literal = parseGraphText(readFileSync(file.path, "utf8"));
	const graph = checkGraph(parseGraph(literal));
	if (graph.name !== file.name) throw new Error(`name "${graph.name}" differs from the file name "${file.name}"`);
	return { literal, graph };
}
