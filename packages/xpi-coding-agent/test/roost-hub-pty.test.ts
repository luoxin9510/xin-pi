// T17/T19 end to end: the built xpi (dist/bundle/cli.js, `npm run build`) in a pseudo-terminal, read through a headless
// xterm, against a real daemon in a temporary agent directory. The model is a fake one an extension in that directory
// registers (it answers "echo: <the prompt>"), so nothing reaches a provider.
// - `xpi roost hub`: start a session, peek, reply, attach, detach, stop and delete; a shell command; Ctrl+C twice exits.
// - A foreground xpi: the left arrow on its empty prompt hands the conversation to the daemon and opens the hub on it.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import xterm from "@xterm/headless";
import * as pty from "node-pty";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DaemonClient } from "xpi-roost";

const CLI = resolve(__dirname, "../dist/bundle/cli.js");

const FAUX = `import { createAssistantMessageEventStream, fauxAssistantMessage } from "xpi-ai";

export default function (pi) {
	pi.registerProvider("faux", {
		baseUrl: "http://127.0.0.1:9",
		apiKey: "none",
		api: "faux-echo",
		models: [{ id: "echo", name: "Echo", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
		streamSimple: (model, context) => {
			const stream = createAssistantMessageEventStream();
			const last = context.messages.filter((m) => m.role === "user").at(-1);
			const text = typeof last?.content === "string" ? last.content : (last?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join(" ");
			const message = { ...fauxAssistantMessage("echo: " + text), api: model.api, provider: model.provider, model: model.id };
			queueMicrotask(() => {
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason: "stop", message });
				stream.end(message);
			});
			return stream;
		},
	});
}
`;

let root: string;
let agentDir: string;
let work: string;
let env: Record<string, string>;
/** Each xpi this test started, with a promise of its end taken at spawn (node-pty tells only listeners already there). */
const running: { proc: pty.IPty; ended: () => boolean; done: Promise<void> }[] = [];

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "roost-hub-pty-"));
	agentDir = join(root, "agent");
	work = join(root, "work");
	const home = join(root, "home");
	for (const d of [join(agentDir, "extensions"), work, home]) mkdirSync(d, { recursive: true });
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ quietStartup: true, defaultProvider: "faux", defaultModel: "echo", theme: "dark" }),
	);
	writeFileSync(join(agentDir, "extensions", "faux.js"), FAUX);
	env = {
		PATH: process.env.PATH ?? "",
		HOME: home,
		SHELL: "/bin/sh",
		XPI_CODING_AGENT_DIR: agentDir,
		XPI_SKIP_VERSION_CHECK: "1",
		XPI_TELEMETRY: "0",
		TERM: "xterm-256color",
		// the daemon this starts ends with this process (M78)
		ROOST_PARENT_PID: String(process.pid),
	};
});

afterEach(async () => {
	// wait for each xpi still running to end: one still exiting writes into the agent directory while it is removed
	// (ENOTEMPTY); SIGKILL only one that has not ended, never a pid the system may have given to another process
	await Promise.all(
		running.splice(0).map(async ({ proc, ended, done }) => {
			if (ended()) return;
			proc.kill();
			let timer: NodeJS.Timeout | undefined;
			await Promise.race([
				done,
				new Promise<void>((r) => {
					timer = setTimeout(r, 5_000);
				}),
			]);
			clearTimeout(timer);
			if (!ended()) proc.kill("SIGKILL");
		}),
	);
	// this agent directory's daemon, and its sessions with it
	const saved = { dir: process.env.ROOST_AGENT_DIR, home: process.env.ROOST_HOME };
	let client: DaemonClient | undefined;
	try {
		process.env.ROOST_AGENT_DIR = agentDir;
		process.env.ROOST_HOME = join(agentDir, "xpi-roost");
		client = await DaemonClient.connect();
		const status = await client.request("status", {});
		// the daemon, its hosts and their sessions: the daemon waits for its hosts at most 6 s and then exits, so a host
		// and its session may still write into the agent directory as they end
		const pids = [status.pid, ...sessionPids(join(agentDir, "xpi-roost", "jobs"))];
		await client.request("shutdown", {});
		const alive = (pid: number) => {
			try {
				process.kill(pid, 0);
				return true;
			} catch {
				return false;
			}
		};
		for (const deadline = Date.now() + 10_000; pids.some(alive) && Date.now() < deadline; )
			await new Promise((r) => setTimeout(r, 50));
		for (const pid of pids.filter(alive)) process.kill(pid, "SIGKILL");
		rmSync(status.socketDir, { recursive: true, force: true });
	} catch {
		// no daemon
	} finally {
		client?.close();
		if (saved.dir === undefined) delete process.env.ROOST_AGENT_DIR;
		else process.env.ROOST_AGENT_DIR = saved.dir;
		if (saved.home === undefined) delete process.env.ROOST_HOME;
		else process.env.ROOST_HOME = saved.home;
	}
	// a session the daemon ran may still be writing as it ends
	rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}, 30_000);

/**
 * The host and session pids of the jobs still running. An ended job's files keep pids the system may since have given
 * to another process, so those are left out.
 */
