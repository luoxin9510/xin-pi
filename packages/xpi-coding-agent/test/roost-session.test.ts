// builtin:roost in every xpi session: the session write lock (DM-8); an ordinary start contacts no daemon; nothing in a
// subagent child; `--bg` (where it cannot run, the settings a new session gets, a session started under a real daemon);
// SIGUSR2, which the host sends on attach, does not end a session that reports attachSignal.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DaemonClient } from "xpi-roost";
import { readWriterLock } from "xpi-roost/session";
import { processStartToken } from "../../xpi-roost/src/lib/proc.ts";
import { backgroundAndExit, backgroundedText, chosenOnCommandLine } from "../src/extensions/roost/background.ts";
import roost, { bgArgsProblem, bgProblem, registerWriteLock } from "../src/extensions/roost/index.ts";
import { BINARY_MESSAGE, NO_PTY_MESSAGE, WINDOWS_MESSAGE } from "../src/extensions/roost/messages.ts";
import { launchSettings } from "../src/extensions/roost/settings.ts";

type Handler = (event: any, ctx?: any) => unknown;

const ENV = [
	"ROOST_JOB_ID",
	"ROOST_JOB_TOKEN",
	"ROOST_SOCKET",
	"ROOST_JOB_DIR",
	"ROOST_AGENT_DIR",
	"ROOST_HOME",
	"ROOST_RUNTIME_DIR",
	"ROOST_HOST_ENTRY",
	"ROOST_PARENT_PID",
	"XPI_SUBAGENT_DEPTH",
	"XPI_CODING_AGENT_DIR",
	"ROOST_TEST_SECRET",
];
const saved: Record<string, string | undefined> = {};
let dir: string;
const children: ChildProcess[] = [];

beforeEach(() => {
	for (const k of ENV) {
		saved[k] = process.env[k];
		delete process.env[k];
	}
	dir = mkdtempSync(join(tmpdir(), "xroost-ses-"));
});
afterEach(() => {
	for (const c of children.splice(0)) if (c.exitCode === null) c.kill("SIGKILL");
	rmSync(dir, { recursive: true, force: true });
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

function fakePi(flags: Record<string, string | boolean> = {}) {
	const handlers = new Map<string, Handler[]>();
	const registered: { flags: Map<string, any> } = { flags: new Map() };
	const pi = {
		on: (name: string, h: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), h]),
		registerFlag: (name: string, o: unknown) => registered.flags.set(name, o),
		getFlag: (name: string) => flags[name],
		registerEntryRenderer() {},
		registerMessageRenderer() {},
		getThinkingLevel: () => "off",
		getCommands: () => [],
		getSettings: () => ({}),
		appendEntry() {},
	};
	const emit = async (name: string, event: any = {}, ctx?: any) => {
		for (const h of handlers.get(name) ?? []) await h(event, ctx);
	};
	return { pi: pi as any, emit, handlers, registered };
}

const sessionCtx = (file: string | undefined, notes: string[] = []) => ({
	hasUI: true,
	cwd: dir,
	model: undefined,
	isIdle: () => true,
	getContextUsage: () => undefined,
	modelRegistry: { isUsingOAuth: () => false, getProvider: () => undefined },
	sessionManager: {
		getSessionFile: () => file,
		getSessionName: () => undefined,
		getBranch: () => [],
		getEntries: () => [],
	},
	ui: {
		notify: (m: string) => notes.push(m),
		setWidget() {},
		getEditorText: () => "",
		setEditorText() {},
		onTerminalInput: () => () => {},
	},
});

