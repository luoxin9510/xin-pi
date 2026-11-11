import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { visibleWidth } from "xpi-tui";
import { AgentView, type AgentViewOptions } from "../src/hub/agent-view.ts";
import type { DaemonClient } from "../src/lib/client.ts";
import type { Preset } from "../src/lib/config.ts";
import type { RoostEvent } from "../src/lib/events.ts";
import type { Event, JobRow } from "../src/lib/protocol.ts";
import { BUILTINS } from "./support/builtins.ts";

// The hub finds a session's host socket in the roost of ROOST_AGENT_DIR (xpi sets it for the hub's process): a
// temporary one here, so no test reaches the owner's.
let agentDir: string;
const savedAgentDir = process.env.ROOST_AGENT_DIR;
beforeAll(() => {
	agentDir = mkdtempSync(join(tmpdir(), "roost-hub-"));
	process.env.ROOST_AGENT_DIR = agentDir;
});
afterAll(() => {
	if (savedAgentDir === undefined) delete process.env.ROOST_AGENT_DIR;
	else process.env.ROOST_AGENT_DIR = savedAgentDir;
	rmSync(agentDir, { recursive: true, force: true });
});

let n = 0;
function row(over: Partial<JobRow> = {}): JobRow {
	n++;
	const now = Date.now();
	return {
		id: `id${n}`,
		cwd: "/w",
		kind: "pi",
		startedAt: now - 60_000,
		state: "working",
		pid: 100 + n,
		status: "busy",
		waitingFor: null,
		sessionFile: `/s/${n}.jsonl`,
		name: `job ${n}`,
		endedAt: null,
		summary: "running bash",
		question: null,
		choices: [],
		model: "p/m",
		thinking: null,
		context: null,
		error: null,
		stateSince: now - 30_000,
		reaped: false,
		pinned: false,
		order: null,
		orderKey: null,
		...over,
	};
}

class FakeClient {
	requests: { op: string; args: unknown }[] = [];
	events: ((e: Event) => void)[] = [];
	closes: (() => void)[] = [];
	closed = false;
	rows: JobRow[];
	dispatchDelay = 0;
	replyResult: unknown = { delivered: true, saved: false };
	/** M43: what /log shows. */
	log: RoostEvent[] = [];
	constructor(rows: JobRow[]) {
		this.rows = rows;
	}
	onEvent(l: (e: Event) => void) {
		this.events.push(l);
		return () => {
			this.events = this.events.filter((x) => x !== l);
		};
	}
	/** M22: events emitted so far (a fake place in the stream). */
	emitted = 0;
	position() {
		return this.emitted;
	}
	async requestAt(op: string, args: unknown): Promise<{ result: unknown; at: number }> {
		const result = await this.request(op, args);
		return { result, at: this.emitted };
	}
	onClose(l: () => void) {
		this.closes.push(l);
		return () => {};
	}
	close() {
		this.closed = true;
	}
	emit(e: Event) {
		this.emitted++;
		for (const l of [...this.events]) l(e);
	}
	/** M51: the request ids the hub sent (kept apart from the args the tests compare). */
	requestIds: { op: string; id: string }[] = [];
	async request(op: string, args: unknown): Promise<unknown> {
		if ((op === "reply" || op === "dispatch") && args && typeof args === "object" && "requestId" in args) {
			const { requestId, ...rest } = args as { requestId: string };
			this.requestIds.push({ op, id: requestId });
			args = rest;
		}
		this.requests.push({ op, args });
		if (op === "list") return { jobs: this.rows };
		if (op === "dispatch") {
			await new Promise((r) => setTimeout(r, this.dispatchDelay));
			return { id: "new1", name: "new task" };
		}
		if (op === "reply") return this.replyResult;
		// M48: a peek's commands
		if (op === "respawn") return { results: [{ id: (args as { id: string }).id, started: true }] };
		if (op === "rm") return { id: (args as { id: string }).id };
		if (op === "rename") return args;
		if (op === "pin") return { id: (args as { id: string }).id, pinned: (args as { pinned: boolean }).pinned };
		if (op === "events") return { events: this.log, cursor: this.log.length };
		return {};
	}
}

const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

const launches: { task: string; opts: unknown }[] = [];
function setup(
	rows: JobRow[],
	opts: {
		rowsHigh?: number;
		onGroupBy?: (g: string) => void;
		switchCheckMs?: number;
		extra?: Partial<AgentViewOptions>;
	} = {},
) {
	const client = new FakeClient(rows);
	let renders = 0;
	let doneCalls = 0;
	const tui = {
		terminal: { rows: opts.rowsHigh ?? 30, columns: 80 },
		requestRender: () => renders++,
		stop: () => {},
		start: () => {},
	};
	const view = new AgentView({
		tui: tui as never,
		theme: theme as never,
		cwd: "/w",
		launch: (task, o) => {
			launches.push({ task, opts: o });
			return {
				cwd: "/w",
				sessionFile: "/s/x.jsonl",
				command: ["pi", task],
				env: {},
				name: task,
				origin: "dispatch",
			};
		},
		launchShell: (command, cwd) => ({
			kind: "shell",
			cwd,
			sessionFile: "",
			command: ["sh", "-lc", command],
			env: {},
			name: `! ${command}`,
			origin: "dispatch",
		}),
		commands: () => [{ name: "review", source: "prompt" }],
		models: () => ["a/one", "b/two"],
		setTitle: () => {},
		connect: async () => client as unknown as DaemonClient,
		isDetachKey: (key) => key === "\x1a",
		detachKeyName: "ctrl+z",
		builtins: () => BUILTINS,
		done: () => doneCalls++,
		reducedMotion: true,
		onGroupBy: opts.onGroupBy,
		switchCheckMs: opts.switchCheckMs,
		...opts.extra,
	});
	return { view, client, renders: () => renders, done: () => doneCalls };
}

