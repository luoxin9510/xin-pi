// builtin:roost, the worker role wired to a fake xpi (its events) and a fake daemon (a socket server): what it reports,
// how a reply reaches the session and is acked, the recap on attach, the commands for the hub's peek. Ported from
// pi-roost's worker-wiring.test.ts, with the reports and replies added.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getKeybindings, setKeybindings } from "xpi-tui";
import { encodeLine, LineReader } from "../../xpi-roost/src/lib/protocol.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { registerWorker } from "../src/extensions/roost/worker.ts";

type Handler = (event: any, ctx?: any) => unknown;

const ENV = ["ROOST_JOB_DIR", "ROOST_HOME", "ROOST_AGENT_DIR", "ROOST_RUNTIME_DIR", "ROOST_JOB_TOKEN", "ROOST_RESTORE"];
const saved: Record<string, string | undefined> = {};
let dir: string;
beforeEach(() => {
	for (const k of ENV) {
		saved[k] = process.env[k];
		delete process.env[k];
	}
	dir = mkdtempSync(join(tmpdir(), "xroost-ww-"));
	process.env.ROOST_JOB_DIR = dir;
	process.env.ROOST_HOME = dir;
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

function fakePi(commands: unknown[] = []) {
	const handlers = new Map<string, Handler[]>();
	const entries: { type: string; data: any }[] = [];
	const sent: { text: string; opts: unknown }[] = [];
	const pi = {
		on: (name: string, h: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), h]),
		registerCommand() {},
		registerEntryRenderer() {},
		registerMessageRenderer() {},
		getThinkingLevel: () => "off",
		appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
		setSessionName() {},
		sendUserMessage: async (text: string, opts: unknown) => {
			sent.push({ text, opts });
		},
		getFlag: () => undefined,
		getSettings: () => ({}),
		getCommands: (): unknown[] => commands,
	};
	const emit = async (name: string, event: any = {}, ctx?: any) => {
		for (const h of handlers.get(name) ?? []) await h(event, ctx);
	};
	return { pi: pi as any, emit, entries, sent };
}

const ctxOf = (state: { idle: boolean } = { idle: true }) => ({
	hasUI: false,
	cwd: dir,
	model: { provider: "faux", id: "m1" },
	isIdle: () => state.idle,
	getContextUsage: () => ({ tokens: 1000, contextWindow: 100_000, percent: 1 }),
	modelRegistry: { isUsingOAuth: () => false, getProvider: () => undefined, find: () => undefined },
	sessionManager: {
		getSessionName: () => undefined,
		getBranch: () => [],
		getEntries: () => [],
		getSessionFile: () => undefined,
	},
	ui: { notify() {} },
});

/** A daemon that answers every request, records them, and can push replies. */
async function fakeDaemon(): Promise<{
	socket: string;
	requests: { op: string; args: any }[];
	push: (event: unknown) => void;
	close: () => Promise<void>;
}> {
	const socket = join(dir, "d.sock");
	const requests: { op: string; args: any }[] = [];
	const conns = new Set<Socket>();
	const server: Server = createServer((s) => {
		conns.add(s);
		s.on("close", () => conns.delete(s));
		s.on("error", () => {});
		const reader = new LineReader();
		s.on("data", (chunk) => {
			for (const line of reader.push(chunk)) {
				const msg = JSON.parse(line);
				requests.push({ op: msg.op, args: msg.args });
				const result =
					msg.op === "hello" ? { protocol: 1, daemon: { name: "roost", version: "x" }, capabilities: [] } : {};
				s.write(encodeLine({ id: msg.id, ok: true, result }));
			}
		});
	});
	await new Promise<void>((r) => server.listen(socket, () => r()));
	return {
		socket,
		requests,
		push: (event) => {
			for (const c of conns) c.write(encodeLine(event as never));
		},
		close: () =>
			new Promise<void>((r) => {
				for (const c of conns) c.destroy();
				server.close(() => r());
			}),
	};
}