describe("the session write lock (DM-8)", () => {
	it("is taken at session_start, moves with a session switch, and is released at session_shutdown", async () => {
		const { pi, emit } = fakePi();
		registerWriteLock(pi);
		const a = join(dir, "sessions", "a.jsonl");
		const b = join(dir, "sessions", "b.jsonl");
		await emit("session_start", { reason: "startup" }, sessionCtx(a));
		expect(readWriterLock(a)?.pid).toBe(process.pid);
		await emit("session_shutdown", { reason: "new" });
		await emit("session_start", { reason: "new" }, sessionCtx(b));
		expect(existsSync(`${a}.lock`)).toBe(false);
		expect(readWriterLock(b)?.pid).toBe(process.pid);
		await emit("session_shutdown", { reason: "quit" });
		expect(existsSync(`${b}.lock`)).toBe(false);
	});

	it("a file another live process holds is not taken (the user is told), and its lock is left alone", async () => {
		const other = spawn("sleep", ["30"], { stdio: "ignore" });
		children.push(other);
		const file = join(dir, "s.jsonl");
		let token: string | undefined;
		for (let i = 0; i < 50 && !token; i++) {
			token = processStartToken(other.pid!);
			if (!token) await new Promise((r) => setTimeout(r, 20));
		}
		writeFileSync(`${file}.lock`, JSON.stringify({ pid: other.pid, token, at: Date.now() }));
		const { pi, emit } = fakePi();
		registerWriteLock(pi);
		const notes: string[] = [];
		await emit("session_start", { reason: "startup" }, sessionCtx(file, notes));
		expect(notes).toEqual([`this session is also open in process ${other.pid}`]);
		await emit("session_shutdown", { reason: "quit" });
		expect(readWriterLock(file)?.pid).toBe(other.pid);
	});

	it("nothing without a session file, nor on Windows", async () => {
		const none = fakePi();
		registerWriteLock(none.pi);
		await none.emit("session_start", { reason: "startup" }, sessionCtx(undefined));
		const win = fakePi();
		registerWriteLock(win.pi, "win32");
		const file = join(dir, "w.jsonl");
		await win.emit("session_start", { reason: "startup" }, sessionCtx(file));
		expect(existsSync(`${file}.lock`)).toBe(false);
	});
});

/** A daemon socket where this agent directory's roost would be: it counts who connects. */
async function listeningDaemon(socket: string): Promise<{ connections: () => number; close: () => Promise<void> }> {
	let n = 0;
	const server: Server = createServer((s) => {
		n++;
		s.on("error", () => {});
		s.on("data", () => {});
	});
	await new Promise<void>((r) => server.listen(socket, () => r()));
	return { connections: () => n, close: () => new Promise((r) => server.close(() => r())) };
}