const type = (view: AgentView, text: string) => {
	for (const ch of text) view.handleInput(ch);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("AgentView render", () => {
	it("never renders a line wider than the terminal, whatever the content", async () => {
		const rows = [
			row({ name: "调查不稳定的复位测试用例并修复它", summary: "正在运行 bash：npm test -- --run 很长很长的输出" }),
			row({
				state: "failed",
				status: null,
				pid: null,
				error: "Error: boom\n    at x (/a/b.ts:1:2)\n\tat y\u001b[31m red",
				endedAt: Date.now(),
			}),
			row({
				state: "blocked",
				status: "waiting",
				waitingFor: "question",
				question: "Which reset?\nDouble or single?",
				choices: ["double-ended reset", "single-ended reset"],
			}),
			...Array.from({ length: 30 }, () => row({ state: "done", status: "idle" })),
		];
		const { view } = setup(rows, { rowsHigh: 12 });
		await view.start();
		for (const width of [1, 5, 10, 30, 52, 60, 120]) {
			for (const peek of [false, true]) {
				const lines = view.render(width);
				for (const l of lines)
					expect(visibleWidth(l), `width ${width}: ${JSON.stringify(l)}`).toBeLessThanOrEqual(width);
				for (const l of lines) expect(l).not.toMatch(/[\n\r\t]/);
				if (!peek) view.handleInput(" ");
			}
			view.handleInput("\u001b"); // close peek
		}
		view.dispose();
	});

	it("shows every group header with a hint when there are no jobs", async () => {
		const { view } = setup([]);
		await view.start();
		const text = view.render(120).join("\n");
		for (const h of ["Pinned", "Needs input", "Working", "Completed"]) expect(text).toContain(h);
		expect(text).toContain("0 needs input · 0 working · 0 completed");
		view.dispose();
	});
});

describe("AgentView keys", () => {
	it("rejects short tasks and dispatches once on a double Enter", async () => {
		const { view, client } = setup([row()]);
		await view.start();
		type(view, "abc");
		view.handleInput("\r");
		expect(view.render(80).join("\n")).toContain("Too short");
		view.handleInput("\u0003"); // Ctrl+C clears
		client.dispatchDelay = 50;
		type(view, "fix the flaky reset test");
		view.handleInput("\r");
		view.handleInput("\r");
		await sleep(100);
		expect(client.requests.filter((r) => r.op === "dispatch")).toHaveLength(1);
		view.dispose();
	});

	it("a reply goes to the peeked row, and is refused once that row is gone", async () => {
		const a = row({
			state: "blocked",
			status: "waiting",
			waitingFor: "question",
			question: "A?",
			choices: ["yes", "no"],
		});
		const b = row();
		const { view, client } = setup([a, b]);
		await view.start();
		view.handleInput(" "); // peek the first row (needs input group)
		view.handleInput("2"); // fills choice 2
		view.handleInput("\r");
		await sleep(10);
		expect(client.requests.find((r) => r.op === "reply")?.args).toEqual({ id: a.id, text: "no", mode: "steer" });
		// M51: with a request id, so a resend after a lost answer is taken once
		expect(client.requestIds.find((r) => r.op === "reply")?.id).toMatch(/^hub\./);

		type(view, "late answer");
		client.emit({ event: "removed", id: a.id });
		view.render(80);
		view.handleInput("\r");
		await sleep(10);
		expect(client.requests.filter((r) => r.op === "reply")).toHaveLength(1);
		view.dispose();
	});

	it("Esc closes peek, then clears input, then exits; Ctrl+C twice exits", async () => {
		const { view, done } = setup([row()]);
		await view.start();
		view.handleInput(" ");
		view.handleInput("\u001b");
		type(view, "draft");
		view.handleInput("\u001b");
		expect(done()).toBe(0);
		view.handleInput("\u001b");
		expect(done()).toBe(1);
		view.handleInput("\u0003");
		view.handleInput("\u0003");
		expect(done()).toBe(2);
		view.dispose();
	});

	it("dispose before the daemon answers leaks no connection", async () => {
		const client = new FakeClient([]);
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const view = new AgentView({
			tui: { terminal: { rows: 30 }, requestRender: () => {}, stop: () => {}, start: () => {} } as never,
			theme: theme as never,
			cwd: "/w",
			launch: () => {
				throw new Error("unused");
			},
			setTitle: () => {},
			connect: async () => {
				await gate;
				return client as unknown as DaemonClient;
			},
			isDetachKey: () => false,
			done: () => {},
		});
		const started = view.start();
		view.dispose();
		release();
		await started;
		expect(client.closed).toBe(true);
	});
});

describe("AgentView organise (M6a)", () => {
	it("filters with s: n: o:, selects the first match, and Enter attaches rather than dispatching", async () => {
		const rows = [
			row({ id: "a", name: "fix login", state: "done", summary: "fixed the cookie bug" }),
			row({ id: "b", name: "docs pass", state: "working" }),
			row({ id: "c", name: "fix build", state: "blocked", question: "which node version?" }),
		];
		const { view, client } = setup(rows);
		await view.start();
		type(view, "n:fix s:done");
		let out = view.render(80).join("\n");
		expect(out).toContain("fix login");
		expect(out).not.toContain("fix build");
		expect(out).not.toContain("docs pass");
		expect(out).toContain("filtering");
		view.handleInput("\u0003");
		type(view, "o:node");
		out = view.render(80).join("\n");
		expect(out).toContain("fix build");
		expect(out).not.toContain("fix login");
		view.handleInput("\u0003");
		type(view, "n:zzz");
		expect(view.render(80).join("\n")).toContain("no sessions match");
		view.handleInput("\u0003");
		type(view, "o:node");
		view.handleInput("\r"); // attaches to the match (no host here), never dispatches
		await sleep(10);
		expect(client.requests.some((r) => r.op === "dispatch")).toBe(false);
		view.dispose();
	});

	it("Ctrl+S groups by directory and reports the choice; Ctrl+T pins; Ctrl+R renames; Shift+↓ reorders", async () => {
		const chosen: string[] = [];
		const rows = [row({ id: "a", name: "one", cwd: "/w/app" }), row({ id: "b", name: "two", cwd: "/w/lib" })];
		const { view, client } = setup(rows, { onGroupBy: (g) => chosen.push(g) });
		await view.start();
		view.handleInput("\x13"); // Ctrl+S
		expect(chosen).toEqual(["directory"]);
		const out = view.render(80).join("\n");
		expect(out).toContain("/w/app");
		expect(out).toContain("/w/lib");
		view.handleInput("\x14"); // Ctrl+T on the selected row
		await sleep(10);
		expect(client.requests.find((r) => r.op === "pin")?.args).toMatchObject({ pinned: true });
		view.handleInput("\x12"); // Ctrl+R
		for (let i = 0; i < 10; i++) view.handleInput("\x7f");
		type(view, "renamed");
		view.handleInput("\r");
		await sleep(10);
		expect(client.requests.find((r) => r.op === "rename")?.args).toMatchObject({ name: "renamed" });
		view.handleInput("\x13"); // back to state groups: both in Working
		view.handleInput("\x1b[1;2B"); // Shift+↓
		await sleep(10);
		expect((client.requests.find((r) => r.op === "reorder")?.args as { ids: string[] }).ids).toHaveLength(2);
		view.dispose();
	});
});

describe("AgentView dispatch (M6b)", () => {
	it("/model and /thinking set defaults for new sessions; pickers when bare", async () => {
		launches.length = 0;
		const { view, client } = setup([row()]);
		await view.start();
		type(view, "/model b/two");
		view.handleInput("\r");
		type(view, "/thinking");
		view.handleInput("\r");
		expect(view.render(80).join("\n")).toContain("Thinking for new sessions");
		view.handleInput("\x1b[B"); // down: off
		view.handleInput("\x1b[B"); // minimal
		view.handleInput("\r");
		expect(view.render(80).join("\n")).toContain("new sessions: model b/two · thinking minimal");
		type(view, "write the changelog");
		view.handleInput("\r");
		await sleep(10);
		expect(launches.at(-1)).toMatchObject({
			task: "write the changelog",
			opts: { model: "b/two", thinking: "minimal" },
		});
		type(view, "/model default");
		view.handleInput("\r");
		expect(view.render(80).join("\n")).not.toContain("model b/two");
		expect(client.requests.filter((r) => r.op === "dispatch")).toHaveLength(1);
		view.dispose();
	});

	it("prompt templates dispatch; other commands are refused and keep the text; ! starts a shell job", async () => {
		launches.length = 0;
		const { view, client } = setup([row()]);
		await view.start();
		type(view, "/settings");
		view.handleInput("\r");
		const out = view.render(80).join("\n");
		expect(out).toContain("/settings isn't available in the hub");
		expect(out).toContain("/settings");
		view.handleInput("\u0003");
		type(view, "/review the parser");
		view.handleInput("\r");
		await sleep(10);
		expect(launches.at(-1)?.task).toBe("/review the parser");
		type(view, "! npm test");
		view.handleInput("\r");
		await sleep(10);
		const shell = client.requests.filter((r) => r.op === "dispatch").at(-1)?.args as {
			kind?: string;
			command: string[];
		};
		expect(shell.kind).toBe("shell");
		expect(shell.command).toEqual(["sh", "-lc", "npm test"]);
		view.dispose();
	});
});

describe("AgentView model and context (M8)", () => {
	it("rows show the model and context share while there is room; the peek shows all of it", async () => {
		const a = row({
			name: "fix login",
			model: "anthropic/claude-opus-5-5",
			thinking: "high",
			context: { tokens: 86_000, window: 200_000, percent: 43 },
		});
		const { view } = setup([a]);
		await view.start();
		const wide = view.render(100).find((l) => l.includes("fix login"))!;
		expect(wide).toContain("claude-opus-5-5 · 43%");
		expect(visibleWidth(wide)).toBeLessThanOrEqual(100);
		// narrow: the share alone, then nothing; the summary keeps its room
		const mid = view.render(64).find((l) => l.includes("fix login"))!;
		expect(mid).toContain("43%");
		expect(mid).not.toContain("claude-opus");
		const narrow = view.render(44).find((l) => l.includes("fix login"))!;
		expect(narrow).not.toContain("43%");
		view.handleInput(" "); // peek
		expect(view.render(100).join("\n")).toContain("anthropic/claude-opus-5-5 · thinking high · ctx 86k / 200k (43%)");
		view.dispose();
	});

	it("/model and /thinking in a peek switch that session (picker when bare) and never touch new-session defaults", async () => {
		const a = row({ name: "fix login", model: "a/one", thinking: "medium" });
		const { view, client } = setup([a]);
		await view.start();
		view.handleInput(" ");
		type(view, "/model");
		view.handleInput("\r");
		expect(view.render(80).join("\n")).toContain("Model for fix login");
		view.handleInput("\x1b[B"); // a/one → b/two
		view.handleInput("\r");
		await sleep(10);
		type(view, "/thinking low");
		view.handleInput("\r");
		await sleep(10);
		type(view, "/model nope/x");
		view.handleInput("\r");
		await sleep(10);
		const replies = client.requests.filter((r) => r.op === "reply").map((r) => r.args);
		expect(replies).toEqual([
			{ id: a.id, text: "/model b/two" },
			{ id: a.id, text: "/thinking low" },
		]);
		const screen = view.render(80).join("\n");
		expect(screen).toContain("unknown model nope/x");
		expect(screen).not.toContain("new sessions:");
		view.handleInput("\x03"); // a refused command stays in the input to be fixed: clear it
		type(view, "/model default");
		view.handleInput("\r");
		expect(view.render(80).join("\n")).toContain("a running session has no default model");
		expect(client.requests.filter((r) => r.op === "reply")).toHaveLength(2);
		view.dispose();
	});

	it("a switch is reported as asked, then confirmed by the session's report or flagged when it does not show", async () => {
		const a = row({ name: "fix login", model: "a/one", thinking: "high" });
		const { view, client } = setup([a], { switchCheckMs: 60 });
		await view.start();
		view.handleInput(" ");
		type(view, "/model b/two");
		view.handleInput("\r");
		await sleep(10);
		expect(view.render(80).join("\n")).toContain("asked fix login to use model b/two");
		client.emit({ event: "job", job: { ...a, model: "b/two" } });
		expect(view.render(80).join("\n")).toContain("fix login now uses model b/two (from its next request)");
		// pi lowers a level the model does not support
		type(view, "/thinking max");
		view.handleInput("\r");
		await sleep(10);
		client.emit({ event: "job", job: { ...a, model: "b/two", thinking: "xhigh" } });
		expect(view.render(80).join("\n")).toContain("fix login thinks xhigh: the closest its model supports to max");
		// no credentials in the worker: the row never changes; a /thinking meanwhile does not hide that
		type(view, "/model a/one");
		view.handleInput("\r");
		await sleep(10);
		type(view, "/thinking low");
		view.handleInput("\r");
		await sleep(10);
		client.emit({ event: "job", job: { ...a, model: "b/two", thinking: "low" } });
		expect(view.render(80).join("\n")).toContain("fix login now uses thinking low");
		await sleep(100);
		// short enough for 80 columns
		expect(view.render(80).join("\n")).toContain(
			"model switch failed (credentials? envAllowList): still two, not one",
		);
		view.dispose();
	});

	it("a second switch before the first shows: the first one's report is not the outcome", async () => {
		const a = row({ name: "fix login", model: "a/one" });
		const { view, client } = setup([a], { switchCheckMs: 5000 });
		await view.start();
		view.handleInput(" ");
		type(view, "/model b/two");
		view.handleInput("\r");
		await sleep(10);
		type(view, "/model a/one"); // back again, while b/two is still pending: not "already uses"
		view.handleInput("\r");
		await sleep(10);
		expect(client.requests.filter((r) => r.op === "reply")).toHaveLength(2);
		client.emit({ event: "job", job: { ...a, model: "b/two" } });
		expect(view.render(80).join("\n")).not.toContain("now uses");
		client.emit({ event: "job", job: { ...a, model: "a/one" } });
		expect(view.render(80).join("\n")).toContain("fix login now uses model a/one");
		view.dispose();
	});

	it("three switches in a row: only the last one's value is the outcome; the same switch twice confirms at once", async () => {
		const a = row({ name: "fix login", model: "p/a" });
		const { view, client } = setup([a], { switchCheckMs: 5000 });
		const models = ["p/a", "p/b", "p/c"];
		(view as any).o.models = () => models;
		await view.start();
		view.handleInput(" ");
		for (const m of ["p/b", "p/a", "p/c"]) {
			type(view, `/model ${m}`);
			view.handleInput("\r");
			await sleep(10);
		}
		for (const m of ["p/b", "p/a"]) {
			client.emit({ event: "job", job: { ...a, model: m } });
			expect(view.render(100).join("\n")).not.toContain("now uses");
		}
		client.emit({ event: "job", job: { ...a, model: "p/c" } });
		expect(view.render(100).join("\n")).toContain("fix login now uses model p/c");
		// the same switch twice: its report confirms it, no timer needed
		for (let i = 0; i < 2; i++) {
			type(view, "/model p/b");
			view.handleInput("\r");
			await sleep(10);
		}
		client.emit({ event: "job", job: { ...a, model: "p/b" } });
		expect(view.render(100).join("\n")).toContain("fix login now uses model p/b");
		view.dispose();
	});

	it("the peek footer fits 80 columns; a session that is starting, or gone, gets its own message", async () => {
		const a = row({ name: "fix login", model: "a/one" });
		const { view, client } = setup([a]);
		await view.start();
		view.handleInput(" ");
		expect(view.render(80).at(-1)).toContain("Esc close · ? keys");
		client.replyResult = { delivered: false, saved: false };
		type(view, "/model b/two");
		view.handleInput("\r");
		await sleep(10);
		expect(view.render(80).join("\n")).toContain("fix login is starting; try again in a moment");
		// the row goes while the picker is open
		client.replyResult = { delivered: true, saved: false };
		view.handleInput("\x03");
		type(view, "/model");
		view.handleInput("\r");
		client.emit({ event: "removed", id: a.id });
		view.handleInput("\r");
		await sleep(10);
		expect(view.render(80).join("\n")).toContain("that session no longer exists");
		expect(client.requests.filter((r) => r.op === "reply")).toHaveLength(1);
		view.dispose();
	});

	it("a shell row has no model to switch", async () => {
		const s = row({ name: "tests", kind: "shell", model: null });
		const { view, client } = setup([s]);
		await view.start();
		view.handleInput(" ");
		type(view, "/model a/one");
		view.handleInput("\r");
		await sleep(10);
		expect(view.render(80).join("\n")).toContain("a shell command has no model");
		expect(client.requests.some((r) => r.op === "reply")).toBe(false);
		view.dispose();
	});

	it("the column lines up across rows, whatever the model name or age", async () => {
		const now = Date.now();
		// working rows age from startedAt: "10m" and "5s" differ in width
		const a = row({
			name: "one",
			model: "anthropic/claude-haiku-5-5",
			context: { tokens: 1, window: 100, percent: 91 },
			startedAt: now - 600_000,
		});
		const b = row({
			name: "two",
			model: "x/模型很长的名字也要对齐",
			context: { tokens: 1, window: 100, percent: 4 },
			startedAt: now - 5_000,
		});
		const c = row({ name: "three", kind: "shell", model: null, startedAt: now - 5_000 });
		const { view } = setup([a, b, c]);
		await view.start();
		const lines = view.render(100);
		const ages = lines.filter((l) => /one|two/.test(l)).map((l) => l.trimEnd().split(" ").at(-1));
		expect(new Set(ages.map((x) => x?.length)).size).toBe(2); // the ages really differ in width
		// CJK is two columns wide: compare columns, not string indices
		const col = (name: string, s: string) => {
			const l = lines.find((x) => x.includes(name))!;
			return visibleWidth(l.slice(0, l.indexOf(s)));
		};
		expect(col("one", "91%")).toBe(col("two", " 4%"));
		expect(lines.find((l) => l.includes("three"))).not.toContain("%");
		for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(100);
		view.dispose();
	});

	it("rowDetails: false hides the column", async () => {
		const a = row({
			name: "fix login",
			model: "anthropic/claude-opus-5-5",
			context: { tokens: 1, window: 2, percent: 50 },
		});
		const client = new FakeClient([a]);
		const view = new AgentView({
			tui: {
				terminal: { rows: 30, columns: 100 },
				requestRender: () => {},
				stop: () => {},
				start: () => {},
			} as never,
			theme: theme as never,
			cwd: "/w",
			launch: () => ({ cwd: "/w", sessionFile: "/s", command: [], env: {}, name: "x", origin: "dispatch" }),
			setTitle: () => {},
			connect: async () => client as unknown as DaemonClient,
			isDetachKey: () => false,
			done: () => {},
			reducedMotion: true,
			rowDetails: false,
		});
		await view.start();
		expect(view.render(100).join("\n")).not.toContain("50%");
		view.dispose();
	});
});

describe("M17: the task input is pi's editor", () => {
	it("Shift+Enter adds a line, ↑↓ move in the text, a long paste folds and dispatches in full", async () => {
		launches.length = 0;
		const a = row({ name: "first job" });
		const b = row({ name: "second job" });
		const { view } = setup([a, b]);
		await view.start();
		type(view, "line one");
		view.handleInput("\x1b[13;2u"); // Shift+Enter (kitty)
		type(view, "line two");
		let text = view.render(80).join("\n");
		expect(text).toContain("line one");
		expect(text).toContain("line two");
		// ↑ on the second line stays in the text; the selection does not move
		const sel = () => view.render(80).find((l) => l.startsWith("›") && l.includes(" job"));
		const before = sel();
		view.handleInput("\x1b[A");
		expect(sel()).toBe(before);
		view.handleInput("\r");
		await sleep(20);
		expect(launches.at(-1)?.task).toBe("line one\nline two");
		// a long paste: a marker on screen, the whole text dispatched
		const long = Array.from({ length: 30 }, (_, i) => `pasted ${i}`).join("\n");
		view.handleInput(`\x1b[200~${long}\x1b[201~`);
		text = view.render(80).join("\n");
		expect(text).not.toContain("pasted 29");
		view.handleInput("\r");
		await sleep(20);
		expect(launches.at(-1)?.task).toBe(long);
		// Ctrl+J as a bare LF adds a line; a paste in pieces is not taken as keys
		type(view, "one");
		view.handleInput("\n");
		type(view, "two");
		view.handleInput("\x1b[200~");
		view.handleInput("\r");
		view.handleInput(" ?x");
		view.handleInput("\x1b[201~");
		view.handleInput("\r");
		await sleep(20);
		expect(launches.at(-1)?.task).toBe("one\ntwo\n ?x");
		view.dispose();
	});
});

describe("Ctrl+G", () => {
	it("writes the task in $EDITOR and dispatches all of its lines", async () => {
		launches.length = 0;
		const saved = { v: process.env.VISUAL, e: process.env.EDITOR };
		process.env.VISUAL = `sh -c 'printf "first line\\nsecond line\\n" > "$0"'`;
		const { view } = setup([row()]);
		await view.start();
		view.handleInput("\x07"); // Ctrl+G
		await sleep(300);
		// M17: the editor shows every line
		const shown = view.render(80).join("\n");
		expect(shown).toContain("first line");
		expect(shown).toContain("second line");
		view.handleInput("\r");
		await sleep(20);
		expect(launches.at(-1)?.task).toBe("first line\nsecond line");
		view.dispose();
		if (saved.v === undefined) delete process.env.VISUAL;
		else process.env.VISUAL = saved.v;
	});
});

describe("M23: /resume and models in the hub", () => {
	it("the model picker searches, shows the enabled models with Tab for all, and says what new sessions run", async () => {
		launches.length = 0;
		const { view } = setup([row()], {
			extra: {
				models: () => ["anthropic/claude-haiku-5-5", "anthropic/claude-opus-5-5", "openai/gpt-5"],
				scopedModels: () => ["anthropic/claude-opus-5-5", "openai/gpt-5"],
				defaultModel: () => "anthropic/claude-opus-5-5",
			},
		});
		await view.start();
		expect(view.render(100).join("\n")).toContain("new sessions: model anthropic/claude-opus-5-5 (default)");
		view.handleInput("\x0c"); // Ctrl+L
		let screen = view.render(100).join("\n");
		expect(screen).toContain("Model for new sessions · enabled models");
		expect(screen).not.toContain("claude-haiku");
		view.handleInput("\t"); // all models
		expect(view.render(100).join("\n")).toContain("· all models");
		type(view, "hai");
		screen = view.render(100).join("\n");
		expect(screen).toContain("search: hai");
		expect(screen).toContain("anthropic/claude-haiku-5-5");
		expect(screen).not.toContain("openai/gpt-5");
		view.handleInput("\r");
		expect(view.render(100).join("\n")).toContain("new sessions: model anthropic/claude-haiku-5-5");
		type(view, "summarise the log");
		view.handleInput("\r");
		await sleep(10);
		expect(launches.at(-1)).toMatchObject({ opts: { model: "anthropic/claude-haiku-5-5" } });
		view.dispose();
	});

	it("Ctrl+P and Shift+Ctrl+P cycle the enabled models; Shift+Tab the thinking level", async () => {
		const { view } = setup([row()], { extra: { scopedModels: () => ["a/one", "b/two"] } });
		await view.start();
		view.handleInput("\x10"); // Ctrl+P
		expect(view.render(100).join("\n")).toContain("new sessions: model a/one");
		view.handleInput("\x10");
		expect(view.render(100).join("\n")).toContain("new sessions: model b/two");
		view.handleInput("\x10");
		expect(view.render(100).join("\n")).toContain("new sessions: model a/one");
		view.handleInput("\x1b[112;6u"); // Shift+Ctrl+P (kitty)
		expect(view.render(100).join("\n")).toContain("new sessions: model b/two");
		view.handleInput("\x1b[Z"); // Shift+Tab
		expect(view.render(100).join("\n")).toContain("thinking off");
		view.dispose();
	});

	it("/resume shows pi's session list; picking one with no row starts it in the background and enters it", async () => {
		launches.length = 0;
		let keys = "";
		let picked: ((s: { path: string; name: string; cwd: string; modified: number }) => void) | undefined;
		const { view, client } = setup([row()], {
			extra: {
				sessionSelector: (o) => {
					picked = o.onSelect;
					return {
						render: () => ["PI SESSION LIST", "keys: enter select"],
						handleInput: (d) => {
							keys += d;
						},
					};
				},
			},
		});
		await view.start();
		type(view, "/resume");
		view.handleInput("\r");
		expect(view.render(100).join("\n")).toContain("PI SESSION LIST");
		type(view, "abc");
		expect(keys).toBe("abc"); // its keys go to it
		picked!({ path: "/s/old.jsonl", name: "old work", cwd: "/w/app", modified: Date.now() });
		await sleep(20);
		expect(view.render(100).join("\n")).not.toContain("PI SESSION LIST");
		expect(launches.at(-1)).toMatchObject({
			task: "",
			opts: { sessionFile: "/s/old.jsonl", cwd: "/w/app", origin: "adopt" },
		});
		expect(client.requests.some((r) => r.op === "dispatch")).toBe(true);
		expect(view.render(100).join("\n")).toContain("resuming");
		view.dispose();
	});

	it("/resume falls back to the view's own list when pi's cannot be built; an Esc closes pi's", async () => {
		const { view } = setup([row()], {
			extra: {
				sessionSelector: () => {
					throw new Error("no such export");
				},
				resumable: async () => [{ path: "/s/a.jsonl", name: "alpha", cwd: "/w", modified: Date.now() }],
			},
		});
		await view.start();
		type(view, "/resume");
		view.handleInput("\r");
		await sleep(20);
		const screen = view.render(100).join("\n");
		// the view's own list (its warning gives way to the list's own notices)
		expect(screen).toContain("Resume a session in the background");
		expect(screen).toContain("alpha");
		view.dispose();
		let cancel: (() => void) | undefined;
		const two = setup([row()], {
			extra: {
				sessionSelector: (o) => {
					cancel = o.onCancel;
					return { render: () => ["PI SESSION LIST"] };
				},
			},
		});
		await two.view.start();
		type(two.view, "/resume");
		two.view.handleInput("\r");
		cancel!();
		expect(two.view.render(100).join("\n")).not.toContain("PI SESSION LIST");
		two.view.dispose();
	});

	it("/resume on a session that has a row enters that row (no second job)", async () => {
		const listed = row({
			name: "listed one",
			sessionFile: "/s/listed.jsonl",
			pid: null,
			endedAt: Date.now() - 1000,
			state: "done",
		});
		let picked: ((s: { path: string; name: string; cwd: string; modified: number }) => void) | undefined;
		const { view, client } = setup([listed], {
			extra: {
				sessionSelector: (o) => {
					picked = o.onSelect;
					return { render: () => ["LIST"] };
				},
			},
		});
		await view.start();
		type(view, "/resume");
		view.handleInput("\r");
		picked!({ path: "/s/listed.jsonl", name: "listed one", cwd: "/w", modified: Date.now() });
		await sleep(30);
		expect(client.requests.some((r) => r.op === "dispatch")).toBe(false);
		// started again for the attach (an ended row asks no "Enter again" when chosen here)
		expect(client.requests.some((r) => r.op === "respawn")).toBe(true);
		view.dispose();
	});
});

describe("M23 review", () => {
	it("Enter with nothing matching keeps the picker; a paste searches; Tab keeps the selected model", async () => {
		const { view } = setup([row()], {
			extra: { models: () => ["a/one", "b/two", "c/three"], scopedModels: () => ["a/one", "b/two"] },
		});
		await view.start();
		view.handleInput("\x0c");
		view.handleInput("\x1b[B"); // a/one
		view.handleInput("\x1b[B"); // b/two
		view.handleInput("\t"); // all models: b/two still selected
		view.handleInput("\r");
		expect(view.render(100).join("\n")).toContain("new sessions: model b/two");
		view.handleInput("\x0c");
		type(view, "zzz");
		view.handleInput("\r");
		expect(view.render(100).join("\n")).toContain("nothing matches");
		view.handleInput("\x1b"); // clears the search
		view.handleInput("\x1b[200~thr\nee\x1b[201~");
		expect(view.render(100).join("\n")).toContain("search: thr ee");
		view.dispose();
	});

	it("resuming this xpi's own session is refused; a job whose push came first is entered", async () => {
		let picked: ((s: { path: string; name: string; cwd: string; modified: number }) => void) | undefined;
		const { view, client } = setup([row()], {
			extra: {
				currentSession: () => "/s/me.jsonl",
				sessionSelector: (o) => {
					picked = o.onSelect;
					return { render: () => ["LIST"] };
				},
			},
		});
		await view.start();
		type(view, "/resume");
		view.handleInput("\r");
		picked!({ path: "/s/me.jsonl", name: "me", cwd: "/w", modified: Date.now() });
		await sleep(10);
		expect(view.render(100).join("\n")).toContain("this xpi's own session");
		expect(client.requests.some((r) => r.op === "dispatch")).toBe(false);
		view.dispose();
	});

	it("closing the view disposes pi's list (its loads stop)", async () => {
		let disposed = 0;
		const { view } = setup([row()], {
			extra: { sessionSelector: () => ({ render: () => ["LIST"], dispose: () => disposed++ }) },
		});
		await view.start();
		type(view, "/resume");
		view.handleInput("\r");
		view.dispose();
		expect(disposed).toBe(1);
	});
});

describe("M43: /log in the hub", () => {
	it("lists what happened, newest first, and closes on Esc; an empty feed says so", async () => {
		const { view, client } = setup([row({ name: "fix tests" })]);
		await view.start();
		type(view, "/log");
		view.handleInput("\r");
		await sleep(20);
		expect(view.render(120).join("\n")).toContain("nothing happened yet");
		const at = Date.now();
		client.log = [
			{ seq: 1, at: at - 120_000, kind: "dispatch", id: "j1", name: "fix tests", who: "user" },
			{
				seq: 2,
				at: at - 60_000,
				kind: "state",
				id: "j1",
				name: "fix tests",
				state: "blocked",
				from: "working",
				waitingFor: "question",
				text: "Which branch?",
			},
			{ seq: 3, at: at - 1000, kind: "reply", id: "j1", name: "fix tests", who: "user", text: "use main" },
		];
		type(view, "/log");
		view.handleInput("\r");
		await sleep(20);
		// the lines, tones, scrolling and the filters are the overlay's (test/log-overlay.test.ts)
		expect(view.render(120).join("\n")).toContain("Log · what happened lately");
		expect(client.requests.filter((r) => r.op === "events")).toHaveLength(2);
		view.handleInput("r");
		await sleep(20);
		expect(client.requests.filter((r) => r.op === "events")).toHaveLength(3);
		view.handleInput("\x1b");
		expect(view.render(120).join("\n")).not.toContain("Log · what happened lately");
		view.dispose();
	});
});

describe("M24: usage in the hub", () => {
	const usage = (cost: number, today: number, sub = false) => ({
		input: 1000,
		output: 500,
		cacheRead: 0,
		cacheWrite: 0,
		cost,
		today,
		day: (() => {
			const d = new Date();
			d.setHours(0, 0, 0, 0);
			return d.getTime();
		})(),
		sub,
		models: { "anthropic/claude-opus-5-5": { cost, tokens: 1500 } },
	});

	it("rows show what each session spent, the header today's and all; /usage lists by model and session", async () => {
		const a = row({ name: "big job", model: "anthropic/claude-opus-5-5", usage: usage(12.5, 2) });
		const b = row({ name: "small job", model: "anthropic/claude-opus-5-5", usage: usage(0.3, 0.3, true) });
		const { view } = setup([a, b]);
		await view.start();
		const screen = view.render(140).join("\n");
		expect(screen).toContain("$12.50");
		expect(screen).toContain("$0.30");
		expect(screen).toContain("$2.30 today · $12.80 all");
		type(view, "/usage");
		view.handleInput("\r");
		// the totals, order and tags are the overlay's (test/usage-overlay.test.ts)
		const panel = view.render(140).join("\n");
		expect(panel).toContain("Usage · sessions in this view");
		expect(panel).toContain("2 sessions");
		view.handleInput("\x1b");
		expect(view.render(140).join("\n")).not.toContain("By model");
		view.dispose();
	});

	it("no cost column or totals before anything is spent; a narrow screen drops the column first", async () => {
		const { view } = setup([row({ name: "fresh" })]);
		await view.start();
		const screen = view.render(140).join("\n");
		expect(screen).not.toContain("today ·");
		expect(screen).not.toMatch(/\$\d/);
		view.dispose();
		const two = setup([
			row({
				name: "spent",
				summary: "a long summary of what it is doing right now",
				model: "anthropic/claude-opus-5-5",
				usage: usage(3, 0),
			}),
		]);
		await two.view.start();
		// the model column and the share go first, then the cost: the summary keeps its room
		const line = two.view.render(48).find((l) => l.includes("spent")) ?? "";
		expect(line).toContain("a long");
		expect(line).not.toContain("$3.00");
		expect(two.view.render(160).find((l) => l.includes("spent"))).toContain("$3.00");
		two.view.dispose();
	});
});

describe("AgentView batch (M25)", () => {
	const ctrlO = "\x0f";
	it("M51: the connection lost between two marked replies: the next waits for it and goes", async () => {
		const rows = [row({ id: "a", name: "one" }), row({ id: "b", name: "two" })];
		const { view, client } = setup(rows);
		await view.start();
		view.handleInput(ctrlO);
		view.handleInput(ctrlO);
		// the daemon restarts as the first reply is answered: the view has no connection for 500 ms
		const request = client.request.bind(client);
		let lost = false;
		client.request = async (op: string, args: unknown) => {
			const r = await request(op, args);
			if (op === "reply" && !lost) {
				lost = true;
				for (const l of client.closes) l();
			}
			return r;
		};
		type(view, "rebase on main");
		view.handleInput("\r");
		await sleep(900);
		expect(client.requests.filter((r) => r.op === "reply").map((r) => (r.args as { id: string }).id)).toEqual([
			"a",
			"b",
		]);
		expect(view.render(100).join("\n")).toContain("sent to 2 of 2 sessions");
		view.dispose();
	});

	it("Ctrl+O marks rows and moves on; the typed text goes to each marked session", async () => {
		const rows = [
			row({ id: "a", name: "one" }),
			row({ id: "b", name: "two" }),
			row({ id: "c", name: "three" }),
			row({ id: "s", name: "! make", kind: "shell" }),
		];
		const { view, client } = setup(rows);
		await view.start();
		view.handleInput(ctrlO); // one, cursor to two
		view.handleInput(ctrlO); // two
		let out = view.render(100);
		expect(out.find((l) => l.includes("one"))).toMatch(/^ ✓/);
		expect(out.find((l) => l.includes("two"))).toMatch(/^ ✓/);
		expect(out.find((l) => l.includes("three"))).toMatch(/^› /);
		expect(out.join("\n")).toContain("2 marked");
		type(view, "rebase on main");
		view.handleInput("\r");
		await sleep(10);
		expect(client.requests.filter((r) => r.op === "reply").map((r) => r.args)).toEqual([
			{ id: "a", text: "rebase on main", mode: "steer" },
			{ id: "b", text: "rebase on main", mode: "steer" },
		]);
		expect(client.requests.some((r) => r.op === "dispatch")).toBe(false);
		out = view.render(100);
		expect(out.join("\n")).toContain("sent to 2 of 2 sessions");
		// the marks stay for the next batch; a mark again on a row unmarks it
		view.handleInput("\x1b[A"); // up to two
		view.handleInput(ctrlO);
		expect(view.render(100).find((l) => l.includes("two"))).not.toMatch(/^.✓/);
		// a shell job is skipped
		view.handleInput("\x1b[B"); // s? cursor moved on to three; go to the shell row
		view.handleInput(ctrlO);
		type(view, "status?");
		view.handleInput("\r");
		await sleep(10);
		expect(
			client.requests
				.filter((r) => r.op === "reply")
				.map((r) => (r.args as { id: string }).id)
				.slice(2),
		).toEqual(["a"]);
		expect(view.render(100).join("\n")).toContain("1 shell commands skipped");
		view.dispose();
	});

	it("/model and /thinking switch every marked session; bare /model picks once for all", async () => {
		const rows = [row({ id: "a", name: "one", model: "a/one" }), row({ id: "b", name: "two", model: "a/one" })];
		const { view, client } = setup(rows, { switchCheckMs: 10_000 });
		await view.start();
		view.handleInput(ctrlO);
		view.handleInput(ctrlO);
		type(view, "/model b/two");
		view.handleInput("\r");
		await sleep(10);
		expect(client.requests.filter((r) => r.op === "reply").map((r) => r.args)).toEqual([
			{ id: "a", text: "/model b/two" },
			{ id: "b", text: "/model b/two" },
		]);
		expect(view.render(100).join("\n")).toContain("asked 2 of 2 sessions to use model b/two");
		type(view, "/thinking nope");
		view.handleInput("\r");
		expect(view.render(100).join("\n")).toContain("thinking is one of");
		view.handleInput("\u0003");
		type(view, "/model");
		view.handleInput("\r");
		expect(view.render(100).join("\n")).toContain("Model for 2 marked sessions");
		view.handleInput("\x1b");
		view.handleInput("\u0003");
		type(view, "/worktree on");
		view.handleInput("\r");
		expect(view.render(100).join("\n")).toContain("only /model and /thinking act on marked sessions");
		view.dispose();
	});

	it("Ctrl+O on a header marks the group; Ctrl+T pins all; Ctrl+X stops then deletes all; Esc unmarks first", async () => {
		const rows = [row({ id: "a", name: "one" }), row({ id: "b", name: "two" }), row({ id: "c", name: "three" })];
		const { view, client, done } = setup(rows);
		await view.start();
		view.handleInput("\x1b[1;3A"); // Alt+↑: the group header
		view.handleInput(ctrlO);
		expect(view.render(100).join("\n")).toContain("3 marked");
		view.handleInput("\x14"); // Ctrl+T: pin all (unpin only when all are pinned)
		await sleep(10);
		expect(client.requests.filter((r) => r.op === "pin").map((r) => r.args)).toEqual([
			{ id: "a", pinned: true },
			{ id: "b", pinned: true },
			{ id: "c", pinned: true },
		]);
		view.handleInput("\x18"); // Ctrl+X: stop the running ones
		await sleep(10);
		expect(client.requests.filter((r) => r.op === "stop")).toHaveLength(3);
		view.handleInput("\x18"); // again: delete
		await sleep(10);
		expect(client.requests.filter((r) => r.op === "rm").map((r) => (r.args as { id: string }).id)).toEqual([
			"a",
			"b",
			"c",
		]);
		expect(view.render(100).join("\n")).not.toContain("marked");
		// Esc: marks before leaving
		view.handleInput("\x1b[B");
		view.handleInput(ctrlO);
		view.handleInput("\x1b");
		expect(done()).toBe(0);
		expect(view.render(100).join("\n")).toContain("marks cleared");
		view.handleInput("\x1b");
		expect(done()).toBe(1);
		view.dispose();
	});

	it("M25 review: a peek acts on its row; folded marks are not acted on; ! and @ stay; a failed send gives the text back", async () => {
		const rows = [row({ id: "a", name: "one" }), row({ id: "b", name: "two" }), row({ id: "c", name: "three" })];
		const { view, client } = setup(rows);
		await view.start();
		view.handleInput(ctrlO);
		view.handleInput(ctrlO); // a, b marked; cursor on c
		view.handleInput(" "); // peek c
		view.handleInput("\x18"); // Ctrl+X: stops c, not the marks
		await sleep(10);
		expect(client.requests.filter((r) => r.op === "stop").map((r) => r.args)).toEqual([{ id: "c" }]);
		view.handleInput("\x14");
		await sleep(10);
		expect(client.requests.filter((r) => r.op === "pin").map((r) => r.args)).toEqual([{ id: "c", pinned: true }]);
		view.handleInput("\x1b"); // close the peek
		type(view, "! npm test");
		view.handleInput("\r");
		await sleep(10);
		expect(client.requests.some((r) => r.op === "reply" || r.op === "dispatch")).toBe(false);
		expect(view.render(100).join("\n")).toContain("! npm test");
		view.handleInput("\u0003");
		client.replyResult = { delivered: false, saved: false };
		type(view, "are you done?");
		view.handleInput("\r");
		view.handleInput("\r"); // a second Enter while sending sends nothing more
		await sleep(10);
		expect(client.requests.filter((r) => r.op === "reply")).toHaveLength(2);
		const out = view.render(100).join("\n");
		expect(out).toContain("not delivered: one, two");
		expect(out).toContain("are you done?");
		view.handleInput("\u0003");
		// fold the group: its marks are kept but not acted on
		view.handleInput("\x1b[1;3A"); // Alt+↑: the header
		view.handleInput("\r"); // fold
		expect(view.render(100).join("\n")).not.toContain("marked");
		view.handleInput("\x18");
		await sleep(10);
		// on the folded header Ctrl+X is the group's (shown as a group), not the hidden marks
		expect(client.requests.filter((r) => r.op === "stop").map((r) => (r.args as { id: string }).id)).toEqual([
			"c",
			"a",
			"b",
			"c",
		]);
		view.dispose();
	});

	it("M28: in a peek Enter steers and Alt+Enter waits for the current work; marked rows too", async () => {
		const rows = [row({ id: "a", name: "one" }), row({ id: "b", name: "two" })];
		const { view, client } = setup(rows);
		await view.start();
		view.handleInput(" ");
		type(view, "use pnpm");
		view.handleInput("\r");
		await sleep(10);
		expect(view.render(100).join("\n")).toContain("sent · one · joins its current work");
		type(view, "then run the tests");
		view.handleInput("\x1b\r"); // Alt+Enter
		await sleep(10);
		expect(view.render(100).join("\n")).toContain("sent · one · after its current work");
		view.handleInput("\x1b"); // close the peek
		view.handleInput("\x0f");
		view.handleInput("\x0f");
		type(view, "rebase please");
		view.handleInput("\x1b\r");
		await sleep(10);
		expect(client.requests.filter((r) => r.op === "reply").map((r) => (r.args as { mode: string }).mode)).toEqual([
			"steer",
			"followUp",
			"followUp",
			"followUp",
		]);
		expect(view.render(100).join("\n")).toContain("sent to 2 of 2 sessions (after their current work)");
		view.dispose();
	});

	it("a removed row drops out of the marks", async () => {
		const rows = [row({ id: "a", name: "one" }), row({ id: "b", name: "two" })];
		const { view, client } = setup(rows);
		await view.start();
		view.handleInput(ctrlO);
		view.handleInput(ctrlO);
		client.emit({ event: "removed", id: "a" });
		expect(view.render(100).join("\n")).toContain("1 marked");
		// all marked are pinned: Ctrl+T unpins them
		client.emit({ event: "job", job: { ...rows[1]!, pinned: true } });
		view.handleInput("\x14");
		await sleep(10);
		expect(client.requests.filter((r) => r.op === "pin").map((r) => r.args)).toEqual([{ id: "b", pinned: false }]);
		view.dispose();
	});
});

describe("AgentView presets (M27)", () => {
	function withPresets(initial: Record<string, Preset>, cwd?: string) {
		const store = { ...initial };
		const user = new Set(Object.keys(initial));
		const s = setup([], {
			extra: {
				...(cwd ? { cwd } : {}),
				presets: () => store,
				savePreset: (name, p) => {
					if (p) {
						store[name] = p;
						user.add(name);
					} else {
						delete store[name];
						user.delete(name);
					}
				},
				userPreset: (name) => user.has(name),
			},
		});
		return { ...s, store, user };
	}

	it("/preset name applies it: model, thinking and directory reach the next task; a typed @dir wins", async () => {
		const hub = realpathSync(mkdtempSync(join(tmpdir(), "roost-preset-")));
		mkdirSync(join(hub, "api"));
		symlinkSync(tmpdir(), join(hub, "out"));
		const { view } = withPresets(
			{
				review: { model: "b/two", thinking: "high", dir: "api" },
				escape: { dir: "out" },
				gone: { dir: "nope" },
				fast: { model: "a/one" },
			},
			hub,
		);
		await view.start();
		type(view, "/preset nope");
		view.handleInput("\r");
		expect(view.render(100).join("\n")).toContain("no preset nope");
		view.handleInput("\u0003");
		type(view, "/preset review");
		view.handleInput("\r");
		expect(view.render(120).join("\n")).toContain(
			"new sessions: preset review · model b/two · thinking high · in @api",
		);
		const before = launches.length;
		type(view, "check the latest diff");
		view.handleInput("\r");
		await sleep(10);
		const o = launches[before]!.opts as { cwd: string; model: string; thinking: string };
		expect(o).toMatchObject({ cwd: join(hub, "api"), model: "b/two", thinking: "high" });
		type(view, "@/tmp check the other diff");
		view.handleInput("\r");
		await sleep(10);
		expect((launches[before + 1]!.opts as { cwd: string }).cwd).toMatch(/tmp$/);
		// another preset replaces the whole choice: nothing of review's stays
		type(view, "/preset fast");
		view.handleInput("\r");
		const head = view.render(140).find((l) => l.startsWith("new sessions:"))!;
		expect(head).toBe("new sessions: preset fast · model a/one");
		// a link out of the hub's directory, or a directory that is not there, starts nothing
		for (const [name, says] of [
			["escape", "leads outside"],
			["gone", "does not exist here"],
		] as const) {
			const n = launches.length;
			type(view, `/preset ${name}`);
			view.handleInput("\r");
			type(view, "run the whole suite");
			view.handleInput("\r");
			await sleep(10);
			expect(launches.length).toBe(n);
			expect(view.render(140).join("\n")).toContain(says);
			view.handleInput("\u0003");
		}
		// off: back to the defaults; a name like toString is no preset
		type(view, "/preset off");
		view.handleInput("\r");
		expect(view.render(120).join("\n")).not.toContain("new sessions: preset");
		type(view, "/preset toString");
		view.handleInput("\r");
		expect(view.render(120).join("\n")).toContain("no preset toString");
		view.dispose();
		rmSync(hub, { recursive: true, force: true });
	});

	it("/preset save keeps the current choices; bare /preset picks; rm removes only the user's", async () => {
		const { view, store, user } = withPresets({});
		await view.start();
		type(view, "/preset");
		view.handleInput("\r");
		expect(view.render(100).join("\n")).toContain("no presets yet");
		view.handleInput("\u0003");
		type(view, "/model a/one");
		view.handleInput("\r");
		type(view, "/thinking low");
		view.handleInput("\r");
		type(view, "/preset save duo");
		view.handleInput("\r");
		expect(store.duo).toEqual({ model: "a/one", thinking: "low" });
		expect(view.render(120).join("\n")).toContain("saved preset duo");
		// a project's preset is not the user's to remove
		store.shared = { thinking: "low" };
		type(view, "/preset rm shared");
		view.handleInput("\r");
		expect(view.render(120).join("\n")).toContain("shared is a project's preset");
		view.handleInput("\u0003");
		type(view, "/preset off");
		view.handleInput("\r");
		type(view, "/preset");
		view.handleInput("\r");
		let out = view.render(120).join("\n");
		expect(out).toContain("Preset for new sessions");
		expect(out).toContain("duo  one · thinking low");
		view.handleInput("\x1b[B"); // duo
		view.handleInput("\r");
		out = view.render(120).join("\n");
		expect(out).toContain("new sessions: preset duo · model a/one · thinking low");
		type(view, "/preset rm duo");
		view.handleInput("\r");
		expect(store.duo).toBeUndefined();
		expect(user.has("duo")).toBe(false);
		expect(view.render(120).join("\n")).not.toContain("new sessions: preset duo");
		view.dispose();
	});
});

describe("M48: the peek, deeper", () => {
	/** The screen once it says `text` (an overlay or a notice comes after an await), within a second. */
	const screenWith = async (view: AgentView, text: string, width = 120): Promise<string> => {
		let screen = "";
		for (let i = 0; i < 200; i++) {
			screen = view.render(width).join("\n");
			if (screen.includes(text)) return screen;
			await sleep(5);
		}
		return screen;
	};
	const entry = (id: string, parentId: string | null, message: unknown) =>
		`${JSON.stringify({ type: "message", id, parentId, message })}\n`;
	/** A pi session file with a prompt, a reply with a tool call, its result and a last reply. */
	function sessionFile(dir: string): string {
		const file = join(dir, "s.jsonl");
		writeFileSync(
			file,
			`${JSON.stringify({ type: "session", id: "s", version: 1 })}\n` +
				entry("m1", null, { role: "user", content: [{ type: "text", text: "write the tests" }] }) +
				entry("m2", "m1", {
					role: "assistant",
					content: [
						{ type: "text", text: "Reading the code first." },
						{ type: "toolCall", id: "t1", name: "read_file", arguments: { path: "src/x.ts" } },
					],
				}) +
				entry("m3", "m2", {
					role: "toolResult",
					toolCallId: "t1",
					content: [{ type: "text", text: "export const x = 1" }],
				}) +
				entry("m4", "m3", { role: "assistant", content: [{ type: "text", text: "Now the tests." }] }),
		);
		return file;
	}
	const usage = {
		input: 30_000,
		output: 4_000,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0.12,
		today: 0.12,
		day: 0,
		sub: false,
		models: {},
	};

	it("shows the task, where and since when, the cost, queued replies and the transcript tail (live); a failed row's error whole; the box says what Enter does", async () => {
		const dir = mkdtempSync(join(tmpdir(), "roost-peek-"));
		try {
			const file = sessionFile(dir);
			const home = process.env.HOME ?? "/nohome";
			const r1 = row({
				id: "p1",
				name: "tests",
				task: "write the tests for x",
				cwd: `${home}/w`,
				queued: 2,
				usage,
				sessionFile: file,
			});
			const failed = row({
				id: "p2",
				name: "lint",
				state: "failed",
				status: null,
				pid: null,
				endedAt: Date.now() - 5_000,
				error: `the linter found ${"many ".repeat(30)}problems in the end`,
			});
			const asking = row({
				id: "p3",
				name: "api",
				state: "blocked",
				status: "waiting",
				waitingFor: "question",
				question: "Use v2?",
				choices: ["yes", "no"],
			});
			const { view } = setup([r1, failed, asking]);
			await view.start();
			// the list: Needs input (api), Working (tests), Completed (lint); headers are rows too
			const select = (name: string) => {
				view.handleInput("\x1b[H");
				for (let i = 0; i < 10 && !view.render(120).some((l) => l.startsWith("›") && l.includes(name)); i++)
					view.handleInput("\x1b[B");
			};
			select("tests");
			view.handleInput(" "); // peek tests
			let screen = view.render(120).join("\n");
			expect(screen).toContain("task: write the tests for x");
			expect(screen).toContain("~/w · started 1m ago");
			expect(screen).toContain("2 replies queued");
			expect(screen).toContain("$0.12 · 34k tokens");
			expect(screen).toContain("you: write the tests");
			expect(screen).toContain("⚙ read_file");
			expect(screen).toContain("› Now the tests.");
			expect(screen).toContain("reply · Enter joins its work");
			// live: the file grows, the tail follows (re-read at most every 2 s)
			appendFileSync(
				file,
				entry("m5", "m4", { role: "assistant", content: [{ type: "text", text: "Done: 3 tests pass." }] }),
			);
			(view as unknown as { tails: Map<string, unknown> }).tails.clear();
			screen = view.render(120).join("\n");
			expect(screen).toContain("› Done: 3 tests pass.");
			// the failed row: its error whole, and what Enter does
			view.handleInput("\x1b"); // close
			select("lint");
			view.handleInput(" ");
			screen = view.render(80).join("\n");
			expect(screen).toContain("problems in the end");
			expect(screen).toContain("failed 5s ago · took");
			expect(screen).toContain("/continue picks it up");
			// the asking row: answer
			view.handleInput("\x1b");
			select("api");
			view.handleInput(" ");
			screen = view.render(80).join("\n");
			expect(screen).toContain("1. yes");
			expect(screen).toContain("answer · Enter sends · 1-9 picks a choice");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("commands in a peek act on that session; unknown ones and ! are refused; a reply of several lines goes whole", async () => {
		const r1 = row({ id: "p1", name: "tests" });
		const { view, client } = setup([r1, row({ id: "p2", name: "other" })]);
		await view.start();
		view.handleInput(" ");
		const send = async (text: string, says: string) => {
			view.handleInput("\x03"); // a refused command stays in the box to fix: cleared here
			type(view, text);
			view.handleInput("\r");
			return screenWith(view, says);
		};
		const ops = (op: string) => client.requests.filter((r) => r.op === op).map((r) => r.args);
		expect(await send("/stop", "stopping · tests")).toContain("stopping · tests");
		expect(ops("stop")).toEqual([{ id: "p1" }]);
		expect(await send("/respawn", "starting tests again")).toContain("starting tests again");
		expect(ops("respawn")).toEqual([{ id: "p1" }]);
		expect(await send("/rename api-two", "renamed · api-two")).toContain("renamed · api-two");
		expect(ops("rename")).toEqual([{ id: "p1", name: "api-two" }]);
		await send("/pin", "pinned · tests");
		expect(ops("pin")).toEqual([{ id: "p1", pinned: true }]);
		expect(await send("/continue", "sent · tests")).toContain("sent · tests");
		expect(ops("reply").at(-1)).toEqual({ id: "p1", text: "Continue where you left off.", mode: "followUp" });
		expect(await send("/compact", "/compact · tests")).toContain("/compact · tests");
		expect(ops("reply").at(-1)).toEqual({ id: "p1", text: "/compact" });
		expect(await send("/name zed", "/name · tests")).toContain("/name · tests");
		expect(ops("reply").at(-1)).toEqual({ id: "p1", text: "/name zed" });
		// not the peek's: the session's (a prompt template, a skill), sent as a reply
		expect(await send("/review now", "sent · tests")).toContain("sent · tests");
		expect(ops("reply").at(-1)).toEqual({ id: "p1", text: "/review now", mode: "steer" });
		expect(await send("!ls", "shell commands are not sent to a session")).toContain(
			"shell commands are not sent to a session",
		);
		expect(ops("reply")).toHaveLength(4);
		// several lines: Ctrl+J adds one; Enter sends them together
		view.handleInput("\x03");
		type(view, "line one");
		view.handleInput("\n");
		type(view, "line two");
		view.handleInput("\r");
		await sleep(20);
		expect(ops("reply").at(-1)).toEqual({ id: "p1", text: "line one\nline two", mode: "steer" });
		// /rm: twice within 2 s; the peek closes with the row
		expect(await send("/rm", "/rm again within 2 s to delete tests")).toContain(
			"/rm again within 2 s to delete tests",
		);
		expect(ops("rm")).toEqual([]);
		expect(await send("/rm", "deleted · tests")).toContain("deleted · tests");
		expect(ops("rm")).toEqual([{ id: "p1" }]);
		expect(view.render(120).join("\n")).not.toContain("/ commands · Esc close");
	});

	it("/log and /transcript in a peek open overlays for that session; Tab completes a / command", async () => {
		const dir = mkdtempSync(join(tmpdir(), "roost-peek-"));
		try {
			const file = sessionFile(dir);
			const r1 = row({ id: "p1", name: "tests", sessionFile: file });
			const { view, client } = setup([r1, row({ id: "p2", name: "other" })]);
			client.log = [
				{
					seq: 1,
					at: Date.now() - 60_000,
					kind: "state",
					id: "p1",
					name: "tests",
					state: "working",
					from: null,
					text: null,
				},
				{
					seq: 2,
					at: Date.now() - 30_000,
					kind: "state",
					id: "p2",
					name: "other",
					state: "done",
					from: "working",
					text: "all green",
				},
			];
			await view.start();
			view.handleInput(" ");
			type(view, "/log");
			view.handleInput("\r");
			let screen = await screenWith(view, "Log · tests (newest first)");
			expect(screen).toContain("Log · tests (newest first)");
			expect(screen).not.toContain("all green");
			view.handleInput("\x1b");
			type(view, "/transcript");
			view.handleInput("\r");
			screen = await screenWith(view, "Transcript · tests");
			expect(screen).toContain("Transcript · tests");
			expect(screen).toContain("› Now the tests.");
			expect(screen).toContain("→ export const x = 1");
			view.handleInput("\x1b");
			expect(view.render(120).join("\n")).not.toContain("Transcript · tests");
			// completion: pi's menu opens on /, Tab takes the first match
			const reply = (view as unknown as { reply: { getValue(): string; autocompleteOpen(): boolean } }).reply;
			type(view, "/tra");
			for (let i = 0; i < 100 && !reply.autocompleteOpen(); i++) await sleep(5);
			expect(reply.autocompleteOpen()).toBe(true);
			view.handleInput("\t");
			for (let i = 0; i < 100 && reply.getValue().trim() !== "/transcript"; i++) await sleep(5);
			expect(reply.getValue().trim()).toBe("/transcript");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("Enter on a / command in the open menu runs it at once; Tab in a peek opens pi's menu; a narrower terminal keeps every line within it", async () => {
		const dir = mkdtempSync(join(tmpdir(), "roost-peek-"));
		try {
			const file = sessionFile(dir);
			appendFileSync(
				file,
				entry("m5", "m4", {
					role: "assistant",
					content: [{ type: "text", text: `A very long line ${"x".repeat(150)} end` }],
				}),
			);
			const r1 = row({ id: "p1", name: "tests", sessionFile: file, task: `t ${"y".repeat(150)}` });
			const { view, client } = setup([r1]);
			client.log = [
				{
					seq: 1,
					at: Date.now() - 60_000,
					kind: "state",
					id: "p1",
					name: "tests",
					state: "working",
					from: null,
					text: null,
				},
			];
			await view.start();
			view.handleInput(" ");
			const reply = (view as unknown as { reply: { getValue(): string; autocompleteOpen(): boolean } }).reply;
			const open = async () => {
				for (let i = 0; i < 100 && !reply.autocompleteOpen(); i++) await sleep(5);
				return reply.autocompleteOpen();
			};
			// typed whole, the menu still open (as it is for a person): one Enter
			type(view, "/transcript");
			expect(await open()).toBe(true);
			view.handleInput("\r");
			expect(await screenWith(view, "Transcript · tests")).toContain("Transcript · tests");
			expect(reply.getValue()).toBe("");
			view.handleInput("\x1b");
			// the menu closed with Esc, Tab opens it again for the prefix (pi's forced completion)
			type(view, "/s");
			expect(await open()).toBe(true);
			view.handleInput("\x1b");
			for (let i = 0; i < 100 && reply.autocompleteOpen(); i++) await sleep(5);
			expect(reply.autocompleteOpen()).toBe(false);
			view.handleInput("\t");
			expect(await open()).toBe(true);
			view.handleInput("\x1b");
			for (let i = 0; i < 100 && reply.autocompleteOpen(); i++) await sleep(5);
			view.handleInput("\x03"); // clear /s
			// the same in the task box: /log + Enter opens the log at once
			view.handleInput("\x1b"); // close the peek
			const input = (view as unknown as { input: { autocompleteOpen(): boolean } }).input;
			type(view, "/log");
			for (let i = 0; i < 100 && !input.autocompleteOpen(); i++) await sleep(5);
			expect(input.autocompleteOpen()).toBe(true);
			view.handleInput("\r");
			expect(await screenWith(view, "Log · what happened lately")).toContain("Log · what happened lately");
			expect(client.requests.filter((r) => r.op === "dispatch")).toHaveLength(0);
			view.handleInput("\x1b");
			// wide, then narrow: the tail and the task are cut to the width each time
			view.handleInput(" ");
			expect(view.render(120).some((l) => visibleWidth(l) > 100)).toBe(true);
			for (const l of view.render(60)) expect(visibleWidth(l)).toBeLessThanOrEqual(60);
			type(view, "/transcript");
			expect(await open()).toBe(true);
			view.handleInput("\r");
			await screenWith(view, "Transcript · tests");
			expect(view.render(120).some((l) => visibleWidth(l) > 100)).toBe(true);
			for (const l of view.render(60)) expect(visibleWidth(l)).toBeLessThanOrEqual(60);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("M61: a session's own slash commands in its peek", () => {
	const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
	const screenWith = async (view: AgentView, text: string): Promise<string> => {
		let screen = "";
		for (let i = 0; i < 200; i++) {
			screen = view.render(120).join("\n");
			if (screen.includes(text)) return screen;
			await sleepMs(5);
		}
		return screen;
	};
	/** A fake host: records the control calls; `status` says whether someone is attached. */
	function fakeHost(attached = false) {
		const calls: { id: string; op: string; extra?: unknown }[] = [];
		const fn = async (id: string, op: string, _timeout?: number, extra?: unknown) => {
			calls.push({ id, op, ...(extra ? { extra } : {}) });
			if (op === "status") return { attached };
			if (op === "snapshot") return { text: "Session Info\n  Messages: 3" };
			return { ok: true };
		};
		return { calls, fn: fn as never };
	}
	const commands = [
		{ name: "deploy", description: "ship it", source: "extension" as const },
		{ name: "skill:lint", description: "lint things", source: "skill" as const },
		{ name: "review", description: "review code", source: "prompt" as const },
		{ name: "tree", description: "clashes with a built-in", source: "extension" as const },
	];
	const menu = (view: AgentView) =>
		(view as unknown as { peekCommands(): { name: string; description?: string }[] }).peekCommands();
	const make = (r: JobRow, host = fakeHost(), extra: Partial<AgentViewOptions> = {}) => {
		const s = setup([r], { extra: { hostControl: host.fn, sessionCommands: () => commands, ...extra } });
		return { ...s, host };
	};
	const send = async (view: AgentView, text: string, says: string) => {
		view.handleInput("\x03");
		type(view, text);
		view.handleInput("\r");
		return screenWith(view, says);
	};

	it("the menu has the groups in order with tags, no duplicates, and marks for a row that is not running or is working", async () => {
		const { view } = make(
			row({ id: "p1", name: "tests", state: "blocked", status: "waiting", waitingFor: "first-prompt" }),
		);
		await view.start();
		view.handleInput(" ");
		const m = menu(view);
		const tag = (c: { description?: string }) => c.description!.split(" · ")[0];
		const names = m.map((c) => c.name);
		expect(new Set(names).size).toBe(names.length);
		const groups = m.map(tag).filter((t, i, a) => a.indexOf(t) === i);
		expect(groups).toEqual(["hub", "xpi", "extension", "skill", "prompt"]);
		expect(m.find((c) => c.name === "stop")!.description).toBe("hub · stop it");
		expect(m.find((c) => c.name === "session")!.description).toBe("xpi · Show session info and stats");
		expect(m.find((c) => c.name === "model")!.description).toMatch(/^hub · /);
		expect(m.find((c) => c.name === "deploy")!.description).toBe("extension · ship it");
		// xpi's /tree wins over an extension command of the same name
		expect(m.find((c) => c.name === "tree")!.description).toMatch(/^xpi · /);
		view.handleInput("\x1b");
		// working: xpi's built-ins are for when it is idle
		const w = make(row({ id: "p2", name: "busy" }));
		await w.view.start();
		w.view.handleInput(" ");
		expect(menu(w.view).find((c) => c.name === "session")!.description).toBe(
			"xpi · Show session info and stats (when idle)",
		);
		// not running
		const g = make(row({ id: "p3", name: "gone", state: "stopped", status: null, pid: null }));
		await g.view.start();
		g.view.handleInput(" ");
		expect(menu(g.view).find((c) => c.name === "session")!.description).toBe(
			"xpi · Show session info and stats (not running)",
		);
		expect(menu(g.view).find((c) => c.name === "stop")!.description).toBe("hub · stop it (not running)");
	});

	it("/session on an idle row types it, then reads the screen into an overlay; /tree types it, then attaches", async () => {
		const { view, host } = make(
			row({ id: "p1", name: "tests", state: "blocked", status: "waiting", waitingFor: "question", question: "?" }),
		);
		await view.start();
		view.handleInput(" ");
		const screen = await send(view, "/session", "Session Info");
		expect(screen).toContain("session · tests");
		expect(screen).toContain("Messages: 3");
		expect(host.calls.map((c) => c.op)).toEqual(["status", "command", "snapshot"]);
		expect(host.calls[1]).toEqual({ id: "p1", op: "command", extra: { text: "/session" } });
		view.handleInput("\x1b");
		// a picker: typed in, then attached
		const attached: string[] = [];
		(view as unknown as { attachTo: (id: string) => Promise<void> }).attachTo = async (id) => void attached.push(id);
		host.calls.length = 0;
		await send(view, "/tree", "");
		await sleepMs(30);
		expect(host.calls.map((c) => c.op)).toEqual(["status", "command"]);
		expect(host.calls[1]!.extra).toEqual({ text: "/tree" });
		expect(attached).toEqual(["p1"]);
	});

	it("words after a built-in that takes none are refused (xpi would send them to the model); one that needs them says so; an argument goes along", async () => {
		const { view, host } = make(
			row({ id: "p1", name: "tests", state: "blocked", status: "waiting", waitingFor: "first-prompt" }),
		);
		await view.start();
		view.handleInput(" ");
		expect(await send(view, "/tree foo", "/tree takes no arguments")).toContain("/tree takes no arguments");
		expect(await send(view, "/import", "/import needs")).toContain("/import needs");
		expect(host.calls).toEqual([]);
		await send(view, "/Export out.html", "Session Info");
		expect(host.calls.find((c) => c.op === "command")!.extra).toEqual({ text: "/export out.html" });
	});

	it("a session with no host to type into is told so, not a socket error", async () => {
		const gone = Object.assign(new Error("connect ENOENT"), { code: "ENOENT" });
		const { view } = make(
			row({ id: "p1", name: "tests", state: "blocked", status: "waiting", waitingFor: "first-prompt" }),
			{ calls: [], fn: (async () => Promise.reject(gone)) as never },
		);
		await view.start();
		view.handleInput(" ");
		expect(await send(view, "/session", "has no host")).toContain(
			"tests has no host to type into: run /session there",
		);
	});

	it("/quit needs a second /quit within 2 s", async () => {
		const { view, host } = make(
			row({ id: "p1", name: "tests", state: "blocked", status: "waiting", waitingFor: "first-prompt" }),
		);
		await view.start();
		view.handleInput(" ");
		expect(await send(view, "/quit", "/quit again within 2 s to end tests")).toContain("/quit again within 2 s");
		expect(host.calls.some((c) => c.op === "command")).toBe(false);
		await send(view, "/quit", "/quit · tests");
		expect(host.calls.filter((c) => c.op === "command").map((c) => c.extra)).toEqual([{ text: "/quit" }]);
	});

	it("refuses for a working row, a dialog, an attached row and a row not running; a shell row's goes as a reply", async () => {
		const typed = (h: ReturnType<typeof fakeHost>) => h.calls.some((c) => c.op === "command");
		const working = make(row({ id: "w", name: "busy" }));
		await working.view.start();
		working.view.handleInput(" ");
		expect(await send(working.view, "/session", "works when it is idle")).toContain("busy is working");
		expect(typed(working.host)).toBe(false);
		const dialog = make(row({ id: "d", name: "ask", state: "blocked", status: "waiting", waitingFor: "dialog" }));
		await dialog.view.start();
		dialog.view.handleInput(" ");
		expect(await send(dialog.view, "/session", "in a dialog")).toContain("ask is in a dialog");
		const there = make(
			row({ id: "a", name: "mine", state: "blocked", status: "waiting", waitingFor: "first-prompt" }),
			fakeHost(true),
		);
		await there.view.start();
		there.view.handleInput(" ");
		expect(await send(there.view, "/session", "attached elsewhere")).toContain("mine is attached elsewhere");
		expect(typed(there.host)).toBe(false);
		const gone = make(row({ id: "g", name: "gone", state: "stopped", status: null, pid: null }));
		await gone.view.start();
		gone.view.handleInput(" ");
		expect(await send(gone.view, "/session", "is not running")).toContain("gone is not running");
		expect(gone.host.calls).toEqual([]);
		// a shell command's row: no xpi to type into, the text goes to it as a reply
		const agent = make(row({ id: "t", name: "agent", kind: "shell" }));
		await agent.view.start();
		agent.view.handleInput(" ");
		await send(agent.view, "/session", "");
		await sleepMs(20);
		expect(agent.host.calls).toEqual([]);
		expect(
			agent.client.requests.filter((r) => r.op === "reply").map((r) => (r.args as { text: string }).text),
		).toEqual(["/session"]);
	});

	it("an extension command goes as a reply and says so; so does one of xpi's built-in extensions' (subtask), not listed with xpi's own", async () => {
		const { view, client } = make(row({ id: "p1", name: "tests" }));
		await view.start();
		view.handleInput(" ");
		expect(await send(view, "/deploy now", "/deploy · tests")).toContain("/deploy · tests");
		expect(client.requests.filter((r) => r.op === "reply").at(-1)!.args).toEqual({
			id: "p1",
			text: "/deploy now",
			mode: "steer",
		});
		// T18: a "reply" command is the worker's to run; a "screen" one of an extension is typed in like xpi's own
		const m = menu(view);
		expect(m.some((c) => c.name === "subtask")).toBe(false);
		expect(m.find((c) => c.name === "relay")!.description).toMatch(/^xpi · /);
		expect(await send(view, "/subtask look at the logs", "/subtask · tests")).toContain("/subtask · tests");
		expect(client.requests.filter((r) => r.op === "reply").at(-1)!.args).toEqual({
			id: "p1",
			text: "/subtask look at the logs",
			mode: "steer",
		});
	});
});

// M74: the screens of /usage, /log and /compare, pinned before they moved to hub/overlays/
// (docs/plans/hub-overlays.md). Rows carry their own start times: the list and the compare
// columns order by them.
describe("M74: overlay renders, pinned", () => {
	const NOW = 1_800_000_000_000;
	const MIN = 60_000;
	afterEach(() => vi.useRealTimers());
	const shot = (view: AgentView, w = 100) => view.render(w).join("\n");
	const run = async (view: AgentView, line: string) => {
		type(view, line);
		view.handleInput("\r");
		await sleep(30);
	};
	const start = async (rows: JobRow[], extra: Partial<AgentViewOptions> = {}) => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(NOW);
		const s = setup(rows, { extra });
		await s.view.start();
		return s;
	};
	const at = (n: number, over: Partial<JobRow> = {}) =>
		row({ startedAt: NOW - (10 - n) * MIN, stateSince: NOW - (10 - n) * MIN, ...over });
	const spent = (
		cost: number,
		today: number,
		models: Record<string, { cost: number; tokens: number }>,
		sub = false,
	) => {
		const d = new Date(NOW);
		d.setHours(0, 0, 0, 0);
		return {
			input: 12_000,
			output: 3_000,
			cacheRead: 40_000,
			cacheWrite: 1_000,
			cost,
			today,
			day: d.getTime(),
			sub,
			models,
		};
	};

	it("usage: several sessions and models, a subscription, at two widths; nothing spent", async () => {
		const opus = "anthropic/claude-opus-5-5";
		const haiku = "anthropic/claude-haiku-5-5";
		const rows = [
			at(1, {
				id: "u1",
				name: "big job",
				model: opus,
				usage: spent(12.5, 2, { [opus]: { cost: 12.5, tokens: 56_000 } }),
			}),
			at(2, {
				id: "u2",
				name: "small job with a rather long name that gets cut",
				model: haiku,
				usage: spent(0.3, 0.3, { [haiku]: { cost: 0.3, tokens: 56_000 } }, true),
			}),
			at(3, {
				id: "u3",
				name: "mixed\nlines",
				model: haiku,
				usage: spent(1.1, 0, { [opus]: { cost: 1, tokens: 20_000 }, [haiku]: { cost: 0.1, tokens: 36_000 } }),
			}),
			at(4, { id: "u4", name: "idle" }),
		];
		const { view } = await start(rows);
		await run(view, "/usage");
		expect(shot(view)).toMatchSnapshot();
		expect(shot(view, 50)).toMatchSnapshot();
		view.handleInput("\x1b");
		const none = await start([at(1, { name: "fresh" })]);
		await run(none.view, "/usage");
		expect(shot(none.view)).toMatchSnapshot();
	});

	const ev = (seq: number, ago: number, over: Partial<RoostEvent>): RoostEvent => ({
		seq,
		at: NOW - ago,
		kind: "dispatch",
		id: "j1",
		name: "fix tests",
		who: "user",
		...over,
	});

	it("log: every kind of event with its tone, newest first; scrolled; a long list cut at 200; empty", async () => {
		const { view, client } = await start([at(1, { id: "j1", name: "fix tests" })]);
		await run(view, "/log");
		expect(shot(view)).toMatchSnapshot();
		client.log = [
			ev(1, 7200_000, {}),
			ev(2, 3600_000, {
				kind: "state",
				state: "blocked",
				from: "working",
				waitingFor: "question",
				text: "Which branch?",
			}),
			ev(3, 1800_000, { kind: "state", state: "failed", from: "working", text: "exit 1" }),
			ev(4, 600_000, { kind: "state", state: "done", from: "working", text: "all green" }),
			ev(5, 300_000, { kind: "state", state: "working", from: "blocked", text: null }),
			ev(6, 60_000, { kind: "resume", who: null, why: "crashed", text: null }),
			ev(7, 10_000, { kind: "reply", who: "user", text: "main please" }),
			ev(8, 5_000, { kind: "removed", who: null }),
		];
		await run(view, "/log");
		expect(shot(view)).toMatchSnapshot();
		expect(shot(view, 40)).toMatchSnapshot();
		view.handleInput("\x1b");
		client.log = Array.from({ length: 230 }, (_, i) =>
			ev(i + 1, (230 - i) * 1000, { kind: "reply", who: "user", text: `note ${i}` }),
		);
		await run(view, "/log");
		expect(shot(view)).toMatchSnapshot();
		for (let i = 0; i < 5; i++) view.handleInput("\x1b[B");
		expect(shot(view)).toMatchSnapshot();
		view.handleInput("\x1b[6~");
		expect(shot(view)).toMatchSnapshot();
		view.handleInput("\x1b[5~");
		expect(shot(view)).toMatchSnapshot();
		for (let i = 0; i < 30; i++) view.handleInput("\x1b[6~"); // the end: the 200th newest is the last
		expect(shot(view)).toMatchSnapshot();
	});

	it("log: filtered to one session with its title; nothing about it", async () => {
		const { view, client } = await start([
			at(1, { id: "j1", name: "fix tests" }),
			at(2, { id: "j2", name: "other" }),
		]);
		client.log = [
			ev(1, 90_000, { id: "j1" }),
			ev(2, 60_000, { id: "j2", name: "other", kind: "state", state: "done", from: "working", text: "fine" }),
			ev(3, 30_000, { id: "j1", kind: "reply", who: "user", text: "hello" }),
		];
		view.handleInput(" ");
		await run(view, "/log");
		expect(shot(view)).toMatchSnapshot();
		view.handleInput("\x1b");
		client.log = [ev(1, 60_000, { id: "j2", name: "other" })];
		await run(view, "/log");
		expect(shot(view)).toMatchSnapshot();
	});
});

// M79: the view (the list, or a row's peek) and what is open on top of it (help, a picker, a
// rename, an overlay), pinned before they became two fields: each sequence of keys, screen by screen
describe("M79: views and layers, pinned", () => {
	const shot = (view: AgentView) => view.render(100).join("\n");
	const rowsFor = () => [
		row({
			id: "m1",
			name: "alpha work",
			state: "blocked",
			status: "waiting",
			waitingFor: "question",
			question: "which db?",
			choices: ["postgres", "sqlite"],
		}),
		row({ id: "m2", name: "beta work" }),
	];
	const keys = async (view: AgentView, seq: string[]) => {
		const out: string[] = [];
		for (const k of seq) {
			view.handleInput(k);
			await sleep(30);
			out.push(`--- ${JSON.stringify(k)}\n${shot(view)}`);
		}
		return out.join("\n");
	};

	it("peek, a picker over it (Ctrl+L), back to the peek, closed", async () => {
		const { view } = setup(rowsFor());
		await view.start();
		expect(await keys(view, [" ", "\x0c", "\x1b[B", "\x1b", "\x1b"])).toMatchSnapshot();
		view.dispose();
	});

	it("help over the list and over a peek; any key closes it", async () => {
		const { view } = setup(rowsFor());
		await view.start();
		expect(await keys(view, ["?", "x", "\x7f", " ", "?", "j", "\x1b"])).toMatchSnapshot();
		view.dispose();
	});

	it("a rename over a peek, cancelled; over the list, done", async () => {
		const { view } = setup(rowsFor());
		await view.start();
		expect(await keys(view, [" ", "\x12", "z", "\x1b", "\x1b", "\x12", "\x7f", "\x7f", "q", "\r"])).toMatchSnapshot();
		view.dispose();
	});

	it("the list's own keys do nothing in a peek (Ctrl+O mark, Ctrl+F), and do in the list", async () => {
		const { view } = setup(rowsFor());
		await view.start();
		expect(await keys(view, [" ", "\x0f", "\x06", "\x1b", "\x0f", "\x1b", "\x06"])).toMatchSnapshot();
		view.dispose();
	});
});
