// T19: the foreground role of builtin:roost: the left arrow on an empty prompt, /bg (and /background), /bg-fork. The
// daemon and the hub are fakes (the role takes them as deps); the dispatch requests are xpi-roost's real ones.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DaemonError } from "xpi-roost";
import { ProjectTrustStore } from "../src/core/trust-manager.ts";
import {
	CONTINUE,
	type ForegroundDeps,
	isPromptEditor,
	leftArrowSetting,
	registerForeground,
	startProblem,
} from "../src/extensions/roost/foreground.ts";
import { NO_PTY_MESSAGE, WINDOWS_MESSAGE } from "../src/extensions/roost/messages.ts";
import { setHubApi } from "../src/extensions/roost/view-state.ts";

type Handler = (event: any, ctx?: any) => unknown;
type Request = { command: string[]; sessionFile: string; name: string; origin: string; cwd: string };

let home: string;
let agentDir: string;
let work: string;
let sessionFile: string;
const savedAgentDir = process.env.XPI_CODING_AGENT_DIR;
const savedArgv = process.argv;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "roost-fg-"));
	agentDir = join(home, "agent");
	work = join(home, "work");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(work, { recursive: true });
	process.env.XPI_CODING_AGENT_DIR = agentDir;
	process.argv = [process.execPath, "/xpi/cli.js"];
	sessionFile = join(work, "s.jsonl");
	writeFileSync(sessionFile, "{}\n");
});
afterEach(() => {
	setHubApi(undefined);
	process.argv = savedArgv;
	if (savedAgentDir === undefined) delete process.env.XPI_CODING_AGENT_DIR;
	else process.env.XPI_CODING_AGENT_DIR = savedAgentDir;
	rmSync(home, { recursive: true, force: true });
});

/** A runtime's extension API; `stale()` makes every call throw, as xpi's does once its session is replaced. */
function fakePi(commandName = "review") {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
	const emitted: [string, unknown][] = [];
	let isStale = false;
	const live = () => {
		if (isStale) throw new Error("This extension ctx is stale");
	};
	const pi = {
		on: (name: string, h: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), h]),
		registerCommand: (name: string, c: { handler: (args: string, ctx: any) => Promise<void> }) =>
			commands.set(name, c.handler),
		getFlag: () => undefined,
		getThinkingLevel: () => "low",
		getCommands: () => {
			live();
			return [{ name: commandName, source: "prompt" }];
		},
		events: {
			emit(channel: string, data: unknown) {
				live();
				emitted.push([channel, data]);
			},
		},
	};
	// index.ts does so on every load of builtin:roost
	setHubApi(pi);
	const emit = (name: string, event: any = {}, ctx?: any) => {
		for (const h of handlers.get(name) ?? []) h(event, ctx);
	};
	return {
		pi: pi as any,
		emit,
		commands,
		emitted,
		stale: () => {
			isStale = true;
		},
	};
}

/**
 * The fakes the role is given: the daemon records what it is asked, the hub what it opens. `dispatch`: `ok` answers,
 * `refuse` answers no, `lost` takes the request (a worker starts on the file) but its answer never comes; `list` is
 * what the daemon's list then says (`fail`: no answer either).
 */
function fakeDeps(
	problem?: string,
	o: { dispatch?: "ok" | "refuse" | "lost"; list?: "running" | "ended" | "none" | "fail" } = {},
) {
	const dispatched: Request[] = [];
	const opened: unknown[] = [];
	const ops: string[] = [];
	const deps: ForegroundDeps = {
		problem: () => problem,
		dispatchTimeoutMs: 1,
		openHub: async (_ctx, opts) => {
			opened.push(opts);
		},
		connect: async () =>
			({
				isClosed: false,
				request: async (op: string, args: Request) => {
					ops.push(op);
					if (op === "list") {
						if (o.list === "fail") throw new Error("socket closed");
						const file = dispatched[0]?.sessionFile ?? "";
						if (o.list === "none" || !file) return { jobs: [] };
						return {
							jobs: [{ id: "job1", name: "my chat", sessionFile: file, endedAt: o.list === "ended" ? 1 : null }],
						};
					}
					dispatched.push(args);
					if (o.dispatch === "refuse")
						throw Object.assign(new DaemonError("the daemon is shutting down"), { fromDaemon: true });
					if (o.dispatch === "lost") throw new Error("socket closed");
					return { id: "job1", name: args.name };
				},
				close() {},
			}) as never,
	};
	return { deps, dispatched, opened, ops };
}

