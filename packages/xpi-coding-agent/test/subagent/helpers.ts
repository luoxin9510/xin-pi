import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beginCodemodeScript } from "../../src/extensions/codemode/scripts.ts";
import subagent from "../../src/extensions/subagent/index.ts";

export const FAKE_PI = fileURLToPath(new URL("./fake-pi.mjs", import.meta.url));

export const usage = (input: number, output: number, cost: number) => ({
	input,
	output,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: input + output,
	cost: { input: cost / 2, output: cost / 2, cacheRead: 0, cacheWrite: 0, total: cost },
});

export const ev = {
	session: () =>
		JSON.stringify({ type: "session", version: 3, id: "child", timestamp: "2026-11-07T00:00:00Z", cwd: "/x" }),
	assistant: (text: string, u = usage(10, 5, 0.01), extra: Record<string, unknown> = {}) =>
		JSON.stringify({
			type: "message_end",
			message: {
				role: "assistant",
				content: text ? [{ type: "text", text }] : [],
				usage: u,
				stopReason: "stop",
				...extra,
			},
		}),
	user: (text: string) => JSON.stringify({ type: "message_end", message: { role: "user", content: text } }),
	tool: (name: string) => JSON.stringify({ type: "tool_execution_start", toolCallId: "c", toolName: name, args: {} }),
	toolEnd: (name: string, details: unknown, isError = false, text = isError ? "Validation failed" : "ok") =>
		JSON.stringify({
			type: "tool_execution_end",
			toolCallId: "c",
			toolName: name,
			result: { content: [{ type: "text", text }], details },
			isError,
		}),
	turnEnd: (message: Record<string, unknown> = {}) => JSON.stringify({ type: "turn_end", message, toolResults: [] }),
	settled: () => JSON.stringify({ type: "agent_settled", aborted: false }),
};

export const happyLines = (text = "done") => [ev.session(), ev.assistant(text), ev.turnEnd(), ev.settled()];

export interface Scenario {
	lines: string[];
	exitCode?: number;
	stderr?: string;
	delayMs?: number;
	hang?: boolean;
	sessionFile?: string;
	promptError?: string; // answer the prompt command with success: false
	abortSettles?: boolean; // answer an rpc abort with agent_settled aborted: true
	writeFile?: string; // create this file in the child's cwd when the prompt arrives
	logFile?: string; // append "start" at process start and "line <n>" before each line
	hold?: { line: number; starts: number }; // before that line, wait (at most 4 s) until the log has that many "start"
	reply?: string[]; // stay up after `lines` and play these on a second prompt
}

// A temp repo (with .git) and a temp HOME, so discovery never sees the real user dirs.
export function sandbox() {
	const root = mkdtempSync(join(tmpdir(), "subagent-test-"));
	const repo = join(root, "repo");
	const home = join(root, "home");
	mkdirSync(join(repo, ".git"), { recursive: true });
	mkdirSync(home, { recursive: true });
	process.env.HOME = home;
	const scenarioFile = join(root, "scenario.json");
	const recordFile = join(root, "record.json");
	process.env.FAKE_PI_SCENARIO = scenarioFile;
	process.env.FAKE_PI_RECORD = recordFile;
	return {
		root,
		repo,
		home,
		write(path: string, text: string) {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, text);
		},
		scenario(s: Scenario) {
			writeFileSync(scenarioFile, JSON.stringify(s));
		},
		record(): {
			argv: string[];
			depth?: string;
			commands: { type: string; message?: string }[];
			cwd: string;
			systemPrompt?: string;
			systemPromptTail?: string;
			schema?: string;
		} {
			return JSON.parse(readFileSync(recordFile, "utf8"));
		},
	};
}

// Turn a directory into a real repository with one commit (a file `a.txt`); replaces the empty `.git` the sandboxes make.
export function initRepo(dir: string): string {
	mkdirSync(dir, { recursive: true });
	rmSync(join(dir, ".git"), { recursive: true, force: true });
	const run = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
	run("init", "-q", "-b", "main");
	run("config", "user.name", "Test");
	run("config", "user.email", "test@example.com");
	run("config", "commit.gpgsign", "false");
	writeFileSync(join(dir, "a.txt"), "a\n");
	run("add", "a.txt");
	run("commit", "-q", "-m", "first");
	return dir;
}

export function agentFile(fields: string, body = "You are a test agent.") {
	return `---\n${fields}\n---\n${body}\n`;
}

