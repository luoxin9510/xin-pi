// Turn a definition + call input + config into the child process spec (spec 5).

import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Config } from "./config.ts";
import type { AgentDefinition } from "./definition.ts";
import { childInvocation } from "./invocation.ts";
import { newAgentId, subagentSessionDir } from "./sessions.ts";
import { findSkill } from "./skills.ts";
import type { WorktreeRef } from "./worktree.ts";

export interface CallInput {
	description: string;
	prompt: string;
	subagent_type?: string;
	model?: string;
	effort?: string; // a thinking level: an Effort, or "off" when continuing a stored conversation
	resume?: string;
}

export interface ParentContext {
	model?: string; // "provider/id" of the parent session
	thinking: string;
	cwd: string;
	trusted: boolean;
	sessionFile?: string; // undefined when the parent session is in memory
	sessionId: string;
}

export interface ChildSpec {
	command: string;
	args: string[]; // everything except --system-prompt and the prompt, which the runner adds
	env: Record<string, string>;
	cwd: string;
	systemPrompt: string;
	prompt: string;
	model: string;
	thinking: string;
	maxTurns?: number;
	agentId: string;
	warnings: string[];
	worktree?: WorktreeRef; // isolation: the child's cwd is its path; the exchange creates and settles it
}

// What the caller decided before resolving: the new agent's id (a worktree path needs it) and the worktree to run in.
export interface ResolveOptions {
	agentId?: string;
	worktree?: WorktreeRef;
	memoryRoot?: string; // project/local memory base: the main checkout (git root of the parent's cwd); default the parent's cwd
	claudeDir?: string; // user memory base, default ~/.claude (tests pass a temp dir)
}

const CODEMODE_PROMPT = "Use the `codemode` tool for all tool calls, and put independent calls in one script.";

const BUILTIN_TOOL_MAP: Record<string, string> = {
	Read: "read",
	Write: "write",
	Edit: "edit",
	Bash: "bash",
	Grep: "grep",
	Glob: "find",
	LS: "ls",
};

// Tools that would let a child spawn agents. Nesting is fixed at one level in v1.
const NESTING_TOOLS = ["Agent", "Task"];

function resolveModel(input: CallInput, def: AgentDefinition, config: Config, parent: ParentContext): string {
	// The parent model is used only for an explicit "inherit"; the default is config.defaultModel ("haiku").
	const choice = input.model ?? def.model ?? config.defaultModel;
	if (choice === "inherit") {
		if (!parent.model) throw new Error("the parent session has no model to inherit");
		return parent.model;
	}
	return config.models[choice] ?? choice;
}

// Map Claude Code tool names to pi names. undefined = no pi equivalent (or nesting).
function mapTool(name: string, toolMap: Record<string, string>): string | undefined {
	if (toolMap[name]) return toolMap[name];
	if (name.startsWith("mcp__")) return name;
	if (/^[a-z][a-z0-9_]*$/.test(name)) return name; // already a pi name
	return undefined;
}

// Claude Code's three memory directories; created here. `name` becomes a path segment.
export function memoryDir(def: AgentDefinition, parent: ParentContext, options: ResolveOptions): string {
	if (/[\\/]/.test(def.name) || def.name === "." || def.name === "..") {
		throw new Error(`agent name "${def.name}" cannot be used for memory: it must not contain a path separator`);
	}
	const root = options.memoryRoot ?? parent.cwd;
	const dir = {
		user: join(options.claudeDir ?? join(homedir(), ".claude"), "agent-memory", def.name),
		project: join(root, ".claude", "agent-memory", def.name),
		local: join(root, ".claude", "agent-memory-local", def.name),
	}[def.memory!];
	mkdirSync(dir, { recursive: true });
	return dir;
}

const MEMORY_MAX_LINES = 200;
const MEMORY_MAX_BYTES = 25_000;

