// shadow-git extension entry (`builtin:shadow-git`): xpi inside a workspace that another version control system owns
// and that has a shadow git repo over it (xpi-shadow-git, docs/shadow-git.md). It registers nothing unless the cwd is in a
// registered workspace (the primary) or XPI_SG_SANDBOX is set (a sandbox).
//
// Primary: GIT_DIR and GIT_WORK_TREE for every child, a live-session entry, the `/sg` command, the bash block list and
// a prompt paragraph. Sandbox: the path check for the file tools, the same block list and a prompt paragraph.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Backend, configAll, type Repo, runSg, type Sandbox, sandboxFromEnv, sessionsDir } from "xpi-shadow-git";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "../../core/extensions/types.ts";
import { scriptRunning, scripts } from "../subagent/background.ts";
import { registry } from "../subagent/registry.ts";
import { teams } from "../subagent/team.ts";
import { blockReason, compilePatterns } from "./guard.ts";
import { pathDenied, writableDirs } from "./policy-check.ts";
import { PRIMARY_PROMPT, SANDBOX_PROMPT } from "./prompt.ts";
import { findWorkspace, shadowGitContext, shadowGitOptions } from "./workspace.ts";

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
	const scriptsRunning = scripts.list(ctx.sessionManager.getSessionId()).filter(scriptRunning).length;
	const queued = (teams.current()?.live() ?? []).filter((member) => member.status === "queued");
	if (scriptsRunning > 0) {
		return `${scriptsRunning} background script(s) of this session are running (their agents may write the workspace); stop them (/subagents stop) or wait`;
	}
	if (queued.length > 0)
		return `teammate(s) ${queued.map((member) => member.name).join(", ")} are queued to start in the workspace`;
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

// The environment variables xpi sets for the workspace its session is in, and what they were before. One owner at a time:
// a session switched to another directory (/resume, --session) rebuilds the runtime, and the new one takes over.
interface Held {
	owner: symbol;
	prior: { GIT_DIR: string | undefined; GIT_WORK_TREE: string | undefined };
}
let held: Held | undefined;

function holdEnv(owner: symbol, repo: Repo): void {
	held = { owner, prior: held?.prior ?? { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE } };
	process.env.GIT_DIR = repo.gitDir;
	process.env.GIT_WORK_TREE = repo.workspace;
}

function releaseEnv(owner: symbol): void {
	if (held?.owner !== owner) return;
	for (const [name, value] of Object.entries(held.prior)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	held = undefined;
}

function registerPrimary(pi: ExtensionAPI): void {
	const owner = Symbol("shadow-git");
	const topLevel = !process.env.XPI_SUBAGENT_DEPTH;
	// The workspace the session's cwd is in, decided at session_start with the session's own cwd (a session resumed from
	// another directory has that directory's cwd, with no chdir). Undefined: this session is not in one, and nothing here acts.
	let repo: Repo | undefined;
	let blocks: ReturnType<typeof blockList> | undefined;
	const entryOf = (r: Repo) => join(sessionsDir(r), String(process.pid));

	const ensureEntry = () => {
		if (!repo || !topLevel || importStopped(repo)) return;
		const entry = entryOf(repo);
		if (existsSync(entry)) return;
		mkdirSync(sessionsDir(repo), { recursive: true });
		writeFileSync(entry, `${Date.now()}\n`);
		trackEntry(entry);
	};
	const leave = () => {
		if (repo && topLevel) dropEntry(entryOf(repo));
		releaseEnv(owner);
		repo = undefined;
		blocks = undefined;
	};

	pi.on("session_start", (_event, ctx) => {
		leave();
		repo = findWorkspace(ctx.cwd);
		if (!repo) return;
		holdEnv(owner, repo);
		blocks = blockList(repo, (message) => console.error(message));
		if (importStopped(repo)) say(ctx, STOPPED_IMPORT, "error");
		else ensureEntry();
	});
	pi.on("session_shutdown", leave);

	pi.on("before_agent_start", (event) => {
		if (!repo) return undefined;
		ensureEntry();
		event.systemPromptOptions.sections[SECTION] = PRIMARY_PROMPT(repo.workspace);
		return undefined;
	});

	pi.on("tool_call", (event) => {
		if (!repo) return undefined;
		// A stopped import leaves the workspace at the host's state, half done: nothing may run on it until it is settled.
		if (importStopped(repo)) return { block: true, reason: STOPPED_IMPORT };
		ensureEntry();
		const command = commandOf(event);
		const reason = command === undefined ? undefined : blockReason(command, blocks!.patterns());
		return reason ? { block: true, reason } : undefined;
	});

	if (!topLevel) return;
	pi.registerCommand("sg", {
		description: "shadow-git: import, export, merge, status, sbx ls",
		handler: async (args, ctx) => {
			if (!repo) return say(ctx, "sg: this session is not in a registered shadow-git workspace", "warning");
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

/** The shell command of a tool call: any tool whose input has a string `command` (bash, powershell, a custom one). */
function commandOf(event: ToolCallEvent): string | undefined {
	const command = (event.input as { command?: unknown }).command;
	return typeof command === "string" ? command : undefined;
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
		const command = commandOf(event);
		if (command !== undefined) {
			const reason = blockReason(command, blocks.patterns());
			return reason ? { block: true, reason } : undefined;
		}
		const paths = toolPaths(event);
		if (paths.length === 0) return undefined;
		writable ??= writableDirs(extension.sessionManager.getSessionDir(), sandbox.repo.ctx.store);
		for (const { path, access } of paths) {
			const reason = pathDenied(sandbox, backend, writable, extension.cwd, path, access);
			if (reason) return { block: true, reason };
		}
		return undefined;
	});
}

export function createShadowGitExtension() {
	return function shadowGit(pi: ExtensionAPI): void {
		if (process.env.XPI_SG_SANDBOX) {
			registerSandbox(pi);
			return;
		}
		registerPrimary(pi);
	};
}

export default createShadowGitExtension();
