// Real-model eval harness. Two ways in:
// - `direct`: the Agent tool loaded in this process against a stub ExtensionAPI, children are real `pi` processes.
// - `parent`: a real parent `pi` (codemode + this checkout) that calls the tool from its own scripts.
// Every model call is haiku: defaultModel is pinned to "haiku" in both ways, and cases check the model of every result
// (direct) or of every assistant message in every session file (parent).

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentResult } from "../../../src/extensions/subagent/agent-tool.ts";
import subagent from "../../../src/extensions/subagent/index.ts";
import { copyUserAuth } from "../user-auth.ts";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."); // the xpi-coding-agent package
export const PI = process.env.XPI_SUBAGENT_TEST_PI ?? join(ROOT, "dist", "bundle", "cli.js");
export const HAIKU = "anthropic/claude-haiku-5-5";
const PINNED = { subagent: { defaultModel: "haiku" } };

// A sandbox for everything below (children and parents inherit the environment): a temp HOME, a temp agent dir holding a
// copy of the user's auth.json only, and a git identity. Nothing in ~/.pi/agent is read except that one file, or written.
{
	const userAuth = join(process.env.HOME ?? "", ".pi", "agent", "auth.json");
	const root = mkdtempSync(join(tmpdir(), "subagent-eval-env-"));
	mkdirSync(join(root, "home"), { recursive: true });
	mkdirSync(join(root, "agent"), { recursive: true });
	copyUserAuth(userAuth, join(root, "agent", "auth.json"));
	writeFileSync(
		join(root, "agent", "settings.json"),
		JSON.stringify({
			defaultProvider: "anthropic",
			defaultModel: "claude-haiku-5-5",
			packages: [],
			quietStartup: true,
		}),
	);
	writeFileSync(
		join(root, "gitconfig"),
		"[user]\n\tname = Eval\n\temail = eval@example.com\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n",
	);
	process.env.HOME = join(root, "home");
	process.env.GIT_CONFIG_GLOBAL = join(root, "gitconfig");
	process.env.XPI_CODING_AGENT_DIR = join(root, "agent");
	process.env.XPI_SKIP_VERSION_CHECK = "1";
	process.env.XPI_TELEMETRY = "0";
}

// ---- command-line flags (shared by evals/run.ts and stress/stress.ts) ----
export function flag(name: string): string | undefined {
	const i = process.argv.indexOf(name);
	if (i === -1) return undefined;
	const value = process.argv[i + 1];
	if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value`);
	return value;
}

export function intFlag(name: string, fallback: number): number {
	return toInt(name, flag(name) ?? String(fallback));
}

export function intListFlag(name: string, fallback: string): number[] {
	return (flag(name) ?? fallback).split(",").map((v) => toInt(name, v));
}

function toInt(name: string, value: string): number {
	const n = Number(value);
	if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive integer, got "${value}"`);
	return n;
}

// A temp git repository with the given files.
export function fixture(files: Record<string, string> = {}): string {
	const dir = mkdtempSync(join(tmpdir(), "subagent-eval-"));
	mkdirSync(join(dir, ".git"));
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), text);
	}
	return dir;
}

export interface DirectTool {
	call(params: Record<string, unknown>): Promise<AgentResult>;
	sessionDir: string;
	sessionId: string; // the parent session id: registry.list(sessionId) shows its subagents
	warnings: string[];
}

export interface DirectOptions {
	settings?: Record<string, unknown>; // merged over { defaultModel: "haiku" }
	parentModel?: { provider: string; id: string }; // the session model "inherit" resolves to (default haiku)
}

