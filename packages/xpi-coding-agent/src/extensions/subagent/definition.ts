// Parse one Claude Code agent file (spec 4.1). A boundary: bad files yield a skip reason, never a throw.

import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { parse as parseYaml } from "yaml";
import { type McpServerConfig, validateMcpServerConfig } from "../../core/mcp-servers.ts";
import { isLocalPath, resolvePath } from "../../utils/paths.ts";

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

// Claude Code's colour names.
export const AGENT_COLORS = ["red", "blue", "green", "yellow", "purple", "orange", "pink", "cyan"] as const;
export type AgentColor = (typeof AGENT_COLORS)[number];

// Claude Code's permission modes (`manual` is an alias for `default`). xpi never asks for permission, so every mode but
// `plan` runs as `bypassPermissions` does; `plan` makes the agent read-only (resolve.ts).
export const PERMISSION_MODES = [
	"default",
	"manual",
	"acceptEdits",
	"auto",
	"dontAsk",
	"bypassPermissions",
	"plan",
] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

// Where a definition came from: a project's .pi/agents or .claude/agents, the user's (~/.pi/agent/agents,
// ~/.claude/agents), `--agents`, or the built-ins. Inline MCP servers of a `project` agent load only in a trusted project.
export type AgentScope = "project" | "user" | "cli" | "builtin";

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
	background?: boolean; // true: a call without run_in_background runs this agent in the background
	permissionMode?: PermissionMode; // only "plan" changes anything: read-only tools, no MCP, read-only memory
	// Extensions loaded only into this agent's child, one `-e` each: absolute paths, or npm:, git:, builtin: sources.
	extensions?: string[];
	// Names of MCP servers (configured in mcp.json, or defined inline): the agent gets their tools and no other server's.
	mcpServers?: string[];
	// The inline definitions among them, by name (validated as mcp.json entries); the child gets them with --mcp-config.
	inlineMcpServers?: Record<string, McpServerConfig>;
	source: string;
	scope: AgentScope;
	inert: string[];
	warnings: string[]; // problems that do not skip the file (an unknown colour); shown once at discovery
}

export type ParseResult = { ok: true; def: AgentDefinition } | { ok: false; reason: string };

// Tier B (mapped in v2) and tier C (no effect) fields: parsed, then reported as having no effect.
// Claude Code fields with no effect here, and why.
const INERT_REASONS: Record<string, string> = {
	autoCompactWindow: "xpi compacts by reserve tokens (the compaction.* settings), not by a window size",
	hooks: "Claude Code's hook commands do not run in xpi; list extensions in the agent's `extensions` field instead (their tool_call and tool_result handlers do what hooks do)",
	initialPrompt: "it applies to an agent run as the main session, which xpi does not have",
	experimental: "it is ignored by Claude Code too",
};
const INERT_FIELDS = Object.keys(INERT_REASONS);

export const inertNotice = (field: string) => `field "${field}" has no effect in subagent: ${INERT_REASONS[field]}`;

class Skip extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

// `mcpServers`, as Claude Code takes it: server names (a list or a comma-separated string), inline definitions (a
// mapping with the server name as key, in mcp.json's shape), or a list mixing both. An inline definition the mcp.json
// validator rejects (`sse`, `ws`, a bad field) is skipped with its message; so is one in a project agent file that uses
// `auth: { provider }`, as in the project mcp.json: a repository must not choose where a credential goes.
function mcpServersField(
	value: unknown,
	scope: AgentScope,
	warnings: string[],
): { names?: string[]; inline?: Record<string, McpServerConfig> } {
	if (value === undefined || value === null) return {};
	const entries = typeof value === "string" ? value.split(",").map((s) => s.trim()) : value;
	const names: string[] = [];
	// A Map, then own properties: a server named "__proto__" stays an ordinary key.
	const inline = new Map<string, McpServerConfig>();
	const addInline = (definitions: Record<string, unknown>) => {
		for (const [name, raw] of Object.entries(definitions)) {
			if (names.includes(name)) {
				warnings.push(`mcpServers: server "${name}" is listed twice; the first entry wins`);
				continue;
			}
			const config = validateMcpServerConfig(name, raw);
			if (typeof config === "string") {
				warnings.push(`mcpServers: inline server skipped: ${config}`);
				continue;
			}
			if (scope === "project" && "url" in config && config.auth) {
				warnings.push(
					`mcpServers: inline server "${name}" skipped: auth is not allowed in a project agent file (a repository must not choose where a credential goes)`,
				);
				continue;
			}
			names.push(name);
			inline.set(name, config);
		}
	};
	if (!Array.isArray(entries)) {
		if (!isRecord(entries)) throw new Skip('"mcpServers" must be a list of server names or inline definitions');
		addInline(entries);
	} else {
		for (const entry of entries) {
			if (typeof entry === "string") {
				if (entry !== "" && !names.includes(entry)) names.push(entry);
			} else if (isRecord(entry)) addInline(entry);
			else throw new Skip('"mcpServers" must be a list of server names or inline definitions');
		}
	}
	return { names, ...(inline.size > 0 ? { inline: Object.fromEntries(inline) } : {}) };
}

