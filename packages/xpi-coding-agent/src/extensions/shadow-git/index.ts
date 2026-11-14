// shadow-git extension entry (`builtin:shadow-git`): xpi inside a workspace that another version control system owns
// and that has a shadow git repo over it (xpi-shadow-git, docs/shadow-git.md). It registers nothing unless the cwd is in a
// registered workspace (the primary) or XPI_SG_SANDBOX is set (a sandbox).
//
// Primary: GIT_DIR and GIT_WORK_TREE for every child, a live-session entry, the `/sg` command, the bash block list and
// a prompt paragraph. Sandbox: the path check for the file tools, the same block list and a prompt paragraph.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Backend, configAll, type Repo, runSg, type Sandbox, sandboxFromEnv, sessionsDir } from "xpi-shadow-git";
import { getAgentDir } from "../../config.ts";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "../../core/extensions/types.ts";
import { registry } from "../subagent/registry.ts";
import { blockReason, compilePatterns } from "./guard.ts";
import { pathDenied, writableDirs } from "./policy-check.ts";
import { PRIMARY_PROMPT, SANDBOX_PROMPT } from "./prompt.ts";
import { findWorkspace, shadowGitContext, shadowGitOptions } from "./workspace.ts";

export interface ShadowGitHooks {
	/** The directory that decides whether this is a workspace. Default: the process's cwd. */
	cwd?: string;
}

const SECTION = "shadow-git";
const USAGE =
	"/sg import [--abort] | export [--apply] | merge <branch> (or --continue, --abort) | status | sbx ls   (xpi sg in a terminal does the rest)";

// Entries this process wrote, removed at exit. One hook for the process, however often the extension is loaded (/reload).
const entries = new Set<string>();
let exitHooked = false;

function dropEntry(file: string): void {
	entries.delete(file);
	rmSync(file, { force: true });
}

function trackEntry(file: string): void {
	entries.add(file);
	if (exitHooked) return;
	exitHooked = true;
	process.on("exit", () => {
		for (const entry of entries) rmSync(entry, { force: true });
	});
}

const importStopped = (repo: Repo): boolean => existsSync(join(repo.gitDir, "SG_IMPORT"));

const STOPPED_IMPORT =
	"shadow-git: an import is stopped (SG_IMPORT) in this workspace. Run xpi sg import to resume it or xpi sg import --abort, then start xpi again.";

/** What the tool hooks share: the bash block list of the repo, read once per session start. */
function blockList(repo: Repo, notify: (message: string) => void) {
	let patterns: RegExp[] | undefined;
	return {
		reset: () => {
			patterns = undefined;
		},
		patterns: (): RegExp[] => {
			if (patterns) return patterns;
			const compiled = compilePatterns(configAll(repo, "shadow.blockCommand"));
			for (const bad of compiled.invalid)
				notify(`shadow-git: shadow.blockCommand ${JSON.stringify(bad)} is not a regular expression; ignored`);
			patterns = compiled.patterns;
			return patterns;
		},
	};
}

function say(
	ctx: Pick<ExtensionContext, "hasUI" | "ui">,
	message: string,
	level: "info" | "warning" | "error" = "info",
) {
	if (ctx.hasUI) ctx.ui.notify(message, level);
	else if (level === "info") console.log(message);
	else console.error(message);
}

// What keeps `/sg import`, `export --apply` and `merge` from running: something of this session still writes the primary.
function busyReason(ctx: ExtensionContext): string | undefined {
	if (!ctx.isIdle()) return "the main agent is working in the workspace; wait for it to finish";
	const working = registry
		.list(ctx.sessionManager.getSessionId())
		.filter((record) => record.status === "running" && record.worktree?.kind !== "shadow-git");
	if (working.length > 0) {
		return `${working.length} agent(s) of this session are working in the workspace without a sandbox (${working.map((record) => record.name ?? record.id).join(", ")}); stop them (/subagents stop) or wait`;
	}
	return undefined;
}

type SgCommand = { args: string[]; writes: boolean };

/** The `/sg` arguments the command accepts, or a usage message. */
export function parseSgArgs(text: string): SgCommand | string {
	const args = text.split(/\s+/).filter(Boolean);
	const [sub, ...rest] = args;
	const only = (...allowed: string[]) =>
		rest.every((arg) => allowed.includes(arg)) && new Set(rest).size === rest.length;
	switch (sub) {
		case "import":
			return only("--abort") ? { args, writes: true } : USAGE;
		case "export":
			return only("--apply") ? { args, writes: rest.includes("--apply") } : USAGE;
		case "merge":
			return rest.length === 1 && (!rest[0].startsWith("-") || rest[0] === "--continue" || rest[0] === "--abort")
				? { args, writes: true }
				: USAGE;
		case "status":
			return rest.length === 0 ? { args, writes: false } : USAGE;
		case "sbx":
			return rest.length === 1 && rest[0] === "ls" ? { args, writes: false } : USAGE;
		default:
			return USAGE;
	}
}