// The extension loaded in this process, with a persisted (temp) parent session so resume works. Every call is
// aborted with `signal`, which stops its child.
export async function directTool(cwd: string, signal: AbortSignal, options: DirectOptions = {}): Promise<DirectTool> {
	const tools: Record<string, { execute: Function }> = {};
	const handlers: Record<string, Function[]> = {};
	const warnings: string[] = [];
	const api = {
		on: (event: string, h: Function) => (handlers[event] ??= []).push(h),
		registerTool: (t: { name: string; execute: Function }) => (tools[t.name] = t),
		registerCommand: () => {},
		getCommands: () => [],
		registerFlag: () => {},
		getFlag: () => undefined,
		sendMessage: () => {},
		getSettings: () => ({
			subagent: { ...PINNED.subagent, piCommand: PI, ...options.settings },
		}),
	};
	subagent(api as unknown as Parameters<typeof subagent>[0]);
	const sessionDir = mkdtempSync(join(tmpdir(), "subagent-eval-sessions-"));
	const sessionId = `eval-${Date.now().toString(36)}`;
	const ctx = {
		cwd,
		hasUI: true,
		isIdle: () => true,
		ui: {
			notify: (m: string) => warnings.push(m),
			setWidget: () => {},
			onTerminalInput: () => () => {},
			custom: async () => {},
		},
		model: options.parentModel ?? { provider: "anthropic", id: "claude-haiku-5-5" },
		thinkingLevel: "low",
		isProjectTrusted: () => true,
		sessionManager: { getSessionFile: () => join(sessionDir, `${sessionId}.jsonl`), getSessionId: () => sessionId },
	};
	for (const h of handlers.session_start ?? []) await h({ reason: "startup" }, ctx);
	const tool = tools.Agent;
	if (!tool) throw new Error("Agent tool was not registered");
	return {
		sessionDir,
		sessionId,
		warnings,
		call: async (params) => {
			const r = await tool.execute("eval", { description: "eval task", ...params }, signal, undefined, ctx);
			return r.structuredContent as AgentResult;
		},
	};
}

export interface ParentRun {
	text: string; // the parent's last assistant text
	tools: string[]; // tool names started, in order (nested codemode calls included)
	cost: number; // parent + every child session under the session dir
	models: string[]; // "provider/model" of every assistant message there, parent and children
	sessionDir: string;
	timedOut: boolean;
	code: number | null;
}

// A real parent pi on haiku: codemode plus this checkout only (no installed extensions, so no double registration).
// The fixture's .pi/settings.json pins the children's default to haiku whatever the user's settings say; --approve
// lets pi read it.
export function runParent(cwd: string, prompt: string, signal: AbortSignal, timeoutMs = 240_000): Promise<ParentRun> {
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify(PINNED));
	const sessionDir = mkdtempSync(join(tmpdir(), "subagent-eval-parent-"));
	const args = [
		"--model",
		HAIKU,
		"--thinking",
		"low",
		"--approve",
		"--tools",
		"+codemode",
		"--session-dir",
		sessionDir,
		"--mode",
		"json",
		"-p",
		"--",
		prompt,
	];
	return new Promise((done) => {
		const child = spawn(PI, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		let timedOut = false;
		child.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
		child.stderr.on("data", () => {});
		const kill = () => child.kill("SIGKILL");
		signal.addEventListener("abort", kill, { once: true });
		const timer = setTimeout(() => {
			timedOut = true;
			kill();
		}, timeoutMs);
		child.on("close", (code) => {
			clearTimeout(timer);
			signal.removeEventListener("abort", kill);
			let text = "";
			const tools: string[] = [];
			for (const line of out.split("\n")) {
				if (!line.startsWith("{")) continue;
				const e = JSON.parse(line);
				if (e.type === "tool_execution_start") tools.push(e.toolName);
				if (e.type === "message_end" && e.message?.role === "assistant") {
					const t = e.message.content
						.filter((c: { type: string }) => c.type === "text")
						.map((c: { text: string }) => c.text)
						.join("");
					if (t.trim()) text = t;
				}
			}
			done({ text, tools, ...sessionUsage(sessionDir), sessionDir, timedOut, code });
		});
	});
}

export interface RpcEvent {
	type: string;
	at: number; // ms since the parent started
	[k: string]: any;
}

export interface RpcParentRun {
	events: RpcEvent[];
	cost: number;
	models: string[];
	timedOut: boolean;
}

export const messageText = (m: any): string =>
	typeof m?.content === "string"
		? m.content
		: (m?.content ?? [])
				.filter((c: any) => c.type === "text")
				.map((c: any) => c.text)
				.join("");

