// Parse one Claude Code agent file (spec 4.1). A boundary: bad files yield a skip reason, never a throw.

import { parse as parseYaml } from "yaml";

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

// Claude Code's colour names.
export const AGENT_COLORS = ["red", "blue", "green", "yellow", "purple", "orange", "pink", "cyan"] as const;
export type AgentColor = (typeof AGENT_COLORS)[number];

export interface AgentDefinition {
	name: string;
	description: string;
	prompt: string;
	tools?: string[];
	disallowedTools?: string[];
	model?: string;
	effort?: Effort;
	maxTurns?: number;
	skills?: string[];
	omitClaudeMd?: boolean;
	codemode?: boolean; // false: this agent keeps direct tools instead of codemode-only
	color?: AgentColor; // tints the agent's label in the panel and on its screen
	memory?: "user" | "project" | "local"; // persistent memory directory (Claude Code's paths)
	isolation?: "worktree"; // run in its own git worktree (the Agent call's isolation wins)
	source: string;
	inert: string[];
	warnings: string[]; // problems that do not skip the file (an unknown colour); shown once at discovery
}

export type ParseResult = { ok: true; def: AgentDefinition } | { ok: false; reason: string };

// Tier B (mapped in v2) and tier C (no effect) fields: parsed, then reported as having no effect.
const INERT_FIELDS = [
	"mcpServers",
	"autoCompactWindow",
	"permissionMode",
	"hooks",
	"background",
	"initialPrompt",
	"experimental",
];

export const inertNotice = (field: string) => `field "${field}" has no effect in subagent`;

class Skip extends Error {}

// The agent name becomes a directory name and a line in .git/info/exclude.
const isMemoryName = (name: string) => name !== "" && !name.startsWith(".") && !/[\\/\0\r\n*?[\]!#]/.test(name);

// Claude Code accepts a comma-separated string or a YAML list.
function nameList(value: unknown, field: string): string[] | undefined {
	if (value === undefined || value === null) return undefined;
	const items = typeof value === "string" ? value.split(",") : value;
	if (!Array.isArray(items) || !items.every((v) => typeof v === "string")) {
		throw new Skip(`"${field}" must be a comma-separated string or a list of strings`);
	}
	return items.map((s) => s.trim()).filter((s) => s !== "");
}

function optional<T>(value: unknown, field: string, check: (v: unknown) => boolean, expected: string): T | undefined {
	if (value === undefined || value === null) return undefined;
	if (!check(value)) throw new Skip(`"${field}" must be ${expected}`);
	return value as T;
}

export function parseDefinition(source: string, text: string): ParseResult {
	const lines = text.replace(/^﻿/, "").split(/\r?\n/);
	if (lines[0]?.trim() !== "---") return { ok: false, reason: "file does not start with --- frontmatter" };
	const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
	if (end === -1) return { ok: false, reason: "frontmatter is not closed with ---" };

	let fm: unknown;
	try {
		fm = parseYaml(lines.slice(1, end).join("\n"));
	} catch (err) {
		return { ok: false, reason: `invalid YAML: ${(err as Error).message.split("\n")[0]}` };
	}
	if (typeof fm !== "object" || fm === null || Array.isArray(fm))
		return { ok: false, reason: "frontmatter is not a mapping" };
	const f = fm as Record<string, unknown>;

	const name = f.name;
	if (name === undefined || name === null) return { ok: false, reason: 'missing "name"' };
	if (typeof name !== "string") return { ok: false, reason: '"name" must be a string' };
	if (name.length === 0 || name.length > 256) return { ok: false, reason: '"name" must be 1-256 characters' };
	if (name.includes(":")) return { ok: false, reason: '"name" must not contain ":"' };
	if (name.startsWith("-")) return { ok: false, reason: '"name" must not start with "-"' };
	if (f.memory !== undefined && f.memory !== null && !isMemoryName(name)) {
		return {
			ok: false,
			reason: `"name" ${JSON.stringify(name)} cannot be used with "memory": it becomes a directory name, so it must not be empty or start with ".", or contain a path separator, NUL, a newline or any of * ? [ ] ! #`,
		};
	}
	if (typeof f.description !== "string" || f.description.trim() === "")
		return { ok: false, reason: 'missing "description"' };

	try {
		const warnings: string[] = [];
		const rawColor = f.color;
		const color = AGENT_COLORS.find((c) => c === rawColor);
		if (rawColor !== undefined && rawColor !== null && color === undefined) {
			warnings.push(`unknown color ${JSON.stringify(rawColor)} ignored (use ${AGENT_COLORS.join(", ")})`);
		}
		const def: AgentDefinition = {
			name,
			description: f.description.trim(),
			prompt: lines
				.slice(end + 1)
				.join("\n")
				.trim(),
			tools: nameList(f.tools, "tools"),
			disallowedTools: nameList(f.disallowedTools, "disallowedTools"),
			model: optional<string>(f.model, "model", (v) => typeof v === "string" && v !== "", "a string"),
			effort: optional<Effort>(f.effort, "effort", (v) => EFFORTS.includes(v as Effort), EFFORTS.join(" | ")),
			maxTurns: optional<number>(
				f.maxTurns,
				"maxTurns",
				(v) => Number.isInteger(v) && (v as number) > 0,
				"a positive integer",
			),
			skills: nameList(f.skills, "skills"),
			omitClaudeMd: optional<boolean>(
				f.omitClaudeMd,
				"omitClaudeMd",
				(v) => typeof v === "boolean",
				"true or false",
			),
			codemode: optional<boolean>(f.codemode, "codemode", (v) => typeof v === "boolean", "true or false"),
			color,
			memory: optional<"user" | "project" | "local">(
				f.memory,
				"memory",
				(v) => v === "user" || v === "project" || v === "local",
				"user | project | local",
			),
			isolation: optional<"worktree">(f.isolation, "isolation", (v) => v === "worktree", "worktree"),
			source,
			warnings,
			inert: INERT_FIELDS.filter((k) => k in f),
		};
		return { ok: true, def };
	} catch (err) {
		if (err instanceof Skip) return { ok: false, reason: err.message };
		throw err;
	}
}