describe("an ordinary start", () => {
	it("registers --bg and --bg-name, takes the lock, and contacts no daemon", async () => {
		const rt = mkdtempSync("/tmp/xroost-rt-");
		try {
			process.env.ROOST_AGENT_DIR = dir;
			process.env.ROOST_RUNTIME_DIR = rt;
			const daemon = await listeningDaemon(join(rt, "daemon.sock"));
			const { pi, emit, registered } = fakePi();
			await roost(pi);
			expect([...registered.flags.keys()]).toEqual(["bg", "bg-name"]);
			const file = join(dir, "o.jsonl");
			await emit("session_start", { reason: "startup" }, sessionCtx(file));
			expect(readWriterLock(file)?.pid).toBe(process.pid);
			await emit("session_shutdown", { reason: "quit" });
			await new Promise((r) => setTimeout(r, 100));
			expect(daemon.connections()).toBe(0);

			// a session the daemon started (the host gave it a job's identity): the worker reports
			Object.assign(process.env, {
				ROOST_JOB_ID: "j1",
				ROOST_JOB_TOKEN: "t",
				ROOST_SOCKET: join(rt, "daemon.sock"),
				ROOST_JOB_DIR: dir,
				ROOST_HOME: dir,
			});
			const worker = fakePi();
			await roost(worker.pi);
			await worker.emit("session_start", { reason: "startup" }, sessionCtx(join(dir, "w.jsonl")));
			const start = Date.now();
			while (daemon.connections() === 0 && Date.now() - start < 3000) await new Promise((r) => setTimeout(r, 20));
			expect(daemon.connections()).toBeGreaterThan(0);
			await worker.emit("session_shutdown", { reason: "quit" });
			await daemon.close();
		} finally {
			rmSync(rt, { recursive: true, force: true });
		}
	});

	it("its static imports reach no daemon client: only xpi-roost/session and the messages (the rest is loaded lazily)", () => {
		const imports = (file: string) =>
			[
				...readFileSync(resolve(__dirname, "../src/extensions/roost", file), "utf8").matchAll(
					/^import\s+(?!type\b)[^"']*["']([^"']+)["']/gm,
				),
			].map((m) => m[1]!);
		expect(imports("index.ts").filter((i) => i.includes("roost") || i.startsWith("./"))).toEqual([
			"xpi-roost/session",
			"./messages.ts",
		]);
		expect(imports("messages.ts")).toEqual(["node:module"]);
	});

	it("a process a roost session starts (the job's id and socket inherited, not its token) loads nothing of the worker; /reload keeps it", async () => {
		const loaded: number[] = [];
		vi.doMock("../src/extensions/roost/worker.ts", () => {
			loaded.push(1);
			return { registerWorker: () => loaded.push(2) };
		});
		try {
			// a child: the worker took the token out of the environment before it ran anything
			Object.assign(process.env, { ROOST_JOB_ID: "j9", ROOST_SOCKET: join(dir, "daemon.sock") });
			const child = fakePi();
			await roost(child.pi);
			expect(loaded).toEqual([]);
			expect([...child.handlers.keys()].sort()).toEqual(["session_shutdown", "session_start"]);

			// the session itself: it has the token; after the worker took it out, a /reload is still the session
			process.env.ROOST_JOB_TOKEN = "t";
			await roost(fakePi().pi);
			expect(loaded).toEqual([1, 2]);
			delete process.env.ROOST_JOB_TOKEN;
			await roost(fakePi().pi);
			expect(loaded).toEqual([1, 2, 2]);
			// another job's id inherited later (no token) is not this process's
			process.env.ROOST_JOB_ID = "j10";
			await roost(fakePi().pi);
			expect(loaded).toEqual([1, 2, 2]);
		} finally {
			vi.doUnmock("../src/extensions/roost/worker.ts");
		}
	});

	it("a subagent child gets nothing: no flags, no lock, no worker", async () => {
		process.env.XPI_SUBAGENT_DEPTH = "1";
		const { pi, handlers, registered } = fakePi();
		await roost(pi);
		expect(registered.flags.size).toBe(0);
		expect(handlers.size).toBe(0);
	});
});

