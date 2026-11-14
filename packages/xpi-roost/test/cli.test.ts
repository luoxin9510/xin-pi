// `xpi roost <subcommand>` against a real daemon in a temporary agent directory. Users get
// their first way to start a session in a later PR; here a shell-command session is started
// through the client library, as `xpi --bg` will through the same daemon.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pty from "node-pty";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeWhen, runRoostCli, type ScheduleLaunchInput, splitArgsWhen } from "../src/cli.ts";
import { DaemonClient } from "../src/lib/client.ts";
import { pidAlive, TEST_DIR_PREFIX } from "../src/lib/orphans.ts";
import { ROOST_LOCATION_ENV, roostHome, runtimeDir } from "../src/lib/paths.ts";
import type { DispatchArgs } from "../src/lib/protocol.ts";
import { ROOST_VERSION } from "../src/lib/version.ts";

const DAEMON = resolve("src/daemon/main.ts");
const HOST = resolve("src/host/main.ts");
const ENV_NAMES = [...ROOST_LOCATION_ENV, "ROOST_PARENT_PID", "XDG_RUNTIME_DIR", "ROOST_JOB_ID"];

const saved: Record<string, string | undefined> = {};
let agentDir: string;
let made: string[] = [];

beforeEach(() => {
	for (const k of ENV_NAMES) {
		saved[k] = process.env[k];
		delete process.env[k];
	}
	process.env.ROOST_PARENT_PID = String(process.pid);
	agentDir = mkdtempSync(join(tmpdir(), `${TEST_DIR_PREFIX}cli-`));
	made = [agentDir, runtimeDir(agentDir)];
});