function sessionPids(jobs: string): number[] {
	const pids: number[] = [];
	for (const id of existsSync(jobs) ? readdirSync(jobs) : []) {
		try {
			const st = JSON.parse(readFileSync(join(jobs, id, "state.json"), "utf8")) as {
				hostPid?: unknown;
				endedAt?: unknown;
			};
			if (typeof st.endedAt === "number") continue;
			if (typeof st.hostPid === "number") pids.push(st.hostPid);
		} catch {
			// no state yet
		}
		try {
			const worker = JSON.parse(readFileSync(join(jobs, id, "worker.json"), "utf8")) as { pid?: unknown };
			if (typeof worker.pid === "number") pids.push(worker.pid);
		} catch {
			// no worker
		}
	}
	return pids;
}

function terminal(args: string[]) {
	const cols = 100;
	const rows = 30;
	const term = new xterm.Terminal({ cols, rows, allowProposedApi: true });
	const proc = pty.spawn(process.execPath, [CLI, ...args], { name: "xterm-256color", cols, rows, cwd: work, env });
	let exit: number | undefined;
	let ended!: () => void;
	const done = new Promise<void>((r) => {
		ended = r;
	});
	running.push({ proc, ended: () => exit !== undefined, done });
	proc.onData((d) => term.write(d));
	proc.onExit((e) => {
		exit = e.exitCode;
		ended();
	});
	// answer the terminal's own queries, as a real terminal does
	term.onData((reply) => {
		if (exit === undefined) proc.write(reply);
	});
	const screen = () => {
		const buf = term.buffer.active;
		const out: string[] = [];
		for (let i = 0; i < rows; i++) out.push(buf.getLine(buf.viewportY + i)?.translateToString(true) ?? "");
		return out.join("\n");
	};
	const until = async (what: string | RegExp | (() => boolean), ms = 20_000): Promise<string> => {
		const deadline = Date.now() + ms;
		for (;;) {
			const s = screen();
			const ok = typeof what === "function" ? what() : typeof what === "string" ? s.includes(what) : what.test(s);
			if (ok) return s;
			if (Date.now() > deadline) throw new Error(`timed out waiting for ${String(what)}; the screen:\n${s}`);
			await new Promise((r) => setTimeout(r, 50));
		}
	};
	const send = async (data: string) => {
		proc.write(data);
		await new Promise((r) => setTimeout(r, 150));
	};
	return { screen, until, send, exited: () => exit };
}

const KEY = { enter: "\r", esc: "\x1b", left: "\x1b[D", ctrlC: "\x03", ctrlX: "\x18", ctrlZ: "\x1a" };

describe.skipIf(!existsSync(CLI) || process.platform === "win32")(
	"the hub in a terminal (built xpi, a fake model)",
	() => {
		it("xpi roost hub: start, peek, reply, attach, detach, stop, delete; a shell command; Ctrl+C twice exits", async () => {
			const t = terminal(["roost", "hub", work]);
			await t.until("xpi agents");
			expect(t.screen()).toContain("new sessions: model faux/echo (default)");
			// a new session: the task is its first prompt
			await t.send("say hello please");
			await t.send(KEY.enter);
			await t.until("echo: say hello please");
			// peek and reply
			await t.send(" ");
			await t.until("you: say hello please");
			await t.send("and again");
			await t.send(KEY.enter);
			await t.until("› echo: and again");
			await t.send(KEY.esc);
			// attach: the session's own screen, with what happened while nobody watched; the user's app.suspend detaches
			await t.send(KEY.enter);
			const attached = await t.until("While you were away");
			expect(attached).toContain("echo: and again");
			expect(attached).not.toContain("xpi agents");
			await t.send(KEY.ctrlZ);
			await t.until("xpi agents");
			// a shell command
			await t.send("! sleep 300");
			await t.send(KEY.enter);
			await t.until("! sleep 300");
			expect(t.screen()).toMatch(/2 working|1 working · 1 completed/);
			// stop, then delete, both
			for (let i = 0; i < 2; i++) {
				await t.send(KEY.ctrlX);
				await t.until("Ctrl+X again to delete");
				await t.send(KEY.ctrlX);
				await t.until(/deleted · /);
			}
			await t.until("0 needs input · 0 working · 0 completed");
			await t.send(KEY.ctrlC);
			await t.until("Ctrl+C again to exit");
			await t.send(KEY.ctrlC);
			await t.until(() => t.exited() !== undefined, 10_000);
			expect(t.exited()).toBe(0);
		}, 90_000);

		it("a foreground xpi: the left arrow on its empty prompt moves the conversation to the hub", async () => {
			const t = terminal(["--approve"]);
			await t.until("(faux) echo");
			await t.send("remember the number 7");
			await t.send(KEY.enter);
			await t.until("echo: remember the number 7");
			await t.send(KEY.left);
			// the hub draws before the daemon's list arrives: wait for the moved conversation's row
			const hub = await t.until(/Your conversation moved to the background[\s\S]*remember the number 7/, 10_000);
			expect(hub).toContain("xpi agents");
			// the daemon runs it now: listed in the hub of this agent directory
			const list = terminal(["roost", "ls"]);
			await list.until(() => list.exited() !== undefined, 15_000);
			expect(list.screen()).toContain("remember the number 7");
		}, 90_000);
	},
);