const editor = { getText: () => "", setText() {}, onSubmit: () => {} };
const selector = { handleInput() {}, render: () => [] };

/** `file` null: --no-session. */
/**
 * `file` null: --no-session. `onSwitch`: what the new runtime does as it starts (loads builtin:roost again);
 * `fresh`: how the switch to the fresh session ends.
 */
function fakeCtx(
	file: string | null = sessionFile,
	o: { trusted?: boolean; onSwitch?: () => void; fresh?: "ok" | "cancel" | "throw" } = {},
) {
	let stale = false;
	let editorText = "";
	let focused: unknown = editor;
	let inputs: ((data: string) => any)[] = [];
	const notes: string[] = [];
	const ui = {
		notify: (t: string) => notes.push(t),
		setStatus() {},
		setWidget(_k: string, f: (tui: any) => unknown) {
			f({ getFocusedComponent: () => focused });
		},
		onTerminalInput(fn: (d: string) => any) {
			inputs.push(fn);
			return () => {
				inputs = inputs.filter((x) => x !== fn);
			};
		},
		getEditorText: () => editorText,
		setEditorText: (t: string) => {
			editorText = t;
		},
	};
	const calls = { abort: 0, switches: [] as string[] };
	const ctx = {
		hasUI: true,
		cwd: work,
		model: { provider: "a", id: "m" },
		isProjectTrusted: () => o.trusted ?? true,
		get ui() {
			if (stale) throw new Error("ctx is stale");
			return ui;
		},
		sessionManager: { getSessionFile: () => file ?? undefined, getSessionName: () => "my chat", getBranch: () => [] },
		abort: (): void => {
			calls.abort++;
		},
		waitForIdle: async () => {},
		switchSession: async (path: string, opts?: { withSession?: (next: any) => Promise<void> }) => {
			calls.switches.push(path);
			stale = true;
			o.onSwitch?.();
			const next = {
				ui,
				switchSession: async (p: string) => {
					calls.switches.push(p);
					if (p === file) return { cancelled: false };
					if (o.fresh === "throw") throw new Error("disk full");
					return { cancelled: o.fresh === "cancel" };
				},
			};
			await opts?.withSession?.(next);
			return { cancelled: false };
		},
	};
	return {
		ctx,
		calls,
		notes,
		// as xpi does: listeners in order, the first answer wins
		press: (data: string) => {
			for (const fn of inputs) {
				const r = fn(data);
				if (r !== undefined) return r;
			}
			return undefined;
		},
		focus: (c: unknown) => {
			focused = c;
		},
		type: (t: string) => {
			editorText = t;
		},
		get editorText() {
			return editorText;
		},
	};
}

const LEFT = "\x1b[D";

describe("the left arrow on the prompt", () => {
	it("submits /bg only from an empty, focused prompt editor", () => {
		const { pi, emit } = fakePi();
		registerForeground(pi, fakeDeps().deps);
		const f = fakeCtx();
		emit("session_start", {}, f.ctx);
		f.type("draft");
		expect(f.press(LEFT)).toBeUndefined();
		f.type("");
		f.focus(selector); // /model, /tree, … took the editor's place
		expect(f.press(LEFT)).toBeUndefined();
		f.focus(editor);
		expect(f.press(LEFT)).toEqual({ data: "\r" });
		expect(f.editorText).toBe("/bg");
		// a second press before the command runs is swallowed, not a second /bg
		f.type("");
		expect(f.press(LEFT)).toEqual({ consume: true });
	});

	it("is off with leftArrowOpensAgents false (a project's value over the user's), and in a hand-off session", () => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ roost: { leftArrowOpensAgents: false } }));
		const { pi, emit } = fakePi();
		registerForeground(pi, fakeDeps().deps);
		const f = fakeCtx();
		emit("session_start", {}, f.ctx);
		expect(f.press(LEFT)).toBeUndefined();
		const g = fakeCtx(join(agentDir, "xpi-roost", "scratch", "x.jsonl"));
		writeFileSync(join(agentDir, "settings.json"), "{}");
		emit("session_start", {}, g.ctx);
		expect(g.press(LEFT)).toBeUndefined();
		const read = (global: unknown, project: unknown) =>
			leftArrowSetting({ getGlobalSettings: () => global as never, getProjectSettings: () => project as never });
		expect(read({}, {})).toBe(true);
		expect(read({ roost: { leftArrowOpensAgents: false } }, {})).toBe(false);
		expect(read({ roost: { leftArrowOpensAgents: false } }, { roost: { leftArrowOpensAgents: true } })).toBe(true);
		expect(read({ roost: { leftArrowOpensAgents: "no" } }, {})).toBe(true);
	});

	it("tells the prompt editor from selectors", () => {
		expect(isPromptEditor(editor as never)).toBe(true);
		expect(isPromptEditor(selector as never)).toBe(false);
		expect(isPromptEditor(null)).toBe(false);
	});
});

