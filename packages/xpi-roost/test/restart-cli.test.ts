// Spec 03: `xpi roost restart` against a real daemon and real hosts (fake workers: shell commands), in a temporary agent
// directory. The daemon is replaced and the sessions' hosts are replaced; shell and ended sessions are not; a restart
// asked for by a session finishes after its caller is gone; an attached terminal follows its session.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pty from "node-pty";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runRoostCli } from "../src/cli.ts";
import { DaemonClient, daemonLocation } from "../src/lib/client.ts";
import { pidAlive, TEST_DIR_PREFIX } from "../src/lib/orphans.ts";
import { ROOST_LOCATION_ENV, runtimeDir } from "../src/lib/paths.ts";
import type { JobRow } from "../src/lib/protocol.ts";
import { readState } from "../src/lib/store.ts";

const DAEMON = resolve("src/daemon/main.ts");
const HOST = resolve("src/host/main.ts");
const ENV_NAMES = [...ROOST_LOCATION_ENV, "ROOST_PARENT_PID", "XDG_RUNTIME_DIR", "ROOST_JOB_ID"];
const saved: Record<string, string | undefined> = {};
let agentDir: string;
let work: string;
let terms: pty.IPty[] = [];

beforeEach(() => {
	for (const k of ENV_NAMES) {
		saved[k] = process.env[k];
		delete process.env[k];
	}
	process.env.ROOST_PARENT_PID = String(process.pid);
	agentDir = mkdtempSync(join(tmpdir(), `${TEST_DIR_PREFIX}rst-`));
	work = mkdtempSync(join(tmpdir(), `${TEST_DIR_PREFIX}rstw-`));
	// this process reads the same roost as the commands it runs
	Object.assign(process.env, daemonLocation({ agentDir, daemonEntry: DAEMON, hostEntry: HOST }));
});