function registerPrimary(pi: ExtensionAPI, repo: Repo): void {
	// Every child inherits these: bash, `!` commands, MCP servers and subagents. A sandboxed child replaces them.
	process.env.GIT_DIR = repo.gitDir;
	process.env.GIT_WORK_TREE = repo.workspace;

	const topLevel = !process.env.XPI_SUBAGENT_DEPTH;
	const entry = join(sessionsDir(repo), String(process.pid));
	const ensureEntry = () => {
		if (!topLevel || importStopped(repo) || existsSync(entry)) return;
		mkdirSync(sessionsDir(repo), { recursive: true });
		writeFileSync(entry, `${Date.now()}\n`);
		trackEntry(entry);
	};
	const blocks = blockList(repo, (message) => console.error(message));

	pi.on("session_start", (_event, ctx) => {
		blocks.reset();
		if (importStopped(repo)) say(ctx, STOPPED_IMPORT, "error");
		else ensureEntry();
	});
	pi.on("session_shutdown", () => {
		if (topLevel) dropEntry(entry);
	});

	pi.on("before_agent_start", (event) => {
		ensureEntry();
		event.systemPromptOptions.sections[SECTION] = PRIMARY_PROMPT(repo.workspace);
		return undefined;
	});

	pi.on("tool_call", (event) => {
		// A stopped import leaves the workspace at the host's state, half done: nothing may run on it until it is settled.
		if (importStopped(repo)) return { block: true, reason: STOPPED_IMPORT };
		ensureEntry();
		if (event.toolName !== "bash") return undefined;
		const reason = blockReason((event.input as { command?: string }).command ?? "", blocks.patterns());
		return reason ? { block: true, reason } : undefined;
	});

	if (!topLevel) return;
	pi.registerCommand("sg", {
		description: "shadow-git: import, export, merge, status, sbx ls",
		handler: async (args, ctx) => {
			const parsed = parseSgArgs(args);
			if (typeof parsed === "string") return say(ctx, `usage: ${parsed}`, "warning");
			if (parsed.writes) {
				const busy = busyReason(ctx);
				if (busy) return say(ctx, `sg: ${parsed.args[0]} needs the workspace to itself: ${busy}`, "error");
			}
			let text = "";
			const append = (chunk: string) => {
				text += chunk;
			};
			const code = await runSg(
				["--repo", repo.name, ...parsed.args],
				shadowGitOptions(ctx.cwd, { stdout: append, stderr: append, stdio: "capture" }),
			);
			say(ctx, text.trimEnd() || `sg ${parsed.args.join(" ")}: done`, code === 0 ? "info" : "error");
		},
	});
}

function toolPaths(event: ToolCallEvent): { path: string; access: "read" | "write" }[] {
	const input = event.input as { path?: unknown };
	const path = typeof input.path === "string" ? input.path : undefined;
	switch (event.toolName) {
		case "read":
		case "grep":
		case "find":
		case "ls":
			return path === undefined ? [] : [{ path, access: "read" }];
		case "write":
		case "edit":
			return path === undefined ? [] : [{ path, access: "write" }];
		default:
			return [];
	}
}

function registerSandbox(pi: ExtensionAPI): void {
	const ctx = shadowGitContext(process.cwd());
	let sandbox: Sandbox;
	try {
		sandbox = sandboxFromEnv(ctx)!;
	} catch (error) {
		// A sandbox that cannot be opened is not one to trust: every tool call is refused.
		const reason = `shadow-git: XPI_SG_SANDBOX=${process.env.XPI_SG_SANDBOX} cannot be opened: ${(error as Error).message}`;
		pi.on("tool_call", () => ({ block: true, reason }));
		return;
	}
	const backend: Backend = process.env.XPI_SG_BACKEND === "namespace" ? "namespace" : "policy";
	const blocks = blockList(sandbox.repo, (message) => console.error(message));
	let writable: ReturnType<typeof writableDirs> | undefined;

	pi.on("session_start", () => blocks.reset());
	pi.on("before_agent_start", (event) => {
		event.systemPromptOptions.sections[SECTION] = SANDBOX_PROMPT(
			`${sandbox.repo.name}/${sandbox.id}`,
			sandbox.id,
			sandbox.workspace,
			backend,
		);
		return undefined;
	});
	pi.on("tool_call", (event, extension) => {
		if (event.toolName === "bash") {
			const reason = blockReason((event.input as { command?: string }).command ?? "", blocks.patterns());
			return reason ? { block: true, reason } : undefined;
		}
		const paths = toolPaths(event);
		if (paths.length === 0) return undefined;
		writable ??= writableDirs(getAgentDir(), extension.sessionManager.getSessionDir(), sandbox.repo.ctx.store);
		for (const { path, access } of paths) {
			const reason = pathDenied(sandbox, backend, writable, extension.cwd, path, access);
			if (reason) return { block: true, reason };
		}
		return undefined;
	});
}

export function createShadowGitExtension(hooks: ShadowGitHooks = {}) {
	return function shadowGit(pi: ExtensionAPI): void {
		if (process.env.XPI_SG_SANDBOX) {
			registerSandbox(pi);
			return;
		}
		const repo = findWorkspace(hooks.cwd ?? process.cwd());
		if (repo) registerPrimary(pi, repo);
	};
}

export default createShadowGitExtension();