describe("--bg", () => {
	const entries = { daemonEntry: "/d.js", hostEntry: "/h.js" };
	it("says before the start why it cannot run here", () => {
		const here = { argv: ["--bg", "go"], terminal: true, ptyFound: () => true };
		expect(bgProblem("  ", { ...here, entries })).toMatch(/--bg needs a task/);
		expect(bgProblem("go", { ...here, platform: "win32", entries })).toBe(WINDOWS_MESSAGE);
		expect(bgProblem("go", { ...here, platform: "darwin", entries: null })).toBe(BINARY_MESSAGE);
		expect(bgProblem("go", { ...here, platform: "linux", entries, ptyFound: () => false })).toBe(NO_PTY_MESSAGE);
		expect(NO_PTY_MESSAGE).toMatch(/needs node-pty.*npm install -g xpi-coding-agent/);
		expect(bgProblem("go", { ...here, platform: "darwin", entries })).toBeUndefined();
		expect(bgProblem("go", { ...here, argv: ["--bg", "go", "--no-session"], platform: "darwin", entries })).toMatch(
			/--no-session/,
		);
		// the flag checks it: a message stops the start
		const { pi, registered } = fakePi();
		void roost(pi);
		expect(registered.flags.get("bg").validate("  ", dir)).toMatch(/--bg needs a task/);
	});

	it("nothing else that xpi would send to the model before it exits, and not --no-session", () => {
		const ok = (argv: string[]) => bgArgsProblem(argv, true);
		expect(
			ok(["--bg", "fix it", "--bg-name", "n", "--model", "a/b", "-e", "x.ts", "--thinking", "low"]),
		).toBeUndefined();
		expect(ok(["--session", "/s.jsonl", "--bg", "go on"])).toBeUndefined();
		// extra messages and @files would be prompted by this process
		expect(ok(["--bg", "fix it", "another message"])).toMatch(/whole task as its value/);
		expect(ok(["--bg", "fix it", "@notes.md"])).toMatch(/whole task as its value/);
		expect(ok(["--bg", "fix it", "--", "more"])).toMatch(/whole task as its value/);
		// so would print mode
		expect(ok(["-p", "--bg", "fix it"])).toMatch(/interactive mode/);
		expect(ok(["--mode", "json", "--bg", "fix it"])).toMatch(/interactive mode/);
		expect(bgArgsProblem(["--bg", "fix it"], false)).toMatch(/needs a terminal/);
		expect(ok(["--no-session", "--bg", "fix it"])).toBe(
			"--bg cannot be combined with --no-session: a background session needs a session file",
		);
	});

	it("the hint names xpi roost attach and ls --json; the command line's model beats the settings'", () => {
		const text = backgroundedText("abcd0001", "run the tests", ["a note"]);
		expect(text).toContain("backgrounded · abcd0001 · run the tests");
		expect(text).toContain("xpi roost attach abcd0001");
		expect(text).toContain("xpi roost ls --json");
		expect(text).toContain("note: a note");
		expect(chosenOnCommandLine(["--model", "a/b", "--bg", "x"])).toEqual({ model: true, thinking: false });
		expect(chosenOnCommandLine(["--thinking=high"])).toEqual({ model: false, thinking: true });
		expect(chosenOnCommandLine(["--bg", "use --model in docs"])).toEqual({ model: false, thinking: false });
	});

	it("a new session's settings: the user's environment keys, a project's dispatch keys, never a project's environment", () => {
		const agentDir = join(dir, "agent");
		const project = join(dir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(project, ".pi"), { recursive: true });
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ roost: { inheritEnv: false, envAllowList: ["MINE"], dispatchModel: "u/m" } }),
		);
		writeFileSync(
			join(project, ".pi", "settings.json"),
			JSON.stringify({
				roost: { inheritEnv: true, envAllowList: ["AWS_SECRET_ACCESS_KEY"], dispatchThinking: "low" },
			}),
		);
		expect(launchSettings(project, true, agentDir)).toEqual({
			env: { extraEnv: ["MINE"], inheritEnv: false, envDenyList: [], workspaceEnv: "off" },
			model: "u/m",
			thinking: "low",
		});
		// an untrusted project's settings are not read
		expect(launchSettings(project, false, agentDir).thinking).toBeUndefined();
	});
});

const ROOST_DIST = resolve(__dirname, "../../xpi-roost/dist");
/**
 * The session's host needs node-pty built and xpi-roost's dist. CI builds both (`npm rebuild node-pty` in the
 * coding-agent job), so there the test fails instead of skipping: a silent skip would hide the only end-to-end `--bg`.
 */
function canStartHosts(): boolean {
	try {
		createRequire(import.meta.url)("node-pty");
	} catch {
		return false;
	}
	return existsSync(join(ROOST_DIST, "daemon/main.js")) && existsSync(join(ROOST_DIST, "host/main.js"));
}

const HOSTS = canStartHosts();