afterEach(async () => {
	for (const t of terms) {
		try {
			t.kill();
		} catch {}
	}
	terms = [];
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
	rmSync(runtimeDir(agentDir), { recursive: true, force: true });
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(work, { recursive: true, force: true });
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

const start = () => ({ agentDir, daemonEntry: DAEMON, hostEntry: HOST });

async function roost(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
	let out = "";
	let err = "";
	const code = await runRoostCli(argv, {
		start: start(),
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

async function waitFor<T>(
	fn: () => Promise<T | undefined | false> | T | undefined | false,
	timeout = 15_000,
): Promise<T> {
	const t0 = Date.now();
	for (;;) {
		const v = await fn();
		if (v) return v;
		if (Date.now() - t0 > timeout) throw new Error("waitFor timed out");
		await new Promise((r) => setTimeout(r, 50));
	}
}

async function client(): Promise<DaemonClient> {
	return DaemonClient.connectOrStart(start(), 10_000);
}

let seq = 0;
/** A session: an xpi one (kind pi: its worker is a shell command here) or a shell command. */
async function dispatch(c: DaemonClient, name: string, script: string, kind: "pi" | "shell" = "pi"): Promise<string> {
	// a session that has a file is started again with a prompt; one without starts from its command
	const sessionFile = kind === "shell" ? "" : join(work, `s${seq++}.jsonl`);
	if (sessionFile) writeFileSync(sessionFile, "{}\n");
	const { id } = await c.request("dispatch", {
		cwd: work,
		sessionFile,
		kind,
		command: ["/bin/sh", "-c", script],
		env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
		name,
		origin: "dispatch",
	});
	return id;
}

const rows = async (c: DaemonClient): Promise<JobRow[]> => (await c.request("list", { all: true })).jobs;
const running = async (c: DaemonClient, id: string) => (await rows(c)).find((r) => r.id === id)?.pid;
const hostPid = (id: string) => readState(id)?.hostPid as number;

describe("xpi roost restart (real daemon, real hosts)", () => {
	it("replaces the daemon and every running xpi session's host; shell and ended sessions are left alone", async () => {
		const c = await client();
		const a = await dispatch(c, "alpha", "sleep 300");
		const b = await dispatch(c, "beta", "sleep 300");
		const sh = await dispatch(c, "shelly", "sleep 300", "shell");
		const ended = await dispatch(c, "over", "true");
		await waitFor(async () => (await running(c, a)) && (await running(c, b)) && (await running(c, sh)));
		await waitFor(async () => (await rows(c)).find((r) => r.id === ended)?.endedAt);
		const daemon0 = (await c.request("status", {})).pid;
		const hosts0 = { a: hostPid(a), b: hostPid(b), sh: hostPid(sh) };
		const endedState = readState(ended)?.state;
		c.close();

		const r = await roost("restart");
		expect(r.err).toBe("");
		expect(r.code).toBe(0);
		expect(r.out).toContain(`daemon · stopping (pid ${daemon0}, sessions stay running)`);
		expect(r.out).toMatch(/daemon · started \(pid \d+\)\n/);
		expect(r.out).toContain(`session · restarted · ${a} · alpha`);
		expect(r.out).toContain(`session · restarted · ${b} · beta`);
		expect(r.out).not.toContain("shelly");
		expect(r.out).not.toContain("over");

		const after = await client();
		expect((await after.request("status", {})).pid).not.toBe(daemon0);
		await waitFor(async () => (await running(after, a)) && (await running(after, b)));
		expect(hostPid(a)).not.toBe(hosts0.a);
		expect(hostPid(b)).not.toBe(hosts0.b);
		expect(hostPid(sh)).toBe(hosts0.sh);
		expect(readState(ended)?.state).toBe(endedState);
		expect((await rows(after)).find((x) => x.id === ended)?.pid).toBeNull();
		after.close();
	}, 60_000);

	it("restart <name> restarts that session only, leaves the daemon, and refuses one that is not running", async () => {
		const c = await client();
		const a = await dispatch(c, "alpha", "sleep 300");
		const b = await dispatch(c, "beta", "sleep 300");
		const ended = await dispatch(c, "over", "true");
		await waitFor(async () => (await running(c, a)) && (await running(c, b)));
		await waitFor(async () => (await rows(c)).find((r) => r.id === ended)?.endedAt);
		const daemon0 = (await c.request("status", {})).pid;
		const [hostA, hostB] = [hostPid(a), hostPid(b)];

		const one = await roost("restart", "alpha");
		expect(one.code).toBe(0);
		expect(one.out).toContain(`session · restarted · ${a} · alpha`);
		await waitFor(async () => hostPid(a) !== hostA && (await running(c, a)));
		expect(hostPid(b)).toBe(hostB);
		expect((await c.request("status", {})).pid).toBe(daemon0);

		const gone = await roost("restart", "over");
		expect(gone.code).toBe(1);
		expect(gone.out).toContain("not running");
		expect(await running(c, ended)).toBeNull();
		c.close();
	}, 60_000);

	it("--if-stale restarts the daemon and the sessions when no build is known (a build without ids)", async () => {
		const c = await client();
		const a = await dispatch(c, "alpha", "sleep 300");
		await waitFor(async () => running(c, a));
		const daemon0 = (await c.request("status", {})).pid;
		const host0 = hostPid(a);
		// from sources: no build id anywhere, and an unknown id counts as stale here
		const r = await roost("restart", "--if-stale");
		expect(r.code).toBe(0);
		expect((await c.request("status", {}).catch(() => ({ pid: 0 }))).pid).not.toBe(daemon0);
		c.close();
		const after = await client();
		await waitFor(async () => hostPid(a) !== host0 && (await running(after, a)));
		after.close();
	}, 60_000);

	it("a respawn {ids, last} request finishes after the client is gone, and restarts `last` last with its prompt", async () => {
		const c = await client();
		const ids = [
			await dispatch(c, "one", "sleep 300"),
			await dispatch(c, "two", "sleep 300"),
			await dispatch(c, "three", "sleep 300"),
		];
		await waitFor(async () => (await Promise.all(ids.map((i) => running(c, i)))).every(Boolean));
		const hosts0 = ids.map(hostPid);
		const [one, two, three] = ids as [string, string, string];

		// the caller is one of them and goes away as soon as it asked
		const caller = await client();
		void caller
			.request("respawn", { ids: [one, two, three], last: { id: one, prompt: "carry on please" } })
			.catch(() => {});
		await new Promise((r) => setTimeout(r, 10));
		caller.close();

		await waitFor(
			async () =>
				ids.every((id, i) => hostPid(id) !== hosts0[i]) && (await running(c, three)) && (await running(c, one)),
		);
		const at = (id: string) => readState(id)?.restartedAt as number;
		expect(at(two)).toBeLessThanOrEqual(at(three));
		expect(at(three)).toBeLessThanOrEqual(at(one));
		const last = (id: string) => (readState(id)?.command as string[]).at(-1);
		expect(last(one)).toBe("carry on please");
		// a session that was working carries on with the usual prompt
		expect(last(two)).toBe("Continue where you left off.");
		expect(last(three)).toBe("Continue where you left off.");
		c.close();
	}, 60_000);

	it("an attached terminal follows its session through a restart", async () => {
		const c = await client();
		const id = await dispatch(c, "echoer", 'while read l; do echo "got:$l"; done');
		await waitFor(async () => running(c, id));
		const host0 = hostPid(id);

		const term = pty.spawn(process.execPath, ["--input-type=module", "-e", driver(), agentDir], {
			cols: 100,
			rows: 30,
			cwd: process.cwd(),
			env: process.env as Record<string, string>,
		});
		terms.push(term);
		let out = "";
		term.onData((d) => {
			out += d;
		});
		const exited = new Promise<void>((r) => term.onExit(() => r()));
		const typeUntil = async (text: string, echo: string) =>
			waitFor(async () => {
				if (out.includes(echo)) return true;
				term.write(`${text}\r`);
				await new Promise((r) => setTimeout(r, 300));
				return out.includes(echo);
			});
		await typeUntil("before", "got:before");

		const r = await roost("restart", "echoer");
		expect(r.code).toBe(0);
		await waitFor(() => hostPid(id) !== host0);
		// the same terminal types into the new process
		await typeUntil("after", "got:after");
		expect(out).toContain("restarting…");
		term.write("\x1a");
		await exited;
		expect(out).toContain(`detached · ${id} · echoer`);
		c.close();
	}, 60_000);
});

/** `xpi roost attach echoer` in a terminal of its own. */
function driver(): string {
	return `
		import { resolve } from "node:path";
		import { runRoostCli } from "./src/cli.ts";
		const [agentDir] = process.argv.slice(1);
		const code = await runRoostCli(["attach", "echoer"], {
			start: { agentDir, daemonEntry: resolve("src/daemon/main.ts"), hostEntry: resolve("src/host/main.ts") },
			isDetachKey: (k) => k === "\\x1a",
			detachKeyName: "ctrl+z",
			ptyHint: "(install hint)",
			startTimeoutMs: 10000,
		});
		process.stdout.write("\\r\\n[exit " + code + "]\\r\\n");
		process.exit(code);
	`;
}