const waitFor = async <T>(fn: () => T | undefined | false, ms = 3000): Promise<T> => {
	const start = Date.now();
	for (;;) {
		const v = fn();
		if (v) return v;
		if (Date.now() - start > ms) throw new Error("waitFor timed out");
		await new Promise((r) => setTimeout(r, 10));
	}
};

describe("worker wiring", () => {
	it("says hello as xpi, reports state, context and model with attachSignal, and hands a reply to xpi, then acks it", async () => {
		const daemon = await fakeDaemon();
		const { pi, emit, sent } = fakePi();
		process.env.ROOST_JOB_TOKEN = "t";
		expect(registerWorker(pi, { job: { id: "j1", token: "t", socket: daemon.socket }, reportIntervalMs: 20 })).toBe(
			true,
		);
		// the token does not reach the commands the agent runs
		expect(process.env.ROOST_JOB_TOKEN).toBeUndefined();
		const state = { idle: true };
		const ctx = ctxOf(state);
		try {
			await emit("session_start", { reason: "startup" }, ctx);
			const report = await waitFor(() => daemon.requests.find((r) => r.op === "report"));
			expect(daemon.requests[0]).toMatchObject({ op: "hello", args: { agent: { name: "xpi" } } });
			expect(report.args).toMatchObject({ id: "j1", token: "t" });
			expect(report.args.report).toMatchObject({
				model: "faux/m1",
				thinking: "off",
				context: { tokens: 1000, window: 100_000, percent: 1 },
				attachSignal: true,
			});

			// a reply while idle starts a turn and is acked
			daemon.push({ event: "deliver", id: "j1", seq: 1, text: "run the tests" });
			await waitFor(() => sent.length === 1);
			expect(sent[0]).toEqual({ text: "run the tests", opts: { expandPromptTemplates: true } });
			await waitFor(() => daemon.requests.find((r) => r.op === "ack"));
			expect(daemon.requests.find((r) => r.op === "ack")!.args).toEqual({ id: "j1", token: "t", seq: 1 });
			// another job's reply is not this session's
			daemon.push({ event: "deliver", id: "other", seq: 2, text: "nope" });

			// working: the state goes out; a steering reply joins the turn
			state.idle = false;
			await emit("agent_start", {}, ctx);
			await waitFor(() => daemon.requests.some((r) => r.op === "report" && r.args.report.state === "working"));
			daemon.push({ event: "deliver", id: "j1", seq: 3, text: "use pnpm", mode: "steer" });
			await waitFor(() => sent.length === 2);
			expect(sent[1]).toEqual({ text: "use pnpm", opts: { deliverAs: "steer", expandPromptTemplates: true } });

			// the turn ends: done
			await emit(
				"message_end",
				{ message: { role: "assistant", content: [{ type: "text", text: "All green." }], stopReason: "stop" } },
				ctx,
			);
			state.idle = true;
			await emit("agent_settled", { aborted: false }, ctx);
			const done = await waitFor(() =>
				daemon.requests.find((r) => r.op === "report" && r.args.report.state === "done"),
			);
			expect(done.args.report.summary).toContain("All green.");
			expect(sent.map((s) => s.text)).not.toContain("nope");
		} finally {
			await emit("session_shutdown", {}, ctx);
			await daemon.close();
		}
	});

	it("the recap sees the tracker's settled state of the same event (questions, tools)", async () => {
		const { pi, emit, entries } = fakePi();
		registerWorker(pi, { job: { id: "j1", token: "t", socket: join(dir, "no-daemon.sock") } });
		const ctx = ctxOf();
		await emit("session_start", { reason: "startup" }, ctx);
		await emit("agent_start");
		await emit("tool_execution_start", { toolName: "bash" }, ctx);
		await emit("tool_execution_end", { toolName: "bash" });
		await emit(
			"message_end",
			{ message: { role: "assistant", content: [{ type: "text", text: "Tabs or spaces?" }], stopReason: "stop" } },
			ctx,
		);
		await emit("agent_settled", { aborted: false }, ctx);
		writeFileSync(join(dir, "attached.json"), JSON.stringify({ attached: true }));
		process.emit("SIGUSR2" as never);
		await new Promise((r) => setTimeout(r, 20));
		expect(entries).toHaveLength(1);
		expect(entries[0]!.type).toBe("roost-recap");
		expect(entries[0]!.data.text).toBe("1 turn finished · tools: bash · asked: Tabs or spaces?");
		// attached already: the next signal (a takeover) does not repeat it
		process.emit("SIGUSR2" as never);
		await new Promise((r) => setTimeout(r, 20));
		expect(entries).toHaveLength(1);
		await emit("session_shutdown");
	});

	it("M61: session_start writes the session's commands to commands.json, bounded, and never breaks the worker", async () => {
		const many = Array.from({ length: 400 }, (_, i) => ({
			name: `c${i}`,
			description: i === 0 ? `${"long ".repeat(100)}\nsecond line` : "d",
			source: "extension",
			sourceInfo: {},
		}));
		const { pi, emit } = fakePi(many);
		registerWorker(pi, { job: { id: "j2", token: "t", socket: join(dir, "no-daemon.sock") } });
		mkdirSync(join(dir, "jobs", "j2"), { recursive: true });
		const ctx = ctxOf();
		await emit("session_start", { reason: "startup" }, ctx);
		const list = JSON.parse(readFileSync(join(dir, "jobs", "j2", "commands.json"), "utf8")) as {
			name: string;
			description?: string;
			source: string;
		}[];
		expect(list).toHaveLength(300);
		expect(list[0]!.description!.length).toBeLessThanOrEqual(200);
		expect(list[0]!.description).not.toContain("\n");
		expect(list[1]).toEqual({ name: "c1", description: "d", source: "extension" });
		await emit("session_shutdown");
		// getCommands throwing, or no job directory: the worker carries on
		const bad = fakePi();
		bad.pi.getCommands = () => {
			throw new Error("boom");
		};
		registerWorker(bad.pi, { job: { id: "j3", token: "t", socket: join(dir, "no-daemon.sock") } });
		await expect(bad.emit("session_start", { reason: "startup" }, ctx)).resolves.toBeUndefined();
		expect(existsSync(join(dir, "jobs", "j3", "commands.json"))).toBe(false);
		await bad.emit("session_shutdown");
	});

	it("without a job identity it registers nothing", () => {
		const { pi } = fakePi();
		let registered = 0;
		pi.on = () => registered++;
		expect(registerWorker(pi)).toBe(false);
		expect(registered).toBe(0);
	});

	it("an attached session's keys: the user's keybindings detach, a dialog keeps all but app.suspend", async () => {
		const before = getKeybindings();
		setKeybindings(new KeybindingsManager({ "app.suspend": "ctrl+b" }));
		const { pi, emit } = fakePi();
		let detached = 0;
		registerWorker(pi, {
			job: { id: "j4", token: "t", socket: join(dir, "no-daemon.sock") },
			detach: () => detached++,
		});
		let input: ((data: string) => { consume?: boolean } | undefined) | undefined;
		let unsubscribed = false;
		const ctx = {
			...ctxOf(),
			hasUI: true,
			ui: {
				notify() {},
				setWidget() {},
				getEditorText: () => "",
				setEditorText() {},
				onTerminalInput: (h: typeof input) => {
					input = h;
					return () => {
						unsubscribed = true;
					};
				},
			},
		};
		try {
			await emit("session_start", { reason: "startup" }, ctx);
			expect(input!("\x1a")).toBeUndefined();
			expect(input!("\x02")).toEqual({ consume: true });
			await emit("ui_prompt_start", { kind: "select", title: "Pick" });
			expect(input!("\x1b[D")).toBeUndefined();
			expect(input!("\x02")).toEqual({ consume: true });
			await emit("ui_prompt_end", { kind: "select" });
			expect(input!("\x1b[D")).toEqual({ consume: true });
			expect(detached).toBe(3);
		} finally {
			await emit("session_shutdown");
			setKeybindings(before);
		}
		expect(unsubscribed).toBe(true);
	});
});