// The head of MEMORY.md: the first 200 lines or 25000 bytes, whichever comes first (a cut character is dropped whole).
function memoryHead(dir: string, warnings: string[]): { text: string; cut: boolean } | undefined {
	let raw: Buffer;
	try {
		raw = readFileSync(join(dir, "MEMORY.md"));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT")
			warnings.push(`could not read ${join(dir, "MEMORY.md")} (${(err as Error).message}); treated as empty`);
		return undefined;
	}
	let text = raw.toString("utf8");
	let cut = false;
	const lines = text.split("\n");
	if (lines.length > MEMORY_MAX_LINES + (text.endsWith("\n") ? 1 : 0)) {
		text = lines.slice(0, MEMORY_MAX_LINES).join("\n");
		cut = true;
	}
	if (Buffer.byteLength(text) > MEMORY_MAX_BYTES) {
		text = Buffer.from(text).subarray(0, MEMORY_MAX_BYTES).toString("utf8").replace(/�+$/, "");
		cut = true;
	}
	return { text, cut };
}

function memorySection(dir: string, readOnly: boolean, warnings: string[]): string {
	const head = memoryHead(dir, warnings);
	const note = `\n\n(MEMORY.md was truncated here: only its first ${MEMORY_MAX_LINES} lines or ${MEMORY_MAX_BYTES} bytes are shown. Read the file for the rest, and keep it shorter.)`;
	const body = head === undefined ? "MEMORY.md does not exist yet." : head.text.trimEnd() + (head.cut ? note : "");
	return [
		"# Persistent memory",
		`You have a persistent memory directory: ${dir}`,
		readOnly
			? "Writing to this memory is not allowed for you: read it, do not change it."
			: [
					"It survives between your runs. Save what a later run would want to know (conventions, decisions, user preferences, where things are), not what the code already shows.",
					"Keep `MEMORY.md` there as a short index: one line per memory, pointing to a topic file in the same directory when it needs more. Update an existing memory instead of adding a duplicate, and remove what turned out wrong.",
				].join("\n"),
		"The start of MEMORY.md:",
		body,
	].join("\n");
}

function resolveTools(
	def: AgentDefinition,
	config: Config,
	codemode: boolean,
): { args: string[]; warnings: string[]; memoryReadOnly: boolean } {
	const toolMap = { ...BUILTIN_TOOL_MAP, ...config.toolMap };
	const warnings: string[] = [];

	const map = (names: string[]) => {
		const out: string[] = [];
		for (const name of names) {
			if (NESTING_TOOLS.includes(name)) continue;
			const mapped = mapTool(name, toolMap);
			if (mapped === undefined) warnings.push(`tool "${name}" has no pi equivalent`);
			else if (!out.includes(mapped)) out.push(mapped);
		}
		return out;
	};

	// `Bash(git push *)` in a deny list removes the whole tool: pi has no per-command rules.
	const deny = map((def.disallowedTools ?? []).map((t) => t.replace(/\(.*\)$/, "").trim()));
	const args: string[] = [];
	// Memory needs Read, Write and Edit; a deny rule on Write or Edit keeps them off and makes the memory read-only.
	const memoryTools = def.memory ? map(["Read", "Write", "Edit"]) : [];
	const memoryReadOnly = !!def.memory && memoryTools.slice(1).some((t) => deny.includes(t));
	if (memoryReadOnly) {
		const widened = (def.disallowedTools ?? []).filter(
			(t) => t.includes("(") && memoryTools.slice(1).includes(map([t.replace(/\(.*\)$/, "").trim()])[0]),
		);
		warnings.push(
			`memory "${def.memory}" is read-only: disallowedTools denies Write or Edit, so both are removed` +
				(widened.length > 0
					? ` (${widened.map((t) => `"${t}"`).join(", ")} denies the whole tool: pi has no per-path rules)`
					: ""),
		);
		for (const t of memoryTools.slice(1)) if (!deny.includes(t)) deny.push(t); // Write and Edit go together
	}
	if (def.tools !== undefined) {
		const listed = map(def.tools);
		const extra = (memoryReadOnly ? memoryTools.slice(0, 1) : memoryTools).filter((t) => !listed.includes(t));
		const allow = [...listed, ...extra].filter((t) => !deny.includes(t));
		if (allow.length === 0) throw new Error(`agent "${def.name}" has no usable tools`);
		args.push("--tools", (codemode ? ["codemode", ...allow.filter((t) => t !== "codemode")] : allow).join(","));
		// A --tools list does not drop MCP tools unless an entry starts with mcp__; an agent must not get unlisted ones.
		if (!allow.some((t) => t.startsWith("mcp__"))) deny.push("mcp__*");
	} else if (codemode) {
		args.push("--tools", "+codemode");
	}
	if (deny.length > 0) args.push("--exclude-tools", deny.join(","));
	return { args, warnings, memoryReadOnly };
}

