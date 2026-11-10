// Harness for the real suite: the extension loaded in-process, children are the repo's pinned pi on real haiku.
// Each sandbox has its own repo, HOME and pi agent dir, so the user's setup (packages, settings, agents) never leaks in.
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentResult } from "../../../src/extensions/subagent/agent-tool.ts";
import subagent from "../../../src/extensions/subagent/index.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { copyUserAuth } from "../user-auth.ts";

initTheme("dark"); // the stub ui builds the subagent screen, whose components need pi's theme

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."); // the xpi-coding-agent package
// XPI_SUBAGENT_TEST_PI: run the suite against another build of xpi. The default is the built bundle (npm run build).
export const PI = process.env.XPI_SUBAGENT_TEST_PI ?? join(ROOT, "dist", "bundle", "cli.js");
export const HAIKU = "anthropic/claude-haiku-5-5";
const USER_AUTH = join(process.env.HOME ?? "", ".pi", "agent", "auth.json"); // read before any sandbox changes HOME

export const agentFile = (fields: string, body = "You are a test agent.") => `---\n${fields}\n---\n${body}\n`;
export const flag = (args: string[], name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

// Every real run's usage.cost.total is added here; a test file prints the sum when it ends.
let total = 0;
export const spent = () => total;
// XPI_SUBAGENT_COST_LOG=<file> npm test: each test file appends its total on exit, to measure the cost of a run.
if (process.env.XPI_SUBAGENT_COST_LOG)
	process.on("exit", () => appendFileSync(process.env.XPI_SUBAGENT_COST_LOG!, `${total}\n`));

export function sandbox() {
	const root = mkdtempSync(join(tmpdir(), "subagent-real-"));
	const repo = join(root, "repo");
	const home = join(root, "home");
	const agentDir = join(root, "pi-agent");
	mkdirSync(join(repo, ".git"), { recursive: true });
	mkdirSync(home, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	copyUserAuth(USER_AUTH, join(agentDir, "auth.json")); // a copy: nothing in the user agent dir is touched
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({
			defaultProvider: "anthropic",
			defaultModel: "claude-haiku-5-5",
			packages: [],
			quietStartup: true,
		}),
	);
	// Children inherit the environment of this process.
	process.env.HOME = home;
	process.env.XPI_CODING_AGENT_DIR = agentDir;
	process.env.XPI_SKIP_VERSION_CHECK = "1";
	process.env.XPI_TELEMETRY = "0";
	return {
		root,
		repo,
		home,
		agentDir,
		write(path: string, text: string) {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, text);
		},
	};
}

interface Ctx {
	cwd: string;
	model?: { provider: string; id: string };
	thinkingLevel?: string;
	trusted?: boolean;
	persist?: string; // dir for a persisted parent session (enables resume); omitted = in-memory parent
	notes?: string[];
	sessionId?: string; // reuse a parent session id: loading again with it simulates /reload or resuming the parent
	pick?: (options: string[]) => string | undefined; // answers ui.select
	models?: string[]; // "provider/id" list ctx.modelRegistry offers on a subagent screen's /model
	idle?: () => boolean; // main's state as ctx.isIdle() reports it; default idle
}