afterEach(async () => {
	try {
		const c = await DaemonClient.connect();
		const { pid } = await c.request("status", {});
		await c.request("shutdown", {}).catch(() => {});
		c.close();
		for (let i = 0; i < 100 && pidAlive(pid); i++) await new Promise((r) => setTimeout(r, 50));
		if (pidAlive(pid)) process.kill(pid, "SIGKILL");
	} catch {
		// no daemon
	}
	for (const d of made) rmSync(d, { recursive: true, force: true });
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

/** Phase 2: what the fake launch builder was asked for (the wrapper's is tested in xpi-coding-agent). */
let launches: ScheduleLaunchInput[] = [];
function fakeLaunch(input: ScheduleLaunchInput): DispatchArgs {
	launches.push(input);
	const entry = join(agentDir, "fake-xpi.sh");
	writeFileSync(entry, "sleep 0.2\n");
	const sessionFile = join(agentDir, "runs", "{{run}}.jsonl");
	mkdirSync(join(agentDir, "runs"), { recursive: true });
	return {
		cwd: input.cwd,
		sessionFile,
		command: ["/bin/sh", entry, "--session", sessionFile, "--", input.task ?? ""],
		env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
		name: input.name,
		origin: "dispatch",
		...(input.model ? { model: input.model } : {}),
		...(input.thinking ? { thinking: input.thinking } : {}),
	};
}

let serviceCalls: string[][] = [];

async function roost(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
	let out = "";
	let err = "";
	const code = await runRoostCli(argv, {
		scheduleLaunch: fakeLaunch,
		start: { agentDir, daemonEntry: DAEMON, hostEntry: HOST },
		isDetachKey: (k) => k === "\x1a",
		detachKeyName: "ctrl+z",
		ptyHint: "(install hint)",
		startTimeoutMs: 10_000,
		// never the user's launchd or systemd
		service: {
			platform: "darwin",
			home: join(agentDir, "home"),
			uid: 501,
			run: (cmd, args) => {
				serviceCalls.push([cmd, ...args]);
				return { code: 0, stdout: "", stderr: "" };
			},
		},
		stdout: {
			write: (s: string) => {
				out += s;
			},
		},
		stderr: {
			write: (s: string) => {
				err += s;
			},
		},
	});
	return { code, out, err };
}

async function waitFor<T>(fn: () => Promise<T | undefined | false>, timeout = 10_000): Promise<T> {
	const start = Date.now();
	for (;;) {
		const v = await fn();
		if (v) return v;
		if (Date.now() - start > timeout) throw new Error("waitFor timed out");
		await new Promise((r) => setTimeout(r, 50));
	}
}

async function shellSession(name: string, script: string): Promise<string> {
	const c = await DaemonClient.connectOrStart({ agentDir, daemonEntry: DAEMON, hostEntry: HOST }, 10_000);
	try {
		const { id } = await c.request("dispatch", {
			cwd: agentDir,
			sessionFile: "",
			kind: "shell",
			command: ["/bin/sh", "-c", script],
			env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
			name,
			origin: "dispatch",
		});
		return id;
	} finally {
		c.close();
	}
}

describe("xpi roost", () => {
	it("help, an unknown command, the hub (xpi's, or not available)", async () => {
		const help = await roost("--help");
		expect(help.code).toBe(0);
		expect(help.out).toContain("xpi roost ls [--all] [--cwd <dir>] [--json]");
		expect(help.out).toContain("ctrl+z detaches");
		expect(help.out).toContain("xpi roost restart [<id|name>] [--if-stale]");
		expect((await roost("restart", "a", "b")).code).toBe(2);
		expect((await roost("restart", "--bogus")).err).toContain("restart: unknown option --bogus");
		expect((await roost()).code).toBe(2);
		const bad = await roost("frobnicate");
		expect(bad.code).toBe(2);
		expect(bad.err).toContain("xpi roost: unknown command: frobnicate");
		expect(help.out).toContain("xpi roost hub [dir]");
		const hub = await roost("hub");
		expect(hub.code).toBe(1);
		expect(hub.err).toContain("the hub is not available here");
		// xpi supplies the hub: it gets the arguments after "hub"
		const seen: string[][] = [];
		const code = await runRoostCli(["hub", "some/dir"], {
			start: { agentDir, daemonEntry: DAEMON, hostEntry: HOST },
			isDetachKey: () => false,
			detachKeyName: "ctrl+z",
			ptyHint: "",
			hub: async (args) => {
				seen.push(args);
				return 0;
			},
		});
		expect(code).toBe(0);
		expect(seen).toEqual([["some/dir"]]);
		expect((await roost("ls", "--bogus")).code).toBe(2);
		expect((await roost("reply")).code).toBe(2);
	});

	it("daemon status before and after a start; ls, logs, log, reply, stop, rm, respawn on a shell session", async () => {
		const before = await roost("daemon", "status");
		expect(before.out).toContain("daemon not running");
		expect((await roost("ls")).out).toBe("no background sessions\n");
		const status = await roost("daemon", "status");
		expect(status.out).toContain(`version     ${ROOST_VERSION}`);
		expect(status.out).toContain(`socket dir  ${runtimeDir(agentDir)}`);
		expect(status.out).toMatch(/node-pty {4}ok/);

		const id = await shellSession("ticker", "i=0; while true; do echo tick $i; i=$((i+1)); sleep 0.2; done");
		const listed = await waitFor(async () => {
			const r = await roost("ls", "--json");
			const rows = JSON.parse(r.out) as { id: string; pid: number | null }[];
			return rows.find((j) => j.id === id && j.pid !== null);
		});
		expect(listed.id).toBe(id);
		const table = await roost("ls");
		expect(table.out).toMatch(/^ID\s+STATE\s+NAME/);
		expect(table.out).toContain("ticker");
		expect((await roost("ls", "--cwd", "/usr")).out).toBe("no background sessions\n");
		expect((await roost("ls", "--cwd", agentDir)).out).toContain("ticker");

		const logs = await waitFor(async () => {
			const r = await roost("logs", "ticker");
			return r.code === 0 && r.out.includes("tick") ? r : undefined;
		});
		expect(logs.out).toMatch(/tick \d+/);
		const log = await roost("log", "-n", "5");
		expect(log.out).toContain("started ticker");

		// a shell session takes no replies: the daemon's words, and a failing exit
		const reply = await roost("reply", "ticker", "hello");
		expect(reply.code).toBe(1);
		expect(reply.err).toContain("a shell job takes no replies");

		const stop = await roost("stop", id);
		expect(stop.out).toBe(`stopped · ${id} · ticker\n`);
		await waitFor(async () => {
			const rows = JSON.parse((await roost("ls", "--json")).out) as { id: string; endedAt: number | null }[];
			return rows.find((j) => j.id === id)?.endedAt !== null;
		});
		const respawn = await roost("respawn", "ticker");
		expect(respawn.out).toMatch(/^(started|already running) · /);
		const all = await roost("respawn", "--all");
		expect(all.code).toBe(0);
		const rm = await roost("rm", "ticker");
		expect(rm.out).toBe(`removed · ${id} · ticker\n`);
		expect((await roost("logs", "ticker")).err).toContain("ticker");

		expect((await roost("daemon", "logs")).out).toContain("started");
		const stopDaemon = await roost("daemon", "stop", "--keep-workers");
		expect(stopDaemon.out).toBe("daemon stopped; sessions kept running\n");
		await waitFor(async () => (await roost("daemon", "status")).out.includes("daemon not running"));
	}, 60_000);

	it("daemon install, status and uninstall: the login service, with a fake launchctl", async () => {
		serviceCalls = [];
		expect((await roost("daemon", "status")).out).toContain("service     not installed (xpi roost daemon install)");
		const install = await roost("daemon", "install");
		expect(install.code).toBe(0);
		const plists = join(agentDir, "home", "Library", "LaunchAgents");
		const [file] = readdirSync(plists);
		expect(install.out).toContain(`installed ${join(plists, file!)}`);
		expect(install.out).toContain("started now");
		expect(serviceCalls.map((c) => c.slice(0, 2).join(" "))).toEqual([
			"launchctl print",
			"launchctl bootout",
			"launchctl bootstrap",
		]);
		expect(readFileSync(join(plists, file!), "utf8")).toContain(`<string>${DAEMON}</string>`);
		const status = await roost("daemon", "status");
		expect(status.out).toMatch(/service {5}installed \(launchd dev\.xpi\.roost\.[0-9a-f]{12}\)\n/);
		// written for another xpi: the status says to install again
		writeFileSync(join(plists, file!), "<plist/>");
		expect((await roost("daemon", "status")).out).toContain("run xpi roost daemon install again");
		const un = await roost("daemon", "uninstall");
		expect(un.out).toContain("the daemon no longer starts at login");
		expect(readdirSync(plists)).toEqual([]);
		expect((await roost("daemon", "uninstall")).out).toBe("no login service installed for this agent directory\n");
		expect((await roost("daemon", "install", "--now")).code).toBe(2);
	}, 30_000);

	it("daemon status says when the daemon runs under another runtime directory", async () => {
		const elsewhere = join(agentDir, "rt-elsewhere");
		made.push(elsewhere);
		// a daemon started by another environment (e.g. the login service with another XDG_RUNTIME_DIR)
		const env = { ...process.env, ROOST_RUNTIME_DIR: elsewhere, ROOST_AGENT_DIR: agentDir };
		const child = spawn(process.execPath, [DAEMON], {
			env: { ...env, ROOST_HOME: roostHome(agentDir), ROOST_HOST_ENTRY: HOST },
			stdio: "ignore",
			detached: true,
		});
		child.unref();
		try {
			const r = await waitFor(async () => {
				const s = await roost("daemon", "status");
				return s.out.includes("other_runtime_dir") ? s : undefined;
			});
			expect(r.out).toContain(`already runs with another runtime directory (${elsewhere}, pid ${child.pid})`);
			expect(r.out).toContain("service     not installed");
		} finally {
			process.kill(child.pid!, "SIGTERM");
			await waitFor(async () => !pidAlive(child.pid!));
		}
	}, 30_000);

	it("uses the roost of the agent directory it is given, also from inside another roost's session", async () => {
		const other = mkdtempSync(join(tmpdir(), `${TEST_DIR_PREFIX}cli-o-`));
		made.push(other);
		// a session's location variables, of another roost
		Object.assign(process.env, {
			ROOST_AGENT_DIR: other,
			ROOST_HOME: join(other, "xpi-roost"),
			ROOST_RUNTIME_DIR: join(other, "rt"),
		});
		const r = await roost("daemon", "status");
		expect(r.out).toContain(`daemon not running (socket dir ${runtimeDir(agentDir)})`);
		await roost("ls");
		expect(existsSync(join(agentDir, "xpi-roost", "jobs"))).toBe(true);
		expect(existsSync(join(other, "xpi-roost"))).toBe(false);
	}, 30_000);

	it("daemon stop without --keep-workers ends the sessions", async () => {
		const id = await shellSession("sleeper", "sleep 60");
		const row = await waitFor(async () => {
			const rows = JSON.parse((await roost("ls", "--json")).out) as { id: string; pid: number | null }[];
			return rows.find((j) => j.id === id && j.pid !== null);
		});
		const stop = await roost("daemon", "stop");
		expect(stop.out).toBe("daemon stopped\n");
		await waitFor(async () => !pidAlive(row.pid!));
		await waitFor(async () => (await roost("daemon", "status")).out.includes("daemon not running"));
	}, 30_000);

	it("log --follow keeps printing what happens", async () => {
		const id = await shellSession("follow-me", "sleep 60");
		const child = spawn(process.execPath, ["--input-type=module", "-e", driver(["log", "--follow"]), agentDir], {
			cwd: process.cwd(),
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		child.stdout.on("data", (d) => {
			out += d;
		});
		try {
			await waitFor(async () => out.includes("started follow-me"));
			expect(out).not.toContain("follow-me stopped");
			await roost("stop", id);
			await waitFor(async () => out.includes("follow-me stopped"));
			expect(child.exitCode).toBeNull();
		} finally {
			child.kill();
		}
	}, 30_000);

	it("attach: starts an ended session first, types into it, detaches with the caller's key; without node-pty only a running one", async () => {
		const id = await shellSession("echoer", 'while read l; do echo "got:$l"; done');
		await waitFor(async () => {
			const rows = JSON.parse((await roost("ls", "--json")).out) as { id: string; pid: number | null }[];
			return rows.find((j) => j.id === id && j.pid !== null);
		});
		await roost("stop", id);
		await waitFor(async () => {
			const rows = JSON.parse((await roost("ls", "--json")).out) as { id: string; endedAt: number | null }[];
			return rows.find((j) => j.id === id)?.endedAt !== null;
		});

		// without node-pty, an ended session cannot be started: refused, with the hint
		const refused = await attachInPty("0");
		await refused.exited;
		expect(refused.out()).toContain(
			"attaching to echoer, which is not running, starts a session process, which needs node-pty. (install hint)",
		);
		expect(refused.out()).toContain("[exit 1]");

		// AT-1: started again, then attached
		const first = await attachInPty("1");
		await first.type("hello", "got:hello");
		first.term.write("\x1a");
		await first.exited;
		expect(first.out()).toContain(`detached · ${id} · echoer`);
		expect(first.out()).toContain("[exit 0]");

		// running now: attaching needs no node-pty in this process
		const second = await attachInPty("0");
		await second.type("again", "got:again");
		second.term.write("\x1a");
		await second.exited;
		expect(second.out()).toContain("[exit 0]");
	}, 60_000);
});

/** A process that runs one `xpi roost` command for the agent directory in argv[1] (argv[2]: node-pty installed?). */
function driver(argv: string[]): string {
	return `
		import { resolve } from "node:path";
		import { runRoostCli } from "./src/cli.ts";
		const [agentDir, pty] = process.argv.slice(1);
		const code = await runRoostCli(${JSON.stringify(argv)}, {
			start: { agentDir, daemonEntry: resolve("src/daemon/main.ts"), hostEntry: resolve("src/host/main.ts") },
			isDetachKey: (k) => k === "\\x1a",
			detachKeyName: "ctrl+z",
			ptyHint: "(install hint)",
			ptyInstalled: pty !== "0",
			startTimeoutMs: 10000,
		});
		process.stdout.write("\\r\\n[exit " + code + "]\\r\\n");
		process.exit(code);
	`;
}

/** `xpi roost attach echoer` in a terminal of its own. */
async function attachInPty(ptyInstalled: "0" | "1") {
	const term = pty.spawn(
		process.execPath,
		["--input-type=module", "-e", driver(["attach", "echoer"]), agentDir, ptyInstalled],
		{ cols: 100, rows: 30, cwd: process.cwd(), env: process.env as Record<string, string> },
	);
	let out = "";
	term.onData((d) => {
		out += d;
	});
	const exited = new Promise<void>((r) => term.onExit(() => r()));
	return {
		term,
		out: () => out,
		exited,
		// a line typed until its echo shows (the first keys may come before the attach is up)
		type: async (text: string, echo: string) => {
			await waitFor(async () => {
				if (out.includes(echo)) return true;
				term.write(`${text}\r`);
				await new Promise((r) => setTimeout(r, 300));
				return out.includes(echo);
			}, 15_000);
		},
	};
}

describe("phase 2: xpi roost schedule", () => {
	beforeEach(() => {
		launches = [];
	});

	it("reads <when> as the shell split it, and keeps a cron rule quoted", () => {
		expect(splitArgsWhen(["every", "2h", "check", "it"])).toEqual({ when: "every 2h", task: "check it" });
		expect(splitArgsWhen(["every 2h", "check"])).toEqual({ when: "every 2h", task: "check" });
		expect(splitArgsWhen(["weekly", "mon", "09:00", "plan"])).toEqual({ when: "weekly mon 09:00", task: "plan" });
		expect(splitArgsWhen(["manual", "x"])).toEqual({ when: "manual", task: "x" });
		expect(splitArgsWhen(["cron", "0 9 * * 1-5", "x"])).toEqual({ when: 'cron "0 9 * * 1-5"', task: "x" });
		expect(splitArgsWhen(["cron", "0", "9", "*", "*", "1", "x"])).toEqual({ when: 'cron "0 9 * * 1"', task: "x" });
		expect(splitArgsWhen(["hourly", "x"])).toBeUndefined();
		expect(normalizeWhen("cron '0 9 * * 1'")).toBe('cron "0 9 * * 1"');
		expect(normalizeWhen(" every   2h ")).toBe("every 2h");
	});

	it("list without a running service reads the file, says nothing runs, and starts nothing", async () => {
		mkdirSync(roostHome(agentDir), { recursive: true });
		writeFileSync(
			join(roostHome(agentDir), "schedules.json"),
			JSON.stringify([
				{
					name: "nightly",
					when: "daily 03:00",
					task: "check the build",
					launch: { cwd: agentDir, sessionFile: "/s/{{run}}.jsonl", command: [], env: {} },
					paused: false,
					nextAt: Date.now() + 30 * 60_000,
				},
			]),
		);
		const r = await roost("schedule", "list");
		expect(r.code).toBe(0);
		expect(r.out).toMatch(/^NAME\s+WHEN/);
		expect(r.out).toMatch(/nightly\s+daily 03:00\s+in \d+m/);
		expect(r.err).toContain("the background service is not running: no schedule runs until it does");
		await expect(DaemonClient.connect()).rejects.toThrow();
		const json = await roost("schedule", "list", "--json");
		expect(JSON.parse(json.out)[0]).toMatchObject({ name: "nightly", task: "check the build" });
		await expect(DaemonClient.connect()).rejects.toThrow();
		// a file that does not parse: said, and left for the daemon to move aside
		writeFileSync(join(roostHome(agentDir), "schedules.json"), "[{");
		const bad = await roost("schedule", "list");
		expect(bad.code).toBe(0);
		expect(bad.out).toBe("no schedules\n");
		expect(bad.err).toContain("schedules.json could not be read");
		expect(readFileSync(join(roostHome(agentDir), "schedules.json"), "utf8")).toBe("[{");
	});

	it("add, list, run, pause, resume, edit, rm through a real daemon", async () => {
		const work = mkdtempSync(join(tmpdir(), `${TEST_DIR_PREFIX}cliw-`));
		made.push(work);
		const add = await roost("schedule", "add", "nightly", "every", "2h", "check", "the", "build", "--cwd", work);
		expect(add.err).toBe("");
		expect(add.code).toBe(0);
		expect(add.out).toMatch(/^added · nightly · every 2h · next run in (2h 00m|1h 59m) \(/);
		expect(launches).toEqual([
			{ cwd: work, task: "check the build", model: undefined, thinking: undefined, name: "nightly" },
		]);
		const man = await roost("schedule", "add", "ask", "manual", "look", "--model", "m1");
		expect(man.out).toBe("added · ask · manual · runs when asked: xpi roost schedule run ask\n");
		expect(launches[1]).toMatchObject({ cwd: process.cwd(), model: "m1" });
		const cron = await roost("schedule", "add", "mon", "cron", "0 9 * * 1", "plan", "--cwd", work);
		expect(cron.out).toContain('added · mon · cron "0 9 * * 1"');
		const list = await roost("schedule", "list");
		expect(list.err).toBe("");
		expect(
			list.out
				.split("\n")
				.slice(1, 4)
				.map((l) => l.split(/\s+/)[0]),
		).toEqual(["ask", "mon", "nightly"]);
		// run now: a session named after the schedule; ls shows the schedule's name
		const run = await roost("schedule", "run", "ask");
		expect(run.code).toBe(0);
		expect(run.out).toMatch(/^started · [0-9a-f]{8} · ask\n$/);
		expect((await roost("ls")).out).toContain("ask ← ask");
		const paused = await roost("schedule", "pause", "nightly");
		expect(paused.out).toBe("paused · nightly · paused\n");
		expect((await roost("schedule", "resume", "nightly")).out).toMatch(
			/^resumed · nightly · next run in (2h|1h 59m)/,
		);
		// edit: the launch built again with the stored task and model; a new rule
		launches = [];
		const edit = await roost("schedule", "edit", "ask", "--when", "daily 03:00", "--thinking", "high");
		expect(edit.code).toBe(0);
		expect(edit.out).toMatch(/^edited · ask · daily 03:00 · next run in/);
		expect(launches).toEqual([{ cwd: process.cwd(), task: "look", model: "m1", thinking: "high", name: "ask" }]);
		const again = await roost("schedule", "edit", "nightly", "--task", "check it all");
		expect(again.out).toMatch(/^edited · nightly · every 2h/);
		expect(launches[1]).toMatchObject({ task: "check it all", cwd: work });
		const json = JSON.parse((await roost("schedule", "list", "--json")).out) as {
			name: string;
			task: string;
			thinking: string;
		}[];
		expect(json.find((x) => x.name === "nightly")?.task).toBe("check it all");
		expect(json.find((x) => x.name === "ask")?.thinking).toBe("high");
		// `default` drops the stored value: the launch is built with the settings' (none here)
		launches = [];
		await roost("schedule", "edit", "ask", "--model", "default", "--thinking", "default");
		expect(launches).toEqual([
			{ cwd: process.cwd(), task: "look", model: undefined, thinking: undefined, name: "ask" },
		]);
		const cleared = JSON.parse((await roost("schedule", "list", "--json")).out) as { name: string; model: unknown }[];
		expect(cleared.find((x) => x.name === "ask")?.model).toBeNull();
		expect((await roost("schedule", "rm", "mon")).out).toContain("removed · mon");
		const gone = await roost("schedule", "run", "mon");
		expect(gone.code).toBe(1);
		expect(gone.err).toContain("no schedule named mon");
	});

	it("refuses bad input as usage; add refuses a missing directory", async () => {
		const floor = await roost("schedule", "add", "x", "every", "1m", "task");
		expect(floor.code).toBe(2);
		// the message and a one-line hint, not the whole usage
		expect(floor.err).toMatch(/^xpi roost: every: five minutes at least\nwhen: "every 30m".*\(xpi roost --help\)\n$/);
		expect(floor.err).not.toContain("usage:");
		const never = await roost("schedule", "add", "x", "cron", "0 9 31 2 *", "task");
		expect(never.code).toBe(2);
		expect(never.err).toContain("never matches");
		expect((await roost("schedule", "add", "x", "hourly", "task")).err).not.toContain("usage:");
		expect((await roost("schedule", "add", "x", "hourly", "task")).code).toBe(2);
		expect((await roost("schedule", "add", "../x", "every", "1h", "task")).code).toBe(2);
		expect((await roost("schedule", "add", "x", "every", "1h", "task", "--frob")).err).toContain(
			"unknown option --frob",
		);
		const nodir = await roost("schedule", "add", "x", "every", "1h", "task", "--cwd", join(agentDir, "nope"));
		expect(nodir.code).toBe(1);
		expect(nodir.err).toContain(`no directory ${join(agentDir, "nope")}`);
		expect((await roost("schedule")).code).toBe(2);
		expect(launches).toEqual([]);
	});

	it("inside a roost session: add, edit and run refuse; list, pause, resume and rm work", async () => {
		expect((await roost("schedule", "add", "s", "manual", "task")).code).toBe(0);
		process.env.ROOST_JOB_ID = "abcd1234";
		for (const argv of [
			["add", "t", "manual", "task"],
			["edit", "s", "--task", "x"],
			["run", "s"],
		]) {
			const r = await roost("schedule", ...argv);
			expect(r.code, argv.join(" ")).toBe(1);
			expect(r.err).toContain(`schedule ${argv[0]} is refused inside a background session (ROOST_JOB_ID is set)`);
		}
		expect((await roost("schedule", "list")).code).toBe(0);
		expect((await roost("schedule", "pause", "s")).code).toBe(0);
		expect((await roost("schedule", "resume", "s")).code).toBe(0);
		expect((await roost("schedule", "rm", "s")).code).toBe(0);
		expect(launches).toHaveLength(1);
		expect(JSON.parse(readFileSync(join(roostHome(agentDir), "schedules.json"), "utf8"))).toEqual([]);
	});
});