describe("xpi --bg under a real daemon", () => {
	it.skipIf(!HOSTS && !process.env.CI)(
		"starts the session with the task, the dispatch settings and the roost's location whatever the lists say",
		async () => {
			expect(HOSTS, "CI must start PTY hosts: run `npm rebuild node-pty` and build xpi-roost").toBe(true);
			const agentDir = join(dir, "agent");
			mkdirSync(agentDir, { recursive: true });
			// the lists would keep every ROOST_* and XPI_* variable and the secret out
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({
					roost: { inheritEnv: false, envDenyList: ["ROOST_*", "XPI_*"], dispatchModel: "faux/m1" },
				}),
			);
			process.env.XPI_CODING_AGENT_DIR = agentDir;
			process.env.ROOST_PARENT_PID = String(process.pid);
			process.env.ROOST_TEST_SECRET = "s3cret";
			const out = join(dir, "seen.json");
			// the "xpi" the session runs: it writes what it was given
			const fakeXpi = join(dir, "fake-xpi.mjs");
			writeFileSync(
				fakeXpi,
				`import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(out)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env }));
setTimeout(() => {}, 30000);
`,
			);
			const { pi } = fakePi({ "bg-name": "fake run" });
			let shutdown = 0;
			const exits: (() => void)[] = [];
			const ctx = { ...sessionCtx(join(dir, "s1.jsonl")), shutdown: () => shutdown++, isProjectTrusted: () => true };
			const written: string[] = [];
			const write = process.stdout.write.bind(process.stdout);
			let client: DaemonClient | undefined;
			try {
				await backgroundAndExit(pi, ctx as never, "count the files", {
					argv: [process.execPath, fakeXpi, "--bg", "count the files", "--bg-name", "fake run"],
					atExit: (fn) => exits.push(fn),
				});
				expect(shutdown).toBe(1);
				expect(exits).toHaveLength(1);
				process.stdout.write = ((s: string) => {
					written.push(String(s));
					return true;
				}) as typeof process.stdout.write;
				exits[0]!();
				process.stdout.write = write;
				expect(written.join("")).toMatch(/^backgrounded · [0-9a-f]+ · fake run\n/);

				const start = Date.now();
				while (!existsSync(out) && Date.now() - start < 15_000) await new Promise((r) => setTimeout(r, 50));
				const seen = JSON.parse(readFileSync(out, "utf8")) as { argv: string[]; env: Record<string, string> };
				expect(seen.argv).toEqual([
					"--session",
					join(dir, "s1.jsonl"),
					"--model",
					"faux/m1",
					"--",
					"count the files",
				]);
				expect(seen.env.ROOST_AGENT_DIR).toBe(agentDir);
				expect(seen.env.XPI_CODING_AGENT_DIR).toBe(agentDir);
				expect(seen.env.ROOST_HOME).toBe(join(agentDir, "xpi-roost"));
				expect(seen.env.ROOST_RUNTIME_DIR).toBeTruthy();
				expect(seen.env.ROOST_JOB_ID).toBeTruthy();
				expect(seen.env.ROOST_TEST_SECRET).toBeUndefined();
			} finally {
				process.stdout.write = write;
				// this agent directory's daemon and its session
				try {
					process.env.ROOST_AGENT_DIR = agentDir;
					process.env.ROOST_HOME = join(agentDir, "xpi-roost");
					client = await DaemonClient.connect();
					const status = await client.request("status", {});
					await client.request("shutdown", {});
					// The daemon answers, then ends its hosts and writes its state. Wait for it to be gone: a directory
					// removed under it fails with ENOTEMPTY, or comes back with what it writes last.
					const alive = () => {
						try {
							process.kill(status.pid, 0);
							return true;
						} catch {
							return false;
						}
					};
					for (const deadline = Date.now() + 10_000; alive() && Date.now() < deadline; ) {
						await new Promise((r) => setTimeout(r, 50));
					}
					if (alive()) process.kill(status.pid, "SIGKILL");
					rmSync(status.socketDir, { recursive: true, force: true });
				} catch {
					// no daemon
				} finally {
					client?.close();
				}
			}
		},
		30_000,
	);
});

describe("SIGUSR2 (the host's attach signal)", () => {
	const script = (register: boolean) => `
import { registerRecap, sigusr2Handled } from ${JSON.stringify(resolve(__dirname, "../src/extensions/roost/recap.ts"))};
${register ? "registerRecap({ on() {}, registerEntryRenderer() {}, appendEntry() {} }, { report: () => ({}), ctx: () => undefined });" : ""}
process.stdout.write("handled " + sigusr2Handled() + "\\n");
process.kill(process.pid, "SIGUSR2");
setTimeout(() => process.stdout.write("alive\\n"), 200);
`;
	const run = (register: boolean) =>
		spawnSync(process.execPath, ["--input-type=module", "-e", script(register)], {
			cwd: resolve(__dirname, ".."),
			encoding: "utf8",
			timeout: 15_000,
		});

	it("does not end a session that has the handler, which then reports attachSignal; without it, it would", () => {
		const withHandler = run(true);
		expect(withHandler.stderr).toBe("");
		expect(withHandler.stdout).toBe("handled true\nalive\n");
		expect(withHandler.status).toBe(0);
		const without = run(false);
		expect(without.stdout).toBe("handled false\n");
		expect(without.signal).toBe("SIGUSR2");
	});
});
