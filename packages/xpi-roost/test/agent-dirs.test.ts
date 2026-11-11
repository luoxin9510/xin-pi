// Decision 14: each agent directory has its own roost. Two daemons started for two agent
// directories, with no ROOST_HOME or ROOST_RUNTIME_DIR, share no socket, no job and no
// roster, and each reads the "roost" section of its own settings.json.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DaemonClient } from "../src/lib/client.ts";
import { pidAlive, TEST_DIR_PREFIX } from "../src/lib/orphans.ts";
import { daemonSocketPath, roostHome, runtimeDir } from "../src/lib/paths.ts";

const DAEMON = resolve("src/daemon/main.ts");
const HOST = resolve("src/host/main.ts");
const ENV_NAMES = [
	"ROOST_AGENT_DIR",
	"ROOST_HOME",
	"ROOST_RUNTIME_DIR",
	"ROOST_HOST_ENTRY",
	"ROOST_PARENT_PID",
	"ROOST_REAP_CHECK_MS",
	"ROOST_CLEANUP_CHECK_MS",
	"ROOST_CLEANUP_DAYS",
];

const saved: Record<string, string | undefined> = {};
const made: string[] = [];
const clients: DaemonClient[] = [];
const daemons: number[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(
	fn: () => T | undefined | false | Promise<T | undefined | false>,
	timeout = 10000,
): Promise<T> {
	const start = Date.now();
	for (;;) {
		const v = await fn();
		if (v) return v;
		if (Date.now() - start > timeout) throw new Error("waitFor timed out");
		await sleep(50);
	}
}

beforeEach(() => {
	for (const k of ENV_NAMES) {
		saved[k] = process.env[k];
		delete process.env[k];
	}
	// test mode: the daemons and their hosts go with this process (M78)
	process.env.ROOST_PARENT_PID = String(process.pid);
	process.env.ROOST_REAP_CHECK_MS = "200";
	process.env.ROOST_CLEANUP_CHECK_MS = "200";
});

afterEach(async () => {
	for (const c of clients.splice(0)) {
		await c.request("shutdown", {}).catch(() => {});
		c.close();
	}
	for (const pid of daemons.splice(0)) {
		await waitFor(() => !pidAlive(pid), 5000).catch(() => {
			if (pidAlive(pid)) process.kill(pid, "SIGKILL");
		});
	}
	for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

function agentDir(): string {
	const dir = mkdtempSync(join(tmpdir(), `${TEST_DIR_PREFIX}a-`));
	made.push(dir, runtimeDir(dir));
	return dir;
}

async function start(dir: string): Promise<DaemonClient> {
	const c = await DaemonClient.connectOrStart({ agentDir: dir, daemonEntry: DAEMON, hostEntry: HOST }, 10_000);
	clients.push(c);
	daemons.push((await c.request("status", {})).pid);
	return c;
}

const job = (cwd: string, name: string, command: string[]) => ({
	cwd,
	sessionFile: join(cwd, `${name}.jsonl`),
	command,
	env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
	name,
	origin: "dispatch" as const,
});

describe("decision 14: a roost per agent directory", () => {
	it("two agent directories: two daemons, no shared socket, job or roster", async () => {
		const a = agentDir();
		const b = agentDir();
		const ca = await start(a);
		const cb = await start(b);
		const [sa, sb] = [await ca.request("status", {}), await cb.request("status", {})];
		expect(sa.pid).not.toBe(sb.pid);
		expect(sa.socketDir).toBe(runtimeDir(a));
		expect(sb.socketDir).toBe(runtimeDir(b));
		expect(daemonSocketPath(a)).not.toBe(daemonSocketPath(b));
		expect(existsSync(join(a, "xpi-roost", "jobs"))).toBe(true);

		const { id } = await ca.request("dispatch", job(a, "only-a", ["/bin/sh", "-c", "sleep 30"]));
		await waitFor(async () => (await ca.request("list", {})).jobs.find((j) => j.id === id)?.pid);
		expect((await ca.request("list", {})).jobs.map((j) => j.id)).toEqual([id]);
		expect((await cb.request("list", {})).jobs).toEqual([]);
		await expect(cb.request("resolve", { query: "only-a" })).rejects.toThrow(/no job matches/);
		expect(existsSync(join(roostHome(a), "jobs", id))).toBe(true);
		expect(existsSync(join(roostHome(b), "jobs", id))).toBe(false);
		await waitFor(() => existsSync(join(roostHome(a), "roster.json")));
		expect(readFileSync(join(roostHome(a), "roster.json"), "utf8")).toContain(id);
		expect(
			existsSync(join(roostHome(b), "roster.json")) &&
				readFileSync(join(roostHome(b), "roster.json"), "utf8").includes(id),
		).toBe(false);
		// a second client of the same agent directory reaches the same daemon
		const again = await start(a);
		expect((await again.request("status", {})).pid).toBe(sa.pid);
	}, 30_000);

	it("each daemon reads the roost section of its own settings.json", async () => {
		const a = agentDir();
		const b = agentDir();
		// about a second: a's ended sessions are removed at once, b's after the default 30 days
		writeFileSync(join(a, "settings.json"), JSON.stringify({ roost: { cleanupDays: 0.00001 } }));
		const ca = await start(a);
		const cb = await start(b);
		const ja = (await ca.request("dispatch", job(a, "ends", ["/bin/sh", "-c", "exit 0"]))).id;
		const jb = (await cb.request("dispatch", job(b, "ends", ["/bin/sh", "-c", "exit 0"]))).id;
		await waitFor(async () => (await cb.request("list", {})).jobs.find((j) => j.id === jb)?.endedAt);
		await waitFor(async () => !(await ca.request("list", {})).jobs.some((j) => j.id === ja), 10_000);
		await sleep(1500);
		expect((await cb.request("list", {})).jobs.map((j) => j.id)).toEqual([jb]);
	}, 30_000);
});