interface FakeCtx {
	cwd: string;
	model?: { provider: string; id: string };
	thinkingLevel?: string;
	trusted?: boolean;
	hasUI?: boolean;
	sessionFile?: string;
	sessionId?: string;
	sendThrows?: string; // pi.sendMessage throws an error with this message
	notes?: string[]; // collects ui notifications even when loading throws
}

// Load the extension against a fake ExtensionAPI and return the registered Agent tool.
export async function loadTool(settings: Record<string, unknown>, c: FakeCtx) {
	const tools: Record<string, any> = {};
	const handlers: Record<string, Function[]> = {};
	const notes: string[] = c.notes ?? [];
	const messages: { message: any; options: any }[] = []; // pi.sendMessage calls: what main was sent
	const pi = {
		on: (event: string, h: Function) => (handlers[event] ??= []).push(h),
		registerTool: (t: any) => (tools[t.name] = t),
		registerCommand: () => {},
		sendMessage: (m: any, o: any) => {
			if (c.sendThrows) throw new Error(c.sendThrows);
			messages.push({ message: m, options: o });
		},
		getSettings: () => ({ subagent: { piCommand: FAKE_PI, ...settings } }),
	};
	subagent(pi as any);
	const ctx = {
		cwd: c.cwd,
		hasUI: c.hasUI ?? true,
		isIdle: () => true,
		ui: {
			notify: (m: string) => notes.push(m),
			setWidget: () => {},
			onTerminalInput: () => () => {},
			custom: async () => {},
		},
		model: "model" in c ? c.model : { provider: "anthropic", id: "claude-opus-5-5" },
		thinkingLevel: c.thinkingLevel ?? "medium",
		isProjectTrusted: () => c.trusted ?? true,
		sessionManager: {
			getSessionFile: () => c.sessionFile,
			getSessionId: () => c.sessionId ?? "parent-id",
		},
	};
	for (const h of handlers.session_start ?? []) await h({ reason: "startup" }, ctx);
	const tool = tools.Agent;
	const updates: string[] = [];
	return {
		tool,
		ctx,
		emit: async (event: string, payload: object) => {
			for (const h of handlers[event] ?? []) await h(payload, ctx);
		},
		notes,
		messages,
		updates,
		registered: tool !== undefined,
		run: (params: Record<string, unknown>, signal?: AbortSignal) =>
			tool.execute(
				"call-1",
				{ description: "test task", prompt: "do it", ...params },
				signal,
				(u: any) => updates.push(u.content[0].text),
				ctx,
			),
	};
}

export const flag = (args: string[], name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

// A stand-in for the `codemode` tool on the real script controller (`beginCodemodeScript`), the way `executeCodemode`
// drives it: the script is a JS function a test passes in; its Agent calls use nested ids "<codemode id>/<n>" like
// codemode's sandbox. The extension under test (loaded by `loadTool`) follows the controller itself and sends the
// end of a background script to main, so `delivered` reads it off `t.messages`.
export type StandInScript = (c: {
	id: string;
	signal: AbortSignal;
	agent: (extra?: Record<string, unknown>) => Promise<any>;
}) => Promise<string>;

export function codemodeStandIn(t: Awaited<ReturnType<typeof loadTool>>) {
	const sessionId = t.ctx.sessionManager.getSessionId();
	return {
		get delivered(): string[] {
			return t.messages.map((m) => m.message.content as string).filter((c) => c.startsWith("Background script"));
		},
		async run(id: string, script: StandInScript, signal?: AbortSignal, isError?: boolean) {
			const s = beginCodemodeScript(id, sessionId, signal);
			const agent = async (extra: Record<string, unknown> = {}) =>
				(await t.tool.execute(`${id}/1`, { description: "d", prompt: "p", ...extra }, s.signal, undefined, t.ctx))
					.structuredContent;
			const run = (async () => ({
				content: [{ type: "text", text: await script({ id, signal: s.signal, agent }) }],
				...(isError ? { isError: true } : {}),
			}))();
			const first = await Promise.race([
				run.then(
					() => "done" as const,
					() => "done" as const,
				),
				s.moved,
			]);
			if (first === "done") {
				try {
					const result = await run;
					s.end({ result: result as any });
					return result as any;
				} catch (error) {
					s.end({ error: error as Error });
					throw error;
				}
			}
			run.then(
				(result) => s.end({ result: result as any }),
				(error) => s.end({ error }),
			);
			return { content: [{ type: "text", text: first }], details: { background: true, scriptId: s.info.id } };
		},
	};
}