// `parentCwd` is where skills are looked up; `cwd` is the child's working directory (a worktree when isolated).
function buildSystemPrompt(
	def: AgentDefinition,
	parentCwd: string,
	cwd: string,
	now: Date,
	codemode: boolean,
	memory?: string,
): { text: string; warnings: string[] } {
	const parts = [def.prompt];
	const warnings: string[] = [];
	for (const name of def.skills ?? []) {
		const text = findSkill(name, parentCwd);
		if (text === undefined) warnings.push(`skill "${name}" not found`);
		else parts.push(`# Skill: ${name}\n\n${text.trim()}`);
	}
	if (memory) parts.push(memory);
	parts.push(
		[
			"# Environment",
			`Working directory: ${cwd}`,
			`Platform: ${process.platform}`,
			`Date: ${now.toISOString().slice(0, 10)}`,
		].join("\n"),
	);
	if (codemode) parts.push(CODEMODE_PROMPT);
	return { text: parts.join("\n\n"), warnings };
}

export function resolveChild(
	def: AgentDefinition,
	input: CallInput,
	config: Config,
	parent: ParentContext,
	options: ResolveOptions = {},
): ChildSpec {
	const model = resolveModel(input, def, config, parent);
	const thinking = input.effort ?? def.effort ?? parent.thinking;
	const codemode = config.childCodemode === "only" && def.codemode !== false;
	const tools = resolveTools(def, config, codemode);
	const cwd = options.worktree ? join(options.worktree.path, options.worktree.subdir ?? "") : parent.cwd;
	const memory = def.memory
		? memorySection(memoryDir(def, parent, options), tools.memoryReadOnly, tools.warnings)
		: undefined;
	const system = buildSystemPrompt(def, parent.cwd, cwd, new Date(), codemode, memory);

	// A resume id was already checked by storedAgent().
	const agentId = input.resume ?? options.agentId ?? newAgentId();
	const session = parent.sessionFile
		? ["--session-dir", subagentSessionDir(parent), "--session-id", agentId]
		: ["--no-session"];

	const invocation = childInvocation(config.piCommand);
	const args = [
		...invocation.args,
		"--mode",
		"rpc",
		"--model",
		model,
		"--thinking",
		thinking,
		...tools.args,
		...(def.omitClaudeMd ? ["--no-context-files"] : []),
		parent.trusted ? "--approve" : "--no-approve",
		...session,
	];

	return {
		command: invocation.command,
		args,
		// A codemode-only child gets `codemode` in mode "only" from the pipipi extension itself (index.ts).
		env: {
			...(process.env as Record<string, string>),
			PIPIPI_DEPTH: "1",
			...(codemode ? { PIPIPI_CHILD_CODEMODE: "only" } : {}),
		},
		cwd,
		systemPrompt: system.text,
		prompt: input.prompt,
		model,
		thinking,
		maxTurns: def.maxTurns,
		agentId,
		warnings: [...tools.warnings, ...system.warnings],
		worktree: options.worktree,
	};
}
