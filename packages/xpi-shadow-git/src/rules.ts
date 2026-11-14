import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { precondition } from "./errors.ts";

export const MODES = ["private", "shared-ro", "shared-rw", "scratch", "hidden"] as const;
export type Mode = (typeof MODES)[number];

/**
 * One path rule. `ws` rules name a path relative to the workspace root ("" is the root itself); the others name an
 * absolute path outside the workspace.
 */
export interface Rule {
	mode: Mode;
	ws: boolean;
	path: string;
}

/** The rule as `sandbox.rule` text. */
export const ruleText = (rule: Rule): string =>
	`${rule.mode} ${rule.ws ? (rule.path === "" ? "@ws" : `@ws/${rule.path}`) : rule.path}`;

const MODE_LIST = MODES.join(", ");

/** The real path of `path`, also when it does not exist yet: the nearest existing ancestor's real path plus the rest. A dangling link is followed. */
export function realOf(path: string, depth = 0): string {
	const abs = resolve(path);
	try {
		return realpathSync(abs);
	} catch {}
	if (depth > 40) return abs;
	try {
		if (lstatSync(abs).isSymbolicLink()) return realOf(resolve(dirname(abs), readlinkSync(abs)), depth + 1);
	} catch {}
	const parent = dirname(abs);
	return parent === abs ? abs : join(realOf(parent, depth + 1), basename(abs));
}

/** Whether `path` is `root` or below it. */
export const within = (path: string, root: string): boolean =>
	path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

function segments(path: string, what: string): string[] {
	const parts = path.split("/").filter((part) => part !== "");
	if (parts.some((part) => part === "." || part === ".." || /[\n\0]/.test(part))) {
		throw precondition(`${what}: ${JSON.stringify(path)} has a . or .. segment or a control character`);
	}
	return parts;
}

/** Parse `<mode> <path>`. `@ws` is the workspace root; an absolute path inside the workspace becomes a workspace path. */
export function parseRule(text: string, workspace: string, source: string): Rule {
	const match = /^(\S+)\s+(\S.*?)\s*$/.exec(text.trim());
	const mode = MODES.find((candidate) => candidate === match?.[1]);
	if (!match || !mode) {
		throw precondition(
			`${source}: sandbox.rule ${JSON.stringify(text)}: expected "<mode> <path>", mode one of ${MODE_LIST}`,
		);
	}
	const path = match[2];
	if (path === "@ws" || path.startsWith("@ws/")) {
		return { mode, ws: true, path: segments(path.slice(3), `${source}: sandbox.rule`).join("/") };
	}
	if (path.startsWith("/")) {
		const real = realOf(`/${segments(path, `${source}: sandbox.rule`).join("/")}`);
		if (within(real, workspace)) return { mode, ws: true, path: real.slice(workspace.length + 1) };
		return { mode, ws: false, path: real };
	}
	throw precondition(
		`${source}: sandbox.rule ${JSON.stringify(text)}: the path is @ws, @ws/<path> or an absolute path`,
	);
}

const depthOf = (path: string): number => path.split("/").filter((part) => part !== "").length;

/** Whether the rule path covers `path` (the same path or a parent of it). */
export function covers(rule: Rule, path: string): boolean {
	if (rule.ws ? rule.path === "" : rule.path === "/") return true;
	return path === rule.path || path.startsWith(`${rule.path}/`);
}

/** What the path rules say about a path, or undefined when no rule matches. */
export interface RuleSet {
	rules: Rule[];
	/** The adapter's `metadata` paths, relative to the workspace root: hidden by default. */
	metadata: string[];
}

/**
 * The mode of `path`: the longest matching prefix wins. Among rules of the same length the later one wins, and a rule
 * of the user wins over a `metadata` path. A `metadata` path is hidden unless a rule at least as specific says
 * otherwise, so a broad rule such as `shared-ro @ws` does not unhide the host VCS's files.
 */
export function modeOf(set: RuleSet, ws: boolean, path: string): Mode | undefined {
	let best: { mode: Mode; depth: number } | undefined;
	if (ws) {
		for (const entry of set.metadata) {
			if (!covers({ mode: "hidden", ws: true, path: entry }, path)) continue;
			const depth = depthOf(entry);
			if (!best || depth > best.depth) best = { mode: "hidden", depth };
		}
	}
	for (const rule of set.rules) {
		if (rule.ws !== ws || !covers(rule, path)) continue;
		const depth = depthOf(rule.path);
		if (!best || depth >= best.depth) best = { mode: rule.mode, depth };
	}
	return best?.mode;
}

/** The modes that let a command write. */
export const WRITABLE: ReadonlySet<Mode> = new Set<Mode>(["private", "scratch", "shared-rw"]);