describe("/bg", () => {
	it("hands the file over, opens the hub on it, starts a fresh session and never touches the stale ctx", async () => {
		const { pi, emit, commands } = fakePi();
		const { deps, dispatched, opened } = fakeDeps();
		registerForeground(pi, deps);
		const f = fakeCtx();
		emit("session_start", {}, f.ctx);
		await expect(commands.get("bg")!("", f.ctx)).resolves.toBeUndefined();
		expect(dispatched[0]).toMatchObject({ sessionFile, origin: "adopt", name: "my chat", cwd: work });
		// this xpi's live model and thinking level; no task
		expect(dispatched[0]!.command.slice(1)).toEqual([
			"/xpi/cli.js",
			"--session",
			sessionFile,
			"--model",
			"a/m",
			"--thinking",
			"low",
			"--no-approve",
		]);
		expect(opened).toEqual([
			expect.objectContaining({ origin: "job1", banner: "Your conversation moved to the background" }),
		]);
		expect((opened[0] as { commands: () => unknown[] }).commands()).toEqual([{ name: "review", source: "prompt" }]);
		expect(f.calls.switches[0]).toContain(join(agentDir, "xpi-roost", "scratch"));
		// then a fresh conversation next to the moved one, not in the scratch directory
		expect(f.calls.switches[1]?.startsWith(`${work}/`)).toBe(true);
		expect(commands.has("background")).toBe(true);
	});

	it("gives the hub the new runtime's commands and event bus: the API /bg was registered with is stale after the switch", async () => {
		const first = fakePi();
		const { deps, opened } = fakeDeps();
		registerForeground(first.pi, deps);
		let second: ReturnType<typeof fakePi> | undefined;
		const f = fakeCtx(sessionFile, {
			onSwitch: () => {
				first.stale();
				second = fakePi("model-from-new-runtime");
			},
		});
		await first.commands.get("bg")!("", f.ctx);
		const hub = opened[0] as { commands: () => unknown[]; events: { emit(c: string, d: unknown): void } };
		expect(hub.commands()).toEqual([{ name: "model-from-new-runtime", source: "prompt" }]);
		hub.events.emit("roost:attach", { id: "job1" });
		expect(second!.emitted).toEqual([["roost:attach", { id: "job1" }]]);
		// a runtime that has gone stale too: no commands and a dropped event, never a throw into the hub's keys
		second!.stale();
		expect(hub.commands()).toEqual([]);
		expect(() => hub.events.emit("roost:attach", {})).not.toThrow();
	});

	it("never goes back to the file when the dispatch's answer was lost but the daemon runs it", async () => {
		const { pi, commands } = fakePi();
		const { deps, opened, ops } = fakeDeps(undefined, { dispatch: "lost", list: "running" });
		registerForeground(pi, deps);
		const f = fakeCtx();
		await commands.get("bg")!("", f.ctx);
		expect(ops).toEqual(["dispatch", "list"]);
		expect(f.calls.switches).not.toContain(sessionFile);
		expect(f.calls.switches[1]?.startsWith(`${work}/`)).toBe(true);
		expect(opened).toEqual([expect.objectContaining({ origin: "job1" })]);
		expect(f.notes.join()).not.toMatch(/could not move/);
	});

	it("goes back to the file only when nothing runs on it: a refusal, or a lost answer and no running job", async () => {
		for (const o of [
			{ dispatch: "refuse" },
			{ dispatch: "lost", list: "none" },
			{ dispatch: "lost", list: "ended" },
		] as const) {
			const { pi, commands } = fakePi();
			const { deps, opened } = fakeDeps(undefined, o);
			registerForeground(pi, deps);
			const f = fakeCtx();
			await commands.get("bg")!("", f.ctx);
			expect(f.calls.switches[1], JSON.stringify(o)).toBe(sessionFile);
			expect(opened).toEqual([]);
			expect(f.notes.join()).toMatch(/could not move to the background/);
		}
	});

	it("stays out of the file when it cannot tell whether the daemon runs it", async () => {
		const { pi, commands } = fakePi();
		const { deps, opened } = fakeDeps(undefined, { dispatch: "lost", list: "fail" });
		registerForeground(pi, deps);
		const f = fakeCtx();
		await commands.get("bg")!("", f.ctx);
		expect(f.calls.switches).not.toContain(sessionFile);
		expect(f.calls.switches[1]?.startsWith(`${work}/`)).toBe(true);
		expect(opened).toHaveLength(1);
		expect(f.notes.join()).toMatch(/may run in the background; check \/agents/);
	});

	it("says how to leave the hand-off session when the fresh session cannot be opened", async () => {
		for (const fresh of ["cancel", "throw"] as const) {
			const { pi, commands } = fakePi();
			const { deps } = fakeDeps();
			registerForeground(pi, deps);
			const f = fakeCtx(sessionFile, { fresh });
			await expect(commands.get("bg")!("", f.ctx)).resolves.toBeUndefined();
			expect(f.notes, fresh).toContain("could not open a fresh session; use /new");
			expect(f.calls.switches).not.toContain(sessionFile);
		}
	});

	it("hands on the trust decision by xpi --bg's rule: the answer for a folder with something to trust, a stored one, else no", async () => {
		mkdirSync(join(work, ".agents", "skills"), { recursive: true });
		const run = async (trusted: boolean) => {
			const { pi, emit, commands } = fakePi();
			const { deps, dispatched } = fakeDeps();
			registerForeground(pi, deps);
			const f = fakeCtx(sessionFile, { trusted });
			emit("session_start", {}, f.ctx);
			await commands.get("bg")!("", f.ctx);
			return dispatched[0]!.command.at(-1);
		};
		expect(await run(true)).toBe("--approve");
		expect(await run(false)).toBe("--no-approve");
		rmSync(join(work, ".agents"), { recursive: true });
		// nothing to trust: xpi's own yes is not handed on, a stored decision is
		expect(await run(true)).toBe("--no-approve");
		new ProjectTrustStore(agentDir).set(work, true);
		expect(await run(true)).toBe("--approve");
	});

	it("interrupts a running turn after its tool and continues in the background", async () => {
		const { pi, emit, commands } = fakePi();
		const { deps, dispatched } = fakeDeps();
		registerForeground(pi, deps);
		const f = fakeCtx();
		emit("session_start", {}, f.ctx);
		emit("agent_start");
		emit("tool_execution_start", {});
		const moved = commands.get("bg")!("then run the tests", f.ctx);
		await new Promise((r) => setTimeout(r, 20));
		expect(f.calls.abort).toBe(0); // still waiting for the tool
		emit("tool_execution_end", {});
		f.ctx.abort = () => {
			f.calls.abort++;
			emit("agent_settled", { aborted: true });
		};
		await moved;
		expect(f.calls.abort).toBe(1);
		expect(dispatched[0]?.command).toContain(`${CONTINUE}\n\nthen run the tests`);
	});

	it("keeps the conversation when the user stops the turn", async () => {
		const { pi, emit, commands } = fakePi();
		const { deps, dispatched } = fakeDeps();
		registerForeground(pi, deps);
		const f = fakeCtx();
		emit("session_start", {}, f.ctx);
		emit("agent_start");
		emit("tool_execution_start", {});
		const moved = commands.get("bg")!("", f.ctx);
		emit("tool_execution_end", {});
		emit("agent_settled", { aborted: true });
		await moved;
		expect(f.calls.switches).toEqual([]);
		expect(dispatched).toEqual([]);
		expect(f.notes.join()).toMatch(/you stopped the turn/);
	});

	it("refuses during compaction, in a hand-off session, without a session file, and where roost cannot run", async () => {
		const { pi, emit, commands } = fakePi();
		const { deps, dispatched } = fakeDeps();
		registerForeground(pi, deps);
		const f = fakeCtx();
		emit("session_before_compact");
		await commands.get("bg")!("", f.ctx);
		emit("session_compact");
		const scratch = fakeCtx(join(agentDir, "xpi-roost", "scratch", "x.jsonl"));
		await commands.get("bg")!("", scratch.ctx);
		const none = fakeCtx(null);
		await commands.get("bg")!("", none.ctx);
		expect(f.notes.join()).toMatch(/compacted/);
		expect(scratch.notes.join()).toMatch(/hand-off session/);
		expect(none.notes.join()).toMatch(/not saved/);
		const off = fakePi();
		registerForeground(off.pi, fakeDeps(WINDOWS_MESSAGE).deps);
		const w = fakeCtx();
		await off.commands.get("bg")!("", w.ctx);
		await off.commands.get("bg-fork")!("", w.ctx);
		expect(w.notes).toEqual([WINDOWS_MESSAGE, WINDOWS_MESSAGE]);
		expect(dispatched).toEqual([]);
	});

	it("opens the hub for a conversation xpi has not written yet", async () => {
		const { pi, emit, commands } = fakePi();
		const { deps, dispatched, opened } = fakeDeps();
		registerForeground(pi, deps);
		const f = fakeCtx(join(work, "unwritten.jsonl"));
		emit("session_start", {}, f.ctx);
		await commands.get("bg")!("", f.ctx);
		expect(opened).toHaveLength(1);
		expect(f.calls.switches).toEqual([]);
		expect(dispatched).toEqual([]);
	});
});

