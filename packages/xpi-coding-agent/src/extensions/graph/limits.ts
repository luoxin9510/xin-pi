// The limits of a node: command text it may not run (`deny`), paths it may not write (`readOnly`), and the paths that
// are read-only while any graph runs (the graph files, the session file). A backstop against mistakes, not a sandbox:
// `deny` matches a substring of the command text and `readOnly` sees only the file tools, not a shell command that
// writes a file.

import { sep } from "node:path";
import type { RunningState } from "xpi-graph";
import { resolveToCwd } from "../../core/tools/path-utils.ts";
import { protectLevel, realPathOf } from "../protect/match.ts";

/** The limits of the parent's current node, as JSON, for a subagent child. */
export const LIMITS_ENV = "XPI_GRAPH_LIMITS";

const SCHEME = /^@?[a-z][a-z0-9+.-]*:\/\//i;

export interface NodeLimits {
	graph: string;
	node: string;
	deny: string[];
	readOnly: string[];
	/** Real paths (files or directories) that cannot be written while the graph runs. */
	protected: string[];
}

/**
 * The limits in force: a model node's own. On a command node (its command running, or halted there) no node is at
 * work, so every node's `deny` holds.
 */
export function limitsOf(state: RunningState, protectedPaths: readonly string[]): NodeLimits {
	const node = state.graph.nodes[state.node];
	const everyDeny = Object.values(state.graph.nodes).flatMap((other) => (other.kind === "model" ? other.deny : []));
	return {
		graph: state.graph.name,
		node: state.node,
		deny: node.kind === "model" ? node.deny : [...new Set(everyDeny)],
		readOnly: node.kind === "model" ? node.readOnly : [],
		protected: [...protectedPaths],
	};
}

const strings = (value: unknown): string[] | undefined =>
	Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;

/** The limits a parent left in the environment. Undefined when there are none or they cannot be read. */
export function readLimitsEnv(value: string | undefined): NodeLimits | undefined {
	if (!value) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const { graph, node, deny, readOnly } = parsed as Record<string, unknown>;
	const denied = strings(deny);
	const paths = strings(readOnly);
	const kept = strings((parsed as Record<string, unknown>).protected);
	if (typeof graph !== "string" || typeof node !== "string" || !denied || !paths || !kept) return undefined;
	return { graph, node, deny: denied, readOnly: paths, protected: kept };
}

export interface Blocked {
	/** Which limit, for the record. */
	rule: string;
	/** Written for the model. */
	reason: string;
}

/** Why a tool call is not allowed under the limits, or undefined. */
export function blockedBy(
	limits: NodeLimits,
	call: { toolName: string; effect: string; input: Record<string, unknown> },
	cwd: string,
	platform: NodeJS.Platform = process.platform,
): Blocked | undefined {
	const where = `node "${limits.node}" of graph ${limits.graph}`;
	const command = call.toolName === "bash" || call.toolName === "powershell" ? call.input.command : undefined;
	if (typeof command === "string") {
		const hit = limits.deny.find((text) => command.includes(text));
		if (hit) {
			return {
				rule: `deny: ${hit}`,
				reason: `\`${hit}\` is not allowed in ${where}. The graph has its own step for it. If it is needed now, ask the user.`,
			};
		}
	}
	if (call.effect !== "write") return undefined;
	const path = call.input.path;
	if (typeof path !== "string" || path === "" || SCHEME.test(path)) return undefined;
	if (
		limits.readOnly.length > 0 &&
		protectLevel({ secret: [], readOnly: limits.readOnly }, path, cwd, platform) === "readOnly"
	) {
		return {
			rule: "readOnly",
			reason: `\`${path}\` cannot be written in ${where}. If a change is needed, ask the user.`,
		};
	}
	// A file system that ignores case (macOS, Windows) keeps the spelling it is given: `.PI/graphs` is `.pi/graphs`.
	const fold = (value: string) => (platform === "darwin" || platform === "win32" ? value.toLowerCase() : value);
	const real = fold(realPathOf(resolveToCwd(path, cwd)));
	if (limits.protected.some((kept) => real === fold(kept) || real.startsWith(`${fold(kept)}${sep}`))) {
		return {
			rule: "graph files",
			reason: `\`${path}\` cannot be written while a graph runs: it is a graph file or the session's own record.`,
		};
	}
	return undefined;
}