// The extension against a stub ExtensionAPI; the Agent tool is called directly. piCommand defaults to the pinned pi.
export async function loadTool(settings: Record<string, unknown>, c: Ctx) {
	const tools: Record<string, any> = {};
	const commands: Record<string, any> = {};
	const screens: string[] = []; // header line of each subagent screen opened
	const menus: { title: string; options: string[] }[] = [];
	const handlers: Record<string, Function[]> = {};
	const notes: string[] = c.notes ?? [];
	const messages: { message: any; options: any }[] = []; // pi.sendMessage calls: what main was sent, and how
	const components: any[] = []; // every subagent screen opened, kept alive
	let pickId: string | undefined;
	const pi = {
		on: (event: string, h: Function) => (handlers[event] ??= []).push(h),
		registerTool: (t: any) => (tools[t.name] = t),
		registerCommand: (name: string, c: any) => (commands[name] = c),
		getCommands: () => Object.keys(commands).map((name) => ({ name })),
		registerFlag: () => {},
		getFlag: () => undefined,
		sendMessage: (message: any, options: any) => messages.push({ message, options }),
		getSettings: () => ({ subagent: { piCommand: PI, ...settings } }),
	};
	subagent(pi as any);
	const sessionId = c.sessionId ?? `parent-${Math.random().toString(36).slice(2, 8)}`;
	const sessionFile = c.persist ? join(c.persist, `${sessionId}.jsonl`) : undefined;
	const ctx = {
		cwd: c.cwd,
		hasUI: true,
		ui: {
			notify: (m: string) => notes.push(m),
			setWidget: () => {},
			onTerminalInput: () => () => {},
			// Build the component like pi would (fake tui and theme), record what it draws, leave at once.
			custom: (factory: any) => {
				const theme = {
					fg: (_c: string, x: string) => x,
					bg: (_c: string, x: string) => x,
					bold: (x: string) => x,
				};
				const component = factory({ terminal: { rows: 24 }, requestRender() {} }, theme, {}, () => {});
				screens.push(component.render(100)[0]);
				components.push(component);
				return Promise.resolve();
			},
			select: async (title: string, options: string[]) => {
				menus.push({ title, options });
				return pickId ? options.find((o) => o.endsWith(pickId!)) : c.pick?.(options);
			},
		},
		modelRegistry: {
			getAvailable: () => (c.models ?? []).map((m) => ({ provider: m.split("/")[0], id: m.split("/")[1] })),
		},
		isIdle: () => c.idle?.() ?? true,
		model: "model" in c ? c.model : { provider: "anthropic", id: "claude-haiku-5-5" },
		thinkingLevel: c.thinkingLevel ?? "off",
		isProjectTrusted: () => c.trusted ?? true,
		sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => sessionId },
	};
	for (const h of handlers.session_start ?? []) await h({ reason: "startup" }, ctx);
	const tool = tools.Agent;
	const updates: string[] = [];
	const self = {
		tool,
		tools,
		ctx,
		notes,
		updates,
		menus,
		screens,
		messages,
		sessionId,
		// The user types a line on the subagent's screen (opened through /subagents) and presses Enter.
		async say(agentId: string, text: string) {
			pickId = agentId;
			await self.command("subagents");
			pickId = undefined;
			const screen = components.at(-1);
			for (const ch of text) screen.handleInput(ch);
			screen.handleInput("\r");
			return screen;
		},
		command: (name: string, args = "") => commands[name].handler(args, ctx),
		registered: tool !== undefined,
		sessionDir: sessionFile ? join(dirname(sessionFile), "subagents", sessionId) : undefined,
		async run(params: Record<string, unknown>, signal?: AbortSignal) {
			const res = await tool.execute(
				"call-1",
				{ description: "test task", prompt: "do it", ...params },
				signal,
				(u: any) => updates.push(u.content[0].text),
				ctx,
			);
			total += (res.structuredContent as AgentResult).usage.cost.total;
			return res;
		},
		async result(params: Record<string, unknown>, signal?: AbortSignal): Promise<AgentResult> {
			return (await self.run(params, signal)).structuredContent as AgentResult;
		},
	};
	return self;
}

// ---- reading a child's session file ----
export interface SessionEntry {
	type: string;
	[k: string]: any;
}

export function sessionEntries(dir: string, agentId: string): SessionEntry[] {
	const file = readdirSync(dir).find((f) => f.endsWith(".jsonl") && f.includes(agentId));
	if (!file) throw new Error(`no session file for ${agentId} in ${dir}: ${readdirSync(dir)}`);
	return readFileSync(join(dir, file), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));
}

export const assistantMessages = (entries: SessionEntry[]) =>
	entries.filter((e) => e.type === "message" && e.message.role === "assistant").map((e) => e.message);

// What the child was started with, as pi recorded it in the session: model, thinking level, active tools, system prompt.
export function childSetup(dir: string, agentId: string) {
	const entries = sessionEntries(dir, agentId);
	const sys = entries.find((e) => e.type === "message" && e.message.role === "system")!.message;
	const model = entries.find((e) => e.type === "model_change")!;
	return {
		entries,
		model: `${model.provider}/${model.modelId}`,
		thinking: entries.filter((e) => e.type === "thinking_level_change").at(-1)!.thinkingLevel as string,
		tools: (sys.toolsAdded as { name: string }[]).map((t) => t.name).sort(),
		// The shared head (the same for every agent type; the codemode line when the child has codemode) and the
		// agent's own part, which the child puts last as <instructions>: body, preloaded skills, environment block.
		head: sys.sections.preamble as string,
		prompt: (sys.sections.instructions as string).replace(/^<instructions>\n|\n<\/instructions>$/g, ""),
		hasContextFiles: "project_context" in sys.sections,
	};
}

export const REPLY_OK = "Reply with the single word OK. Do not call any tool.";

// Names of the tools the child called, in order.
export function toolCalls(entries: SessionEntry[]): string[] {
	return assistantMessages(entries).flatMap((m) =>
		(m.content as any[]).filter((c) => c.type === "toolCall").map((c) => c.name as string),
	);
}
