// `xpi roost <subcommand>` against a real daemon in a temporary agent directory. Users get
// their first way to start a session in a later PR; here a shell-command session is started
// through the client library, as `xpi --bg` will through the same daemon.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runRoostCli } from "../src/cli.ts";
import { DaemonClient } from "../src/lib/client.ts";
import { pidAlive, TEST_DIR_PREFIX } from "../src/lib/orphans.ts";
import { ROOST_LOCATION_ENV, runtimeDir } from "../src/lib/paths.ts";
import { ROOST_VERSION } from "../src/lib/version.ts";

const DAEMON = resolve("src/daemon/main.ts");
const HOST = resolve("src/host/main.ts");
const ENV_NAMES = [...ROOST_LOCATION_ENV, "ROOST_PARENT_PID", "XDG_RUNTIME_DIR"];

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

async function roost(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
	let out = "";
	let err = "";
	const code = await runRoostCli(argv, {
		start: { agentDir, daemonEntry: DAEMON, hostEntry: HOST },
		isDetachKey: (k) => k === "\x1a",
		detachKeyName: "ctrl+z",
		ptyHint: "(install hint)",
		startTimeoutMs: 10_000,
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
	it("help, an unknown command, the hub that is not there yet", async () => {
		const help = await roost("--help");
		expect(help.code).toBe(0);
		expect(help.out).toContain("xpi roost ls [--all] [--cwd <dir>] [--json]");
		expect(help.out).toContain("ctrl+z detaches");
		expect(help.out).not.toContain("daemon run");
		expect((await roost()).code).toBe(2);
		const bad = await roost("frobnicate");
		expect(bad.code).toBe(2);
		expect(bad.err).toContain("xpi roost: unknown command: frobnicate");
		const hub = await roost("hub");
		expect(hub.code).toBe(1);
		expect(hub.err).toContain("not in this version of xpi yet");
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
});