describe("/bg-fork", () => {
	it("copies the conversation into a new background session and stays", async () => {
		writeFileSync(
			sessionFile,
			`${JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: new Date().toISOString(), cwd: work })}\n${JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "hi", timestamp: 1 } })}\n`,
		);
		const { pi, commands } = fakePi();
		const { deps, dispatched } = fakeDeps();
		registerForeground(pi, deps);
		const f = fakeCtx();
		await commands.get("bg-fork")!("try the other way", f.ctx);
		expect(dispatched).toHaveLength(1);
		expect(dispatched[0]).toMatchObject({ origin: "fork", name: "my chat (fork)", cwd: work });
		expect(dispatched[0]!.sessionFile).not.toBe(sessionFile);
		expect(dispatched[0]!.command).toContain("try the other way");
		expect(f.notes.join()).toMatch(/session running · my chat \(fork\) · job1/);
		expect(f.calls.switches).toEqual([]);
	});

	it("reports a fork whose answer was lost by what the daemon's list says", async () => {
		writeFileSync(
			sessionFile,
			`${JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: new Date().toISOString(), cwd: work })}\n${JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "hi", timestamp: 1 } })}\n`,
		);
		const cases = [
			["running", /session running · my chat · job1/],
			["none", /could not fork: no answer/],
			["fail", /the fork may have started .*check \/agents/],
		] as const;
		for (const [list, note] of cases) {
			const { pi, commands } = fakePi();
			const { deps } = fakeDeps(undefined, { dispatch: "lost", list });
			registerForeground(pi, deps);
			const f = fakeCtx();
			await commands.get("bg-fork")!("", f.ctx);
			expect(f.notes.join(), list).toMatch(note);
		}
	});

	it("has nothing to fork before the first reply is saved", async () => {
		const { pi, commands } = fakePi();
		const { deps, dispatched } = fakeDeps();
		registerForeground(pi, deps);
		const f = fakeCtx(join(work, "unwritten.jsonl"));
		await commands.get("bg-fork")!("", f.ctx);
		expect(f.notes.join()).toMatch(/nothing to fork yet/);
		expect(dispatched).toEqual([]);
	});
});

it("startProblem: Windows, a standalone binary and a missing node-pty each say so", () => {
	const entries = { daemonEntry: "/d.js", hostEntry: "/h.js" };
	expect(startProblem({ platform: "win32", entries, ptyFound: () => true })).toBe(WINDOWS_MESSAGE);
	expect(startProblem({ platform: "darwin", entries: undefined, ptyFound: () => true })).toMatch(/npm installation/);
	expect(startProblem({ platform: "darwin", entries, ptyFound: () => false })).toBe(
		NO_PTY_MESSAGE.replace(/^xpi --bg: /, ""),
	);
	expect(startProblem({ platform: "linux", entries, ptyFound: () => true })).toBeUndefined();
});