// `extensions`: a list or a comma-separated string, as `tools`. A local path (the loader's isLocalPath) is resolved
// against `baseDir` and passed absolute, since the child's cwd may be a worktree. A missing one warns at discovery and
// is kept: the child (--strict-extensions) then fails on it, so a guarded agent never runs without its guard. npm:,
// git: and builtin: sources pass as given.
function extensionsField(value: unknown, baseDir: string, warnings: string[]): string[] | undefined {
	const entries = nameList(value, "extensions");
	if (entries === undefined) return undefined;
	const out: string[] = [];
	for (const entry of entries) {
		const resolved = isLocalPath(entry) ? resolvePath(entry, baseDir) : entry;
		if (isLocalPath(entry) && !existsSync(resolved)) {
			warnings.push(`extensions: "${entry}" not found (${resolved}): this agent's calls will fail until it exists`);
		}
		if (!out.includes(resolved)) out.push(resolved);
	}
	return out;
}

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

// Top-level `key: value` lines whose plain value holds ": " (not valid YAML), with the value quoted as a string.
// Values that start a quoted string, a flow collection, a block scalar, an anchor or a tag are left alone.
function quotePlainValues(yaml: string): string {
	return yaml
		.split("\n")
		.map((line) => {
			const match = /^([A-Za-z_][\w-]*):[ \t]+(.+?)[ \t]*$/.exec(line);
			if (!match) return line;
			// The rest of the line is the value, "#" included: a description that mentions "issue #12" keeps it.
			const value = match[2];
			if (!value.includes(": ") || /^["'[{|>&*!]/.test(value)) return line;
			return `${match[1]}: ${JSON.stringify(value)}`;
		})
		.join("\n");
}

// `scope` is where the file was found (discovery passes it); it decides what its inline MCP servers may do.
// Without one, the file counts as a project's: the scope that may do the least.
// Local `extensions` entries are relative to the file's directory.
export function parseDefinition(source: string, text: string, scope: AgentScope = "project"): ParseResult {
	const lines = text.replace(/^﻿/, "").split(/\r?\n/);
	if (lines[0]?.trim() !== "---") return { ok: false, reason: "file does not start with --- frontmatter" };
	const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
	if (end === -1) return { ok: false, reason: "frontmatter is not closed with ---" };

	let fm: unknown;
	const yaml = lines.slice(1, end).join("\n");
	try {
		fm = parseYaml(yaml);
	} catch (err) {
		// Claude Code reads `description: Use when: ...` as one string; strict YAML refuses the second colon.
		try {
			fm = parseYaml(quotePlainValues(yaml));
		} catch {
			return { ok: false, reason: `invalid YAML: ${(err as Error).message.split("\n")[0]}` };
		}
	}
	if (typeof fm !== "object" || fm === null || Array.isArray(fm))
		return { ok: false, reason: "frontmatter is not a mapping" };
	const body = lines
		.slice(end + 1)
		.join("\n")
		.trim();
	return definitionFromFields(source, fm as Record<string, unknown>, body, scope, dirname(source));
}

// A definition from its fields (an agent file's frontmatter, or an entry of `--agents`) and its system prompt.
export function definitionFromFields(
	source: string,
	f: Record<string, unknown>,
	prompt: string,
	scope: AgentScope = "project",
	baseDir: string = process.cwd(), // where a local `extensions` entry is resolved: the agent file's directory
): ParseResult {
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
		const permissionMode = optional<PermissionMode>(
			f.permissionMode,
			"permissionMode",
			(v) => PERMISSION_MODES.includes(v as PermissionMode),
			PERMISSION_MODES.join(" | "),
		);
		if (permissionMode !== undefined && permissionMode !== "plan") {
			warnings.push(
				`permissionMode "${permissionMode}" has no effect: xpi never asks for permission; runs as bypassPermissions`,
			);
		}
		const plan = permissionMode === "plan";
		const noServers =
			f.mcpServers === undefined ||
			f.mcpServers === null ||
			(Array.isArray(f.mcpServers) && f.mcpServers.length === 0);
		if (plan && !noServers) {
			warnings.push('mcpServers is ignored with permissionMode "plan": MCP tools can change things');
		}
		const servers = plan ? {} : mcpServersField(f.mcpServers, scope, warnings);
		const extensions = extensionsField(f.extensions, baseDir, warnings);
		const def: AgentDefinition = {
			name,
			description: f.description.trim(),
			prompt,
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
			background: optional<boolean>(f.background, "background", (v) => typeof v === "boolean", "true or false"),
			...(permissionMode !== undefined ? { permissionMode } : {}),
			...(extensions !== undefined ? { extensions } : {}),
			mcpServers: servers.names,
			...(servers.inline ? { inlineMcpServers: servers.inline } : {}),
			source,
			scope,
			warnings,
			inert: INERT_FIELDS.filter((k) => k in f),
		};
		return { ok: true, def };
	} catch (err) {
		if (err instanceof Skip) return { ok: false, reason: err.message };
		throw err;
	}
}