// Like runParent, but a long-lived `pi --mode rpc` parent, so background work can outlive main's first turn (print
// mode exits when the turn ends). Sends one prompt and collects events until `done(events)` or the timeout; then kills pi.
export function runRpcParent(
	cwd: string,
	prompt: string,
	done: (events: RpcEvent[]) => boolean,
	signal: AbortSignal,
	timeoutMs = 240_000,
): Promise<RpcParentRun> {
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify(PINNED));
	const sessionDir = mkdtempSync(join(tmpdir(), "subagent-eval-parent-"));
	const args = [
		"--mode",
		"rpc",
		"--model",
		HAIKU,
		"--thinking",
		"low",
		"--approve",
		"--tools",
		"+codemode",
		"--session-dir",
		sessionDir,
	];
	return new Promise((resolveRun) => {
		const child = spawn(PI, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
		const t0 = Date.now();
		const events: RpcEvent[] = [];
		let buffer = "";
		let timedOut = false;
		let finished = false;
		const finish = () => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			child.kill("SIGKILL");
		};
		const timer = setTimeout(() => {
			timedOut = true;
			finish();
		}, timeoutMs);
		signal.addEventListener("abort", finish, { once: true });
		child.stderr.on("data", () => {});
		child.stdout.on("data", (c: Buffer) => {
			buffer += c.toString("utf8");
			for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
				const line = buffer.slice(0, i);
				buffer = buffer.slice(i + 1);
				if (line.startsWith("{")) events.push({ ...JSON.parse(line), at: Date.now() - t0 });
			}
			if (!finished && done(events)) finish();
		});
		child.on("close", () => {
			finish();
			resolveRun({ events, timedOut, ...sessionUsage(sessionDir) });
		});
		child.stdin.write(`${JSON.stringify({ type: "prompt", message: prompt })}\n`);
	});
}

// Cost and models of every assistant message in every session file below a directory.
export function sessionUsage(dir: string): { cost: number; models: string[] } {
	let cost = 0;
	const models: string[] = [];
	const walk = (d: string) => {
		for (const e of readdirSync(d)) {
			const p = join(d, e);
			if (statSync(p).isDirectory()) walk(p);
			else if (p.endsWith(".jsonl")) {
				for (const line of readFileSync(p, "utf8").split("\n")) {
					if (!line.trim()) continue;
					const m = JSON.parse(line).message;
					if (m?.role !== "assistant") continue;
					cost += m.usage.cost.total;
					models.push(`${m.provider}/${m.model}`);
				}
			}
		}
	};
	if (existsSync(dir)) walk(dir);
	return { cost, models };
}

// The subagent meta files the parent's children wrote: { agentId: agentType }.
export function childAgents(parentSessionDir: string): Record<string, string> {
	const found: Record<string, string> = {};
	const root = join(parentSessionDir, "subagents");
	if (!existsSync(root)) return found;
	for (const parent of readdirSync(root)) {
		for (const f of readdirSync(join(root, parent))) {
			if (f.endsWith(".json"))
				found[f.slice(0, -5)] = JSON.parse(readFileSync(join(root, parent, f), "utf8")).agentType;
		}
	}
	return found;
}

export interface Check {
	name: string;
	pass: boolean;
	detail?: string;
}

export interface CaseOutcome {
	checks: Check[];
	cost: number;
	notes?: string;
}

export interface EvalCase {
	name: string;
	kind: "direct" | "parent";
	run(signal: AbortSignal): Promise<CaseOutcome>;
}

export const check = (name: string, pass: boolean, detail?: unknown): Check => ({
	name,
	pass,
	detail: pass ? undefined : typeof detail === "string" ? detail.slice(0, 300) : JSON.stringify(detail)?.slice(0, 300),
});

// Every result ran on haiku.
export const onHaiku = (...rs: AgentResult[]) =>
	check(
		"on haiku",
		rs.every((r) => r.model === HAIKU),
		rs.map((r) => r.model),
	);

// Every assistant message of the parent and its children was haiku (and there were some).
export const parentOnHaiku = (models: string[]) =>
	check("parent and children on haiku", models.length > 0 && models.every((m) => m === HAIKU), [...new Set(models)]);

export const costOf = (...rs: AgentResult[]) => rs.reduce((s, r) => s + r.usage.cost.total, 0);
