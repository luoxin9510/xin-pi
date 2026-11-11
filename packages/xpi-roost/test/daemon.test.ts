import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DaemonClient, type DaemonError } from "../src/lib/client.ts";
import { TEST_DIR_PREFIX } from "../src/lib/orphans.ts";
import { daemonSocketPath, jobDir } from "../src/lib/paths.ts";
import { isAlive, processStartToken } from "../src/lib/proc.ts";
import type { Event, JobRow } from "../src/lib/protocol.ts";
import { listJobIds, readJob, readState } from "../src/lib/store.ts";

const DAEMON = resolve("src/daemon/main.ts");
const HOST = resolve("src/host/main.ts");

let agentDir: string;
let home: string;
let rt: string;
let work: string;
let daemons: ChildProcess[] = [];
let clients: DaemonClient[] = [];
let extra: ChildProcess[] = [];
/** Every ROOST_ variable a test here sets: restored after each. */
const ENV_NAMES = [
	"ROOST_AGENT_DIR",
	"ROOST_HOME",
	"ROOST_RUNTIME_DIR",
	"ROOST_HOST_ENTRY",
	"ROOST_REAP_MINUTES",
	"ROOST_RESUME_DELAYS_MS",
	"ROOST_REAP_CHECK_MS",
	"ROOST_SHELL_KEEP_MS",
	"ROOST_CLEANUP_DAYS",
	"ROOST_CLEANUP_CHECK_MS",
];
const saved = Object.fromEntries(ENV_NAMES.map((k) => [k, process.env[k]]));

async function waitFor<T>(
	fn: () => T | undefined | false | Promise<T | undefined | false>,
	timeout = 10000,
): Promise<T> {
	const start = Date.now();
	for (;;) {
		const v = await fn();
		if (v) return v;
		if (Date.now() - start > timeout) throw new Error("waitFor timed out");
		await new Promise((r) => setTimeout(r, 25));
	}
}

beforeEach(() => {
	// never the user's agent directory: its settings.json is this test's
	agentDir = mkdtempSync(join(tmpdir(), `${TEST_DIR_PREFIX}a-`));
	home = mkdtempSync(join(tmpdir(), `${TEST_DIR_PREFIX}d-`));
	rt = mkdtempSync("/tmp/xrt-");
	work = mkdtempSync(join(tmpdir(), `${TEST_DIR_PREFIX}w-`));
	process.env.ROOST_AGENT_DIR = agentDir;
	process.env.ROOST_HOME = home;
	process.env.ROOST_RUNTIME_DIR = rt;
	process.env.ROOST_HOST_ENTRY = HOST;
});

afterEach(() => {
	for (const c of clients) c.close();
	for (const id of listJobIds()) {
		const pid = readState(id)?.hostPid;
		if (pid && isAlive(pid)) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {}
		}
	}
	for (const p of [...daemons, ...extra]) if (p.exitCode === null) p.kill("SIGKILL");
	clients = [];
	daemons = [];
	extra = [];
	workerConn = undefined;
	rmSync(home, { recursive: true, force: true });
	rmSync(rt, { recursive: true, force: true });
	rmSync(work, { recursive: true, force: true });
	rmSync(agentDir, { recursive: true, force: true });
	for (const k of ENV_NAMES) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

async function startDaemon(): Promise<{ proc: ChildProcess; client: DaemonClient }> {
	const proc = spawn(process.execPath, [DAEMON], {
		stdio: "ignore",
		env: { ...process.env, ROOST_PARENT_PID: String(process.pid) },
	});
	daemons.push(proc);
	const client = await waitFor(async () => {
		try {
			const c = await DaemonClient.connect();
			await c.request("ping", {});
			return c;
		} catch {
			return undefined;
		}
	});
	clients.push(client);
	return { proc, client };
}

let seq = 0;
function args(script: string, over: Record<string, unknown> = {}) {
	return {
		cwd: work,
		sessionFile: join(work, `s${seq++}.jsonl`),
		command: ["/bin/sh", "-c", script],
		env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
		name: "job",
		origin: "dispatch" as const,
		...over,
	};
}

/**
 * M49: a worker's connection, one per test (a new one after a restart of the daemon): a
 * connection that reported is a session's and may not use the hub's ops.
 */
let workerConn: DaemonClient | undefined;
async function asWorker(): Promise<DaemonClient> {
	if (workerConn) return workerConn;
	const c = await DaemonClient.connect();
	clients.push(c);
	c.onClose(() => {
		if (workerConn === c) workerConn = undefined;
	});
	workerConn = c;
	return c;
}

const find = async (c: DaemonClient, id: string): Promise<JobRow | undefined> =>
	(await c.request("list", {})).jobs.find((j) => j.id === id);

const exited = (p: ChildProcess) => p.exitCode !== null || p.signalCode !== null;

describe("daemon", () => {
	it("dispatches a job, lists it working, then done; events are pushed", async () => {
		const { client } = await startDaemon();
		const events: Event[] = [];
		await client.request("subscribe", {});
		client.onEvent((e) => events.push(e));
		const { id, name } = await client.request("dispatch", args("sleep 0.5; echo hi; sleep 1", { name: "first" }));
		expect(name).toBe("first");
		const row = await waitFor(async () => {
			const r = await find(client, id);
			return r?.pid ? r : undefined;
		});
		expect(row.state).toBe("working");
		expect(row.kind).toBe("pi");
		const done = await waitFor(async () => {
			const r = await find(client, id);
			return r?.state === "done" ? r : undefined;
		});
		expect(done.endedAt).toBeTypeOf("number");
		expect(done.pid).toBeNull();
		const states = events
			.filter((e) => e.event === "job" && e.job.id === id)
			.map((e) => (e as { job: JobRow }).job.state);
		expect(states[0]).toBe("working");
		expect(states.at(-1)).toBe("done");
	});

	it("stops a long job, then rm removes it and its directory", async () => {
		const { client } = await startDaemon();
		const events: Event[] = [];
		await client.request("subscribe", {});
		client.onEvent((e) => events.push(e));
		const { id } = await client.request("dispatch", args("sleep 30"));
		await waitFor(async () => (await find(client, id))?.pid);
		await client.request("stop", { id });
		const row = await waitFor(async () => {
			const r = await find(client, id);
			return r?.state === "stopped" ? r : undefined;
		});
		expect(row.endedAt).toBeTypeOf("number");
		await client.request("stop", { id });
		await client.request("rm", { id });
		expect(await find(client, id)).toBeUndefined();
		expect(existsSync(jobDir(id))).toBe(false);
		expect(events).toContainEqual({ event: "removed", id });
		await expect(client.request("stop", { id })).rejects.toMatchObject({ code: "not_found" });
	});

	it("rejects locked sessions and duplicate live sessionFiles", async () => {
		const { client } = await startDaemon();
		const holder = spawn("sleep", ["10"], { stdio: "ignore" });
		extra.push(holder);
		const token = await waitFor(() => processStartToken(holder.pid!));
		const sessionFile = join(work, "locked.jsonl");
		writeFileSync(`${sessionFile}.lock`, JSON.stringify({ pid: holder.pid, token, at: Date.now() }));
		const err = (await client.request("dispatch", args("sleep 1", { sessionFile })).catch((e) => e)) as DaemonError;
		expect(err.code).toBe("locked");
		expect(err.message).toContain(String(holder.pid));

		const shared = join(work, "shared.jsonl");
		await client.request("dispatch", args("sleep 30", { sessionFile: shared }));
		await expect(client.request("dispatch", args("sleep 30", { sessionFile: shared }))).rejects.toMatchObject({
			code: "locked",
		});
	});

	it("validates dispatch args", async () => {
		const { client } = await startDaemon();
		await expect(client.request("dispatch", args("true", { cwd: join(work, "nope") }))).rejects.toMatchObject({
			code: "bad_request",
		});
		await expect(client.request("dispatch", args("true", { command: [] }))).rejects.toMatchObject({
			code: "bad_request",
		});
		await expect(client.request("dispatch", args("true", { sessionFile: "rel.jsonl" }))).rejects.toMatchObject({
			code: "bad_request",
		});
	});

	it("de-duplicates names", async () => {
		const { client } = await startDaemon();
		const a = await client.request("dispatch", args("sleep 30", { name: "dup" }));
		const b = await client.request("dispatch", args("sleep 30", { name: "dup" }));
		const c = await client.request("dispatch", args("sleep 30", { name: "dup" }));
		expect([a.name, b.name, c.name]).toEqual(["dup", "dup (2)", "dup (3)"]);
	});

	it("resolves by prefix and name substring, reports ambiguity", async () => {
		const { client } = await startDaemon();
		const a = await client.request("dispatch", args("sleep 30", { name: "Alpha build" }));
		const b = await client.request("dispatch", args("sleep 30", { name: "alpha test" }));
		const c = await client.request("dispatch", args("sleep 30", { name: "gamma" }));
		expect((await client.request("resolve", { query: a.id.slice(0, 6) })).id).toBe(a.id);
		expect((await client.request("resolve", { query: a.id })).id).toBe(a.id);
		expect((await client.request("resolve", { query: "GAMM" })).id).toBe(c.id);
		const err = (await client.request("resolve", { query: "alpha" }).catch((e) => e)) as DaemonError;
		expect(err.code).toBe("ambiguous");
		expect(err.message).toContain(a.id);
		expect(err.message).toContain(b.id);
		await expect(client.request("resolve", { query: "zzzz" })).rejects.toMatchObject({ code: "not_found" });
	});

	it("keeps workers across a daemon restart (DM-6)", async () => {
		const first = await startDaemon();
		const { id } = await first.client.request("dispatch", args("sleep 30"));
		await waitFor(async () => (await find(first.client, id))?.pid);
		const hostPid = readState(id)!.hostPid!;
		await first.client.request("shutdown", { keepWorkers: true });
		await waitFor(() => exited(first.proc));
		expect(existsSync(daemonSocketPath())).toBe(false);
		expect(isAlive(hostPid)).toBe(true);

		const second = await startDaemon();
		const row = await find(second.client, id);
		expect(row?.state).toBe("working");
		expect(row?.pid).toBeTypeOf("number");
		await second.client.request("stop", { id });
		await waitFor(async () => (await find(second.client, id))?.state === "stopped");
	});

	it("finalizes jobs whose host died while the daemon was down (no resume: the session ends)", async () => {
		const first = await startDaemon();
		const { id } = await first.client.request("dispatch", args("sleep 30"));
		await waitFor(async () => (await find(first.client, id))?.pid);
		const hostPid = readState(id)!.hostPid!;
		await first.client.request("shutdown", { keepWorkers: true });
		await waitFor(() => exited(first.proc));
		process.kill(hostPid, "SIGKILL");
		const second = await startDaemon();
		const row = await find(second.client, id);
		// DM-7: recent progress: failed, to be started again by a reply; never by itself (no M38)
		expect(row?.state).toBe("failed");
		expect(readState(id)?.error).toMatch(/machine restart/);
		await new Promise((r) => setTimeout(r, 1500));
		expect((await find(second.client, id))?.pid).toBeNull();
		expect(readState(id)?.resumeAt).toBeUndefined();
	});

	it("DM-7: a run whose last progress is older than 48 h shows as stopped", async () => {
		const first = await startDaemon();
		const { id } = await first.client.request("dispatch", args("sleep 30"));
		await waitFor(async () => (await find(first.client, id))?.pid);
		const hostPid = readState(id)!.hostPid!;
		await first.client.request("shutdown", { keepWorkers: true });
		await waitFor(() => exited(first.proc));
		process.kill(hostPid, "SIGKILL");
		const old = Date.now() - 49 * 3600_000;
		const statePath = join(jobDir(id), "state.json");
		const st = JSON.parse(readFileSync(statePath, "utf8"));
		writeFileSync(statePath, JSON.stringify({ ...st, reportedAt: old, updatedAt: old }));
		const second = await startDaemon();
		expect((await find(second.client, id))?.state).toBe("stopped");
		expect(readState(id)?.error).toBe("ended while the background service was off");
	});

	it("M15: records of sessions ended long ago are removed; pinned and recent ones stay", async () => {
		process.env.ROOST_CLEANUP_DAYS = "1";
		process.env.ROOST_CLEANUP_CHECK_MS = "1";
		process.env.ROOST_REAP_CHECK_MS = "150";
		const { client } = await startDaemon();
		const ids: string[] = [];
		for (const name of ["old", "pinned", "recent"])
			ids.push((await client.request("dispatch", args("true", { name }))).id);
		await waitFor(async () => {
			const jobs = (await client.request("list", { all: true })).jobs;
			return ids.every((id) => jobs.find((j) => j.id === id)?.endedAt);
		});
		const old = Date.now() - 3 * 24 * 3600_000;
		for (const [i, id] of ids.entries()) {
			if (i === 2) continue;
			const statePath = join(jobDir(id), "state.json");
			const st = JSON.parse(readFileSync(statePath, "utf8"));
			writeFileSync(statePath, JSON.stringify({ ...st, endedAt: old, ...(i === 1 ? { pinned: true } : {}) }));
		}
		await waitFor(async () => !(await client.request("list", { all: true })).jobs.some((j) => j.id === ids[0]));
		const left = (await client.request("list", { all: true })).jobs.map((j) => j.id);
		expect(left).toContain(ids[1]);
		expect(left).toContain(ids[2]);
		expect(existsSync(jobDir(ids[0]!))).toBe(false);
	});

	it("shutdown without keepWorkers terminates hosts", async () => {
		const first = await startDaemon();
		const { id } = await first.client.request("dispatch", args("sleep 30"));
		await waitFor(async () => (await find(first.client, id))?.pid);
		const hostPid = readState(id)!.hostPid!;
		await first.client.request("shutdown", {});
		await waitFor(() => exited(first.proc));
		expect(isAlive(hostPid)).toBe(false);
		expect(readState(id)?.state).toBe("stopped");
	});

	it("a second daemon exits 0 and leaves the first alone", async () => {
		const first = await startDaemon();
		const second = spawn(process.execPath, [DAEMON], {
			stdio: "ignore",
			env: { ...process.env, ROOST_PARENT_PID: String(process.pid) },
		});
		daemons.push(second);
		await waitFor(() => exited(second));
		expect(second.exitCode).toBe(0);
		expect(exited(first.proc)).toBe(false);
		const pong = await first.client.request("ping", {});
		expect(pong.pid).toBe(first.proc.pid);
		const st = await first.client.request("status", {});
		expect(st.pid).toBe(first.proc.pid);
		expect(st.ptyError).toBeNull();
	});

	it("survives garbage lines", async () => {
		const { proc, client } = await startDaemon();
		mkdirSync(rt, { recursive: true });
		const sock = createConnection(daemonSocketPath());
		const lines: string[] = [];
		sock.on("data", (d) => lines.push(...d.toString().split("\n").filter(Boolean)));
		await new Promise((r) => sock.once("connect", r));
		sock.write('{not json\n\n[1,2]\n{"id":7}\n{"id":8,"op":"nope"}\n');
		await waitFor(() => lines.length >= 2);
		sock.destroy();
		const msgs = lines.map((l) => JSON.parse(l));
		expect(msgs.map((m) => m.code)).toEqual(["bad_request", "bad_request"]);
		expect(exited(proc)).toBe(false);
		await client.request("ping", {});
	});
});

describe("worker reports", () => {
	const report = (over: Record<string, unknown> = {}) => ({
		state: "blocked" as const,
		status: "waiting" as const,
		waitingFor: "question" as const,
		summary: "double-ended or single-ended reset?",
		question: "double-ended or single-ended reset?",
		choices: ["double", "single"],
		tool: null,
		error: null,
		name: "reset question",
		model: "x/y",
		...over,
	});

	it("accepts a report with the job token and shows it in the row", async () => {
		const { client } = await startDaemon();
		const { id } = await client.request("dispatch", args("sleep 30"));
		await waitFor(async () => (await find(client, id))?.pid);
		const token = readState(id)?.jobToken as string;
		await expect((await asWorker()).request("report", { id, token: "nope", report: report() })).rejects.toMatchObject(
			{ code: "unauthorized" },
		);
		await (await asWorker()).request("report", { id, token, report: report() });
		const row = (await find(client, id))!;
		expect(row).toMatchObject({
			state: "blocked",
			status: "waiting",
			waitingFor: "question",
			summary: "double-ended or single-ended reset?",
			choices: ["double", "single"],
			name: "reset question",
			model: "x/y",
		});
		await expect(
			(await asWorker()).request("report", { id, token, report: report({ state: "bogus" }) }),
		).rejects.toMatchObject({
			code: "bad_request",
		});
	});

	it("M24: takes the session's usage, validates it, and keeps it when a report has none", async () => {
		const { client } = await startDaemon();
		const { id } = await client.request("dispatch", args("sleep 30"));
		await waitFor(async () => (await find(client, id))?.pid);
		const token = readState(id)?.jobToken as string;
		const usage = {
			input: 10,
			output: 20,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 1.25,
			today: 0.5,
			day: 1,
			sub: false,
			models: { "a/b": { cost: 1.25, tokens: 30 } },
		};
		await (await asWorker()).request("report", { id, token, report: { ...report(), usage } });
		expect((await find(client, id))?.usage).toEqual(usage);
		await (await asWorker()).request("report", { id, token, report: report() });
		expect((await find(client, id))?.usage?.cost).toBe(1.25);
		await (await asWorker()).request("report", {
			id,
			token,
			report: { ...report(), usage: { cost: "x", models: [] } as never },
		});
		expect((await find(client, id))?.usage).toMatchObject({ cost: 0, sub: false });
	});

	it("M8: takes thinking and context use, validates them, and keeps them when a report has neither", async () => {
		const { client } = await startDaemon();
		const { id } = await client.request("dispatch", args("sleep 30"));
		await waitFor(async () => (await find(client, id))?.pid);
		const token = readState(id)?.jobToken as string;
		const context = { tokens: 86_000, window: 200_000, percent: 43 };
		await (await asWorker()).request("report", { id, token, report: report({ thinking: "high", context }) });
		expect(await find(client, id)).toMatchObject({ model: "x/y", thinking: "high", context });
		// a worker before 0.1.5 sends neither field: the last known values stay
		await (await asWorker()).request("report", { id, token, report: report() });
		expect(await find(client, id)).toMatchObject({ thinking: "high", context });
		// garbage is dropped, not stored
		await (await asWorker()).request("report", {
			id,
			token,
			report: report({ context: { tokens: "lots", window: -1 } }),
		});
		expect((await find(client, id))?.context).toBeNull();
		await (await asWorker()).request("report", {
			id,
			token,
			report: report({ context: { tokens: null, window: 200_000, percent: null } }),
		});
		expect((await find(client, id))?.context).toEqual({ tokens: null, window: 200_000, percent: null });
	});

	it("keeps the last reported state when the worker exits cleanly, clears live fields", async () => {
		const { client } = await startDaemon();
		const { id } = await client.request("dispatch", args("sleep 1.5"));
		await waitFor(async () => (await find(client, id))?.pid);
		const token = readState(id)?.jobToken as string;
		await (await asWorker()).request("report", { id, token, report: report() });
		const ended = await waitFor(async () => {
			const r = await find(client, id);
			return r?.endedAt ? r : undefined;
		});
		expect(ended.state).toBe("blocked");
		expect(ended.status).toBeNull();
		expect(ended.waitingFor).toBeNull();
		expect(ended.summary).toBe("double-ended or single-ended reset?");
	});

	it("a non-zero exit is failed even after a done report; stop wins over reports", async () => {
		const { client } = await startDaemon();
		const a = await client.request("dispatch", args("sleep 1; exit 3"));
		const b = await client.request("dispatch", args("sleep 30"));
		await waitFor(async () => (await find(client, a.id))?.pid && (await find(client, b.id))?.pid);
		const done = report({ state: "done", status: "idle", waitingFor: null, question: null, choices: [] });
		await (await asWorker()).request("report", {
			id: a.id,
			token: readState(a.id)?.jobToken as string,
			report: done,
		});
		const failed = await waitFor(async () => {
			const r = await find(client, a.id);
			return r?.endedAt ? r : undefined;
		});
		expect(failed.state).toBe("failed");
		expect(failed.error).toMatch(/code 3/);
		await client.request("stop", { id: b.id });
		await (await asWorker()).request("report", {
			id: b.id,
			token: readState(b.id)?.jobToken as string,
			report: done,
		});
		const stopped = await waitFor(async () => {
			const r = await find(client, b.id);
			return r?.endedAt ? r : undefined;
		});
		expect(stopped.state).toBe("stopped");
	});
});

describe("replies", () => {
	const working = {
		state: "working" as const,
		status: "busy" as const,
		waitingFor: null,
		summary: null,
		question: null,
		choices: [],
		tool: null,
		error: null,
		name: null,
		model: null,
	};

	it("pushes replies to the worker's connection, keeps them until acked; saves when not connected", async () => {
		const { client } = await startDaemon();
		const { id } = await client.request("dispatch", args("sleep 30"));
		await waitFor(async () => (await find(client, id))?.pid);
		const token = readState(id)?.jobToken as string;

		// no worker connection yet: saved for later (PK-5); commands are not saved
		expect(await client.request("reply", { id, text: "first" })).toEqual({ delivered: false, saved: true });
		expect(await client.request("reply", { id, text: "/name x" })).toEqual({ delivered: false, saved: false });
		await expect(client.request("reply", { id, text: "!ls" })).rejects.toMatchObject({ code: "unsupported" });

		const worker = await DaemonClient.connect();
		clients.push(worker);
		const got: { seq: number; text: string }[] = [];
		worker.onEvent((e) => {
			if (e.event === "deliver") got.push({ seq: e.seq, text: e.text });
		});
		await worker.request("report", { id, token, report: working });
		await waitFor(() => got.length === 1);
		expect(got[0]).toEqual({ seq: 1, text: "first" });

		expect(await client.request("reply", { id, text: "  second  " })).toEqual({ delivered: true, saved: false });
		await waitFor(() => got.length === 2);
		expect(got[1]).toEqual({ seq: 2, text: "second" });
		// unacked replies stay pending and are resent on the next worker connection
		expect((readState(id)?.pendingReplies as unknown[]).length).toBe(2);
		await expect(worker.request("ack", { id, token: "bad", seq: 1 })).rejects.toMatchObject({ code: "unauthorized" });
		await worker.request("ack", { id, token, seq: 1 });
		expect(readState(id)?.pendingReplies).toEqual([{ seq: 2, text: "second" }]);

		const again = await DaemonClient.connect();
		clients.push(again);
		const resent: number[] = [];
		again.onEvent((e) => {
			if (e.event === "deliver") resent.push(e.seq);
		});
		await again.request("report", { id, token, report: working });
		await waitFor(() => resent.length === 1);
		expect(resent).toEqual([2]);

		// M28: a steering reply keeps its mode, also when it is sent again
		const modes: (string | undefined)[] = [];
		again.onEvent((e) => {
			if (e.event === "deliver") modes.push(e.mode);
		});
		expect(await client.request("reply", { id, text: "use pnpm", mode: "steer" })).toEqual({
			delivered: true,
			saved: false,
		});
		await waitFor(() => modes.length === 1);
		expect(modes).toEqual(["steer"]);
		expect((readState(id)?.pendingReplies as { mode?: string }[]).at(-1)).toMatchObject({
			text: "use pnpm",
			mode: "steer",
		});
		await client.request("reply", { id, text: "plain", mode: "sideways" as never });
		await waitFor(() => modes.length === 2);
		expect(modes[1]).toBeUndefined();

		expect(await client.request("reply", { id, text: "/stop" })).toMatchObject({ stopped: true });
		const row = await waitFor(async () => {
			const r = await find(client, id);
			return r?.state === "stopped" ? r : undefined;
		});
		expect(row.endedAt).toBeTypeOf("number");
	});

	it("saves replies to an ended job", async () => {
		const { client } = await startDaemon();
		const { id } = await client.request("dispatch", args("sleep 0.2"));
		await waitFor(async () => (await find(client, id))?.endedAt);
		await waitFor(async () => (await find(client, id))?.endedAt);
		// flow 5.7: the reply is kept and the session starts again to receive it
		expect(await client.request("reply", { id, text: "continue" })).toEqual({
			delivered: false,
			saved: true,
			respawned: true,
		});
		expect(readState(id)?.pendingReplies).toEqual([{ seq: 1, text: "continue" }]);
		await waitFor(async () => (await find(client, id))?.endedAt);
		expect(await client.request("reply", { id, text: "/stop" })).toMatchObject({ stopped: false, delivered: false });
		await expect(client.request("reply", { id, text: "   " })).rejects.toMatchObject({ code: "bad_request" });
	});
});

describe("lifecycle", () => {
	const idle = {
		state: "done" as const,
		status: "idle" as const,
		waitingFor: null,
		summary: "all done",
		question: null,
		choices: [],
		tool: null,
		error: null,
		name: null,
		model: null,
	};

	it("M8: a respawn runs the model it last reported, or before any report the one it was dispatched with", async () => {
		const { client } = await startDaemon();
		const a = args("sleep 0.2", { sessionFile: join(work, "m8.jsonl"), model: "a/m", thinking: "low" });
		a.command = ["/bin/sh", "-c", "sleep 0.2", "--model", "a/m", "--thinking", "low", "--", "first"];
		writeFileSync(a.sessionFile, "{}\n");
		const { id } = await client.request("dispatch", a);
		await waitFor(async () => (await find(client, id))?.endedAt);
		await client.request("respawn", { id });
		expect(readState(id)?.command).toEqual(["/bin/sh", "-c", "sleep 0.2", "--model", "a/m", "--thinking", "low"]);
		await waitFor(async () => (await find(client, id))?.pid);
		const token = readState(id)?.jobToken as string;
		const report = {
			state: "working" as const,
			status: "busy" as const,
			waitingFor: null,
			summary: null,
			question: null,
			choices: [],
			tool: null,
			error: null,
			name: null,
			model: "b/n",
			thinking: "off",
		};
		await (await asWorker()).request("report", { id, token, report });
		await waitFor(async () => (await find(client, id))?.endedAt);
		await client.request("respawn", { id });
		expect(readState(id)?.command).toEqual(["/bin/sh", "-c", "sleep 0.2", "--model", "b/n", "--thinking", "off"]);
		await waitFor(async () => (await find(client, id))?.endedAt);
	});

	it("respawn starts an ended job again without its first prompt once the session exists", async () => {
		const { client } = await startDaemon();
		const a = args("sleep 0.2", { sessionFile: join(work, "written.jsonl") });
		a.command = ["/bin/sh", "-c", "sleep 0.2", "--", "first prompt"];
		writeFileSync(a.sessionFile, "{}\n");
		const { id } = await client.request("dispatch", a);
		await waitFor(async () => (await find(client, id))?.endedAt);
		expect(existsSync(join(jobDir(id), "exit.json"))).toBe(true);
		const { results } = await client.request("respawn", { id, prompt: "go on" });
		expect(results).toEqual([{ id, started: true }]);
		const row = await waitFor(async () => {
			const r = await find(client, id);
			return r?.pid ? r : undefined;
		});
		expect(row.state).toBe("working");
		expect(row.endedAt).toBeNull();
		expect(readState(id)?.command).toEqual(["/bin/sh", "-c", "sleep 0.2", "--", "go on"]);
		// already live: nothing to do unless asked to restart
		expect((await client.request("respawn", { id })).results).toEqual([{ id, started: false }]);
		await waitFor(async () => (await find(client, id))?.state === "done");
	});

	it("DM-5: a worker that keeps crashing mid-run is restarted 3 times, then left failed", async () => {
		process.env.ROOST_RESUME_DELAYS_MS = "50,50,50";
		const { client } = await startDaemon();
		const { id } = await client.request("dispatch", args("sleep 0.3; exit 3"));
		const row = await waitFor(async () => {
			const r = await find(client, id);
			return r?.state === "failed" && readState(id)?.crashRestarts === 3 ? r : undefined;
		}, 15000);
		expect(row.error).toMatch(/code 3.*not restarted again after 3 automatic restarts/);
		expect(readState(id)?.resumeAt).toBeUndefined();
	});

	it("DM-4: reaps an idle unattached worker, keeps the row, and wakes it on reply", async () => {
		process.env.ROOST_REAP_MINUTES = "0.005"; // 300 ms
		process.env.ROOST_REAP_CHECK_MS = "100";
		const { client } = await startDaemon();
		const { id } = await client.request("dispatch", args("sleep 30"));
		await waitFor(async () => (await find(client, id))?.pid);
		const token = readState(id)?.jobToken as string;
		await (await asWorker()).request("report", { id, token, report: idle });
		const row = await waitFor(async () => {
			const r = await find(client, id);
			return r?.reaped ? r : undefined;
		});
		expect(row).toMatchObject({ state: "done", pid: null, summary: "all done" });
		expect(readState(id)?.stopRequested).not.toBe(true);
		expect(await client.request("reply", { id, text: "one more thing" })).toMatchObject({ respawned: true });
		const back = await waitFor(async () => {
			const r = await find(client, id);
			return r?.pid ? r : undefined;
		});
		expect(back.reaped).toBe(false);
	});

	it("does not reap a job with replies waiting; restarting a working job continues its turn", async () => {
		process.env.ROOST_REAP_MINUTES = "0.002";
		process.env.ROOST_REAP_CHECK_MS = "50";
		const { client } = await startDaemon();
		const a = args("sleep 30", { sessionFile: join(work, "w.jsonl") });
		writeFileSync(a.sessionFile, "{}\n");
		const { id } = await client.request("dispatch", a);
		await waitFor(async () => (await find(client, id))?.pid);
		// never connected as a worker: the reply stays pending
		expect(await client.request("reply", { id, text: "later" })).toMatchObject({ saved: true });
		await (await asWorker()).request("report", { id, token: readState(id)?.jobToken as string, report: idle });
		await new Promise((r) => setTimeout(r, 600));
		expect((await find(client, id))?.reaped).toBe(false);
		expect((await find(client, id))?.pid).toBeTruthy();

		const b = args("sleep 30", { sessionFile: join(work, "w2.jsonl") });
		writeFileSync(b.sessionFile, "{}\n");
		const busy = await client.request("dispatch", b);
		await waitFor(async () => (await find(client, busy.id))?.pid);
		await client.request("respawn", { id: busy.id, restart: true });
		expect(readState(busy.id)?.command).toEqual(["/bin/sh", "-c", "sleep 30", "--", "Continue where you left off."]);
		expect(readState(busy.id)?.restore).toBe(false);
	});

	it("never reaps a pinned or working job", async () => {
		process.env.ROOST_REAP_MINUTES = "0.002";
		process.env.ROOST_REAP_CHECK_MS = "50";
		const { client } = await startDaemon();
		const busy = await client.request("dispatch", args("sleep 30"));
		const pinned = await client.request("dispatch", args("sleep 30"));
		await waitFor(async () => (await find(client, busy.id))?.pid && (await find(client, pinned.id))?.pid);
		const statePath = join(jobDir(pinned.id), "state.json");
		writeFileSync(statePath, JSON.stringify({ ...JSON.parse(readFileSync(statePath, "utf8")), pinned: true }));
		await (await asWorker()).request("report", {
			id: pinned.id,
			token: readState(pinned.id)?.jobToken as string,
			report: idle,
		});
		await new Promise((r) => setTimeout(r, 800));
		expect((await find(client, busy.id))?.pid).toBeTruthy();
		expect((await find(client, pinned.id))?.pid).toBeTruthy();
	});

	it("respawn --all restarts live and reaped jobs but leaves finished ones", async () => {
		const { client } = await startDaemon();
		const live = await client.request("dispatch", args("sleep 30"));
		const ended = await client.request("dispatch", args("true"));
		await waitFor(async () => (await find(client, live.id))?.pid && (await find(client, ended.id))?.endedAt);
		const before = readState(live.id)?.hostPid;
		const { results } = await client.request("respawn", { all: true });
		expect(results).toEqual([{ id: live.id, started: true }]);
		await waitFor(async () => {
			const r = await find(client, live.id);
			return r?.pid && readState(live.id)?.hostPid !== before;
		});
	});
});

describe("organise ops", () => {
	it("pin, rename and reorder are stored and listed", async () => {
		const { client } = await startDaemon();
		const a = await client.request("dispatch", args("sleep 30", { name: "alpha" }));
		const b = await client.request("dispatch", args("sleep 30", { name: "beta" }));
		expect(await client.request("pin", { id: a.id, pinned: true })).toEqual({ id: a.id, pinned: true });
		await client.request("rename", { id: b.id, name: "  gamma   ray " });
		await client.request("reorder", { ids: [b.id, a.id], key: "working" });
		const ra = await find(client, a.id);
		const rb = await find(client, b.id);
		expect(ra).toMatchObject({ pinned: true, order: 1, orderKey: "working" });
		expect(rb).toMatchObject({ name: "gamma ray", order: 0 });
		expect((await client.request("resolve", { query: "gamma" })).id).toBe(b.id);
		await expect(client.request("rename", { id: b.id, name: " " })).rejects.toMatchObject({ code: "bad_request" });
		await expect(client.request("reorder", { ids: ["nope"], key: "working" })).rejects.toMatchObject({
			code: "bad_request",
		});
	});

	it("a rename outlives reports of the old session name and waits for the worker as a /name reply", async () => {
		const { client } = await startDaemon();
		const { id } = await client.request("dispatch", args("sleep 30", { name: "old" }));
		await waitFor(async () => (await find(client, id))?.pid);
		await client.request("rename", { id, name: "new name" });
		expect(readState(id)?.pendingReplies).toEqual([{ seq: 1, text: "/name new name" }]);
		const token = readState(id)?.jobToken as string;
		const report = (name: string) => ({
			state: "working" as const,
			status: "busy" as const,
			waitingFor: null,
			summary: null,
			question: null,
			choices: [],
			tool: null,
			error: null,
			name,
			model: null,
		});
		await (await asWorker()).request("report", { id, token, report: report("old") });
		expect((await find(client, id))?.name).toBe("new name");
		await (await asWorker()).request("report", { id, token, report: report("new name") });
		expect(readState(id)?.pendingName).toBeNull();
	});
});

// M76: the daemon checks these ops' arguments by their schemas at its entry; the hand checks it
// replaced answered in these words (each pinned, so a check lost on the way shows here)
describe("M76: the entry check", () => {
	it("answers bad arguments in the words the ops said", async () => {
		const { client } = await startDaemon();
		const { id } = await client.request("dispatch", args("sleep 30", { name: "alpha" }));
		const bad = (c: DaemonClient, op: string, a: unknown) => c.request(op as "ping", a as Record<string, never>);
		const cases: [DaemonClient, string, unknown, string][] = [
			[client, "resolve", {}, "query required"],
			[client, "stop", {}, "id required"],
			[client, "rename", { id, name: " " }, "empty name"],
			[client, "reorder", { ids: [id] }, "key required"],
			[client, "reorder", { ids: "x", key: "k" }, "ids must be job ids"],
			[client, "reply", { id, text: " " }, "empty reply"],
			[client, "reply", { id, text: "x", requestId: "a b" }, "requestId: 1-64 of A-Z a-z 0-9 _ . : -"],
			[client, "events", { after: "x" }, "after must be a number"],
			[client, "events", { limit: "x" }, "limit must be a number"],
			[client, "events", { id: "" }, "id must be a job id"],
			[await asWorker(), "hello", { protocol: 0 }, "protocol must be a version number"],
			// M77
			[client, "dispatch", { requestId: "a b" }, "requestId: 1-64 of A-Z a-z 0-9 _ . : -"],
		];
		for (const [c, op, a, words] of cases)
			await expect(bad(c, op, a), `${op} ${JSON.stringify(a)}`).rejects.toMatchObject({
				code: "bad_request",
				message: words,
			});
		// what the daemon took before, it takes: a fractional cursor, capabilities that are not strings
		expect(await client.request("events", { after: 0.5, limit: 2.5 })).toMatchObject({ cursor: expect.any(Number) });
		expect(
			await (await asWorker()).request("hello", { protocol: 1, capabilities: [1, "report"] as string[] }),
		).toMatchObject({ protocol: expect.any(Number) });
		// a report for a job that ended is taken whatever it says; for a live one, refused in its words
		const token = readState(id)?.jobToken as string;
		const fresh = async () => {
			const c = await DaemonClient.connect();
			clients.push(c);
			return c;
		};
		await expect(
			(await fresh()).request("report", { id, token, report: { state: "x" } as never }),
		).rejects.toMatchObject({ code: "bad_request", message: "invalid report" });
		await client.request("stop", { id });
		await waitFor(async () => (await find(client, id))?.state === "stopped");
		expect(await (await fresh()).request("report", { id, token, report: { state: "x" } as never })).toEqual({});
		// an op the daemon does not have is refused as one
		await expect(client.request("task" as "ping", { action: "list" } as never)).rejects.toMatchObject({
			code: "bad_request",
			message: "unknown op: task",
		});
	});
});

describe("shell jobs (DI-6)", () => {
	it("runs without a session, shows its last output line, and goes away after a while", async () => {
		process.env.ROOST_SHELL_KEEP_MS = "1500";
		const { client } = await startDaemon();
		const { id } = await client.request("dispatch", {
			...args("echo first; echo LAST-LINE; sleep 5"),
			kind: "shell",
			sessionFile: "",
		});
		const live = await waitFor(async () => {
			const r = await find(client, id);
			return r?.summary === "LAST-LINE" ? r : undefined;
		}, 8000);
		expect(live).toMatchObject({ kind: "shell", status: "busy", sessionFile: "" });
		await expect(client.request("reply", { id, text: "hello" })).rejects.toMatchObject({ code: "unsupported" });
		const done = await waitFor(async () => {
			const r = await find(client, id);
			return r?.endedAt ? r : undefined;
		}, 8000);
		expect(done).toMatchObject({ state: "done", summary: "LAST-LINE" });
		await waitFor(async () => !(await find(client, id)), 8000);
		delete process.env.ROOST_SHELL_KEEP_MS;
	});

	it("a command that prints nothing is pushed with its pid once it runs", async () => {
		const { client } = await startDaemon();
		const events: Event[] = [];
		await client.request("subscribe", {});
		client.onEvent((e) => events.push(e));
		const { id } = await client.request("dispatch", { ...args("sleep 5"), kind: "shell", sessionFile: "" });
		await waitFor(
			async () => events.some((e) => e.event === "job" && e.job.id === id && e.job.pid !== null) || undefined,
			8000,
		);
		await client.request("stop", { id });
	});

	it("a failing command ends failed with its exit code", async () => {
		const { client } = await startDaemon();
		const { id } = await client.request("dispatch", { ...args("exit 4"), kind: "shell", sessionFile: "" });
		const r = await waitFor(async () => {
			const x = await find(client, id);
			return x?.endedAt ? x : undefined;
		});
		expect(r).toMatchObject({ state: "failed", error: "exited with code 4" });
		expect(readState(id)?.crashRestarts ?? 0).toBe(0);
	});
});

describe("shell jobs and lifecycle", () => {
	it("respawn --all leaves a running shell job alone; a stopped one is still removed later", async () => {
		process.env.ROOST_SHELL_KEEP_MS = "800";
		const { client } = await startDaemon();
		const { id } = await client.request("dispatch", { ...args("sleep 30"), kind: "shell", sessionFile: "" });
		await waitFor(async () => (await find(client, id))?.pid);
		const host = readState(id)?.hostPid;
		expect((await client.request("respawn", { all: true })).results).toEqual([]);
		expect(readState(id)?.hostPid).toBe(host);
		await client.request("stop", { id });
		const r = await waitFor(async () => {
			const x = await find(client, id);
			return x?.endedAt ? x : undefined;
		});
		expect(r.state).toBe("stopped");
		await waitFor(async () => !(await find(client, id)), 8000);
	});
});

describe("M22: one row per session", () => {
	it("a job that runs an ended job's session again takes its row, name and pin", async () => {
		const { client } = await startDaemon();
		const sessionFile = join(work, "same.jsonl");
		const a = await client.request("dispatch", args("true", { sessionFile, name: "fix-login" }));
		await waitFor(async () => (await find(client, a.id))?.endedAt);
		await client.request("pin", { id: a.id, pinned: true });
		const events: Event[] = [];
		client.onEvent((e) => events.push(e));
		await client.request("subscribe", {});
		// moved to the background again from another xpi window
		const b = await client.request("dispatch", args("sleep 30", { sessionFile, name: "fix-login", origin: "adopt" }));
		expect(b.name).toBe("fix-login");
		await waitFor(() => events.some((e) => e.event === "removed" && e.id === a.id));
		const rows = (await client.request("list", {})).jobs;
		expect(rows.map((r) => r.id)).toEqual([b.id]);
		expect(rows[0]!.pinned).toBe(true);
		// its records stay, only the row goes
		expect(readState(a.id)?.supersededBy).toBe(b.id);
		// the job that took it over goes: the old row is back, and the next one takes it again
		await client.request("rm", { id: b.id });
		await waitFor(async () => (await client.request("list", {})).jobs.some((r) => r.id === a.id));
		const c = await client.request("dispatch", args("sleep 30", { sessionFile, name: "fix-login", origin: "adopt" }));
		await waitFor(async () => {
			const ids = (await client.request("list", {})).jobs.map((r) => r.id);
			return ids.length === 1 && ids[0] === c.id;
		});
	});

	it("a live job's worker shows with its pid before it reports", async () => {
		const { client } = await startDaemon();
		const events: Event[] = [];
		client.onEvent((e) => events.push(e));
		await client.request("subscribe", {});
		const { id } = await client.request("dispatch", args("sleep 30"));
		await waitFor(() => events.some((e) => e.event === "job" && e.job.id === id && e.job.pid !== null), 6000);
	});
});

describe("M31 the agent protocol", () => {
	it("hello: the daemon answers with its protocol and capabilities; a bad one is refused", async () => {
		const { client } = await startDaemon();
		const r = await client.request("hello", { protocol: 1, agent: { name: "x" }, capabilities: ["report"] });
		expect(r).toMatchObject({ protocol: 1, daemon: { name: "roost" } });
		expect(r.capabilities).toContain("replies");
		// a newer protocol is answered with this one: the agent decides
		expect((await client.request("hello", { protocol: 7 })).protocol).toBe(1);
		await expect(client.request("hello", { protocol: "one" } as never)).rejects.toMatchObject({
			code: "bad_request",
		});
	});
});

describe("M35 a state file lost in a crash", () => {
	it("leaves the job listed, failed and startable, after a restart", async () => {
		const first = await startDaemon();
		const { id } = await first.client.request("dispatch", args("exit 0"));
		await waitFor(async () => (await find(first.client, id))?.endedAt);
		await first.client.request("shutdown", {});
		await waitFor(() => exited(first.proc));
		writeFileSync(join(jobDir(id), "state.json"), "");
		const second = await startDaemon();
		const row = await find(second.client, id);
		expect(row).toMatchObject({ state: "failed" });
		expect(row?.error).toMatch(/lost in a crash/);
	});
});

describe("M36 request ids", () => {
	it("a reply or a dispatch sent again with the same id is taken once", async () => {
		const { client } = await startDaemon();
		const a = { ...args("sleep 30"), requestId: "d-1" };
		const { id } = await client.request("dispatch", a);
		expect((await client.request("dispatch", a)).id).toBe(id);
		expect([...(await client.request("list", {})).jobs].filter((j) => j.id === id)).toHaveLength(1);
		const first = await client.request("reply", { id, text: "hello", requestId: "r-1" });
		expect(first.duplicate).toBeUndefined();
		expect(await client.request("reply", { id, text: "hello", requestId: "r-1" })).toMatchObject({
			duplicate: true,
			saved: true,
		});
		const pending = readState(id)?.pendingReplies as { text: string }[];
		expect(pending.filter((p) => p.text === "hello")).toHaveLength(1);
		await expect(client.request("reply", { id, text: "x", requestId: "bad id!" })).rejects.toMatchObject({
			code: "bad_request",
		});
		await client.request("stop", { id });
	});
});

describe("M36 a resend after the daemon died before starting the job", () => {
	it("starts the ended job for the reply it took", async () => {
		const { client } = await startDaemon();
		const { id } = await client.request("dispatch", args("sleep 30"));
		await waitFor(async () => (await find(client, id))?.pid);
		await client.request("stop", { id });
		await waitFor(async () => (await find(client, id))?.endedAt);
		// as if a reply was taken (kept with its id) and the daemon died before starting the job
		const file = join(jobDir(id), "state.json");
		const st = JSON.parse(readFileSync(file, "utf8"));
		writeFileSync(
			file,
			JSON.stringify({ ...st, replySeq: 2, pendingReplies: [{ seq: 2, text: "kept" }], requestIds: ["r-kept"] }),
		);
		expect(await client.request("reply", { id, text: "kept", requestId: "r-kept" })).toMatchObject({
			duplicate: true,
			respawned: true,
		});
		await waitFor(async () => (await find(client, id))?.pid);
		await client.request("stop", { id });
	});
});

describe("DM-5: a crashed run carries on; a session whose host is gone ends", () => {
	const kill = (pid: number) => {
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	};

	it("a host killed under a working run ends the session: failed, not restarted (no M38)", async () => {
		process.env.ROOST_RESUME_DELAYS_MS = "50,50,50";
		const { client } = await startDaemon();
		const { id } = await client.request("dispatch", args("sleep 30"));
		await waitFor(async () => (await find(client, id))?.pid);
		kill(readState(id)!.hostPid!);
		const r = await waitFor(async () => {
			const x = await find(client, id);
			return x?.endedAt ? x : undefined;
		}, 15000);
		expect(r.state).toBe("failed");
		expect(r.error).toBe("host vanished");
		await new Promise((res) => setTimeout(res, 500));
		expect((await find(client, id))?.pid).toBeNull();
		expect(readState(id)?.crashRestarts ?? 0).toBe(0);
	});

	it("a stop while a restart waits calls it off", async () => {
		process.env.ROOST_RESUME_DELAYS_MS = "3000";
		const { client } = await startDaemon();
		const { id } = await client.request("dispatch", args("sleep 0.2; exit 3"));
		const waiting = await waitFor(async () => {
			const r = await find(client, id);
			return r?.endedAt && typeof readState(id)?.resumeAt === "number" ? r : undefined;
		});
		expect(waiting.state).toBe("working");
		expect(waiting.error).toMatch(/continuing in 3 s \(automatic restart 1 of 1\)/);
		await client.request("stop", { id });
		expect((await find(client, id))?.state).toBe("stopped");
		await new Promise((r) => setTimeout(r, 3500));
		const after = await find(client, id);
		expect(after?.state).toBe("stopped");
		expect(after?.pid).toBeNull();
		expect(readState(id)?.crashRestarts ?? 0).toBe(0);
	});

	it("a restart waiting when the service went down is taken up by the next start", async () => {
		process.env.ROOST_RESUME_DELAYS_MS = "2000";
		const first = await startDaemon();
		const { id } = await first.client.request("dispatch", args("sleep 0.2; exit 3"));
		await waitFor(() => (typeof readState(id)?.resumeAt === "number" ? true : undefined));
		await first.client.request("shutdown", { keepWorkers: true });
		await waitFor(() => exited(first.proc));
		const second = await startDaemon();
		await waitFor(
			async () => (readState(id)?.crashRestarts === 1 && (await find(second.client, id))?.pid ? true : undefined),
			8000,
		);
		expect(readState(id)?.resumeAt).toBeUndefined();
		await second.client.request("stop", { id });
	});

	it("a reply while a restart waits starts it at once, with the reply instead", async () => {
		process.env.ROOST_RESUME_DELAYS_MS = "5000";
		const { client } = await startDaemon();
		const { id } = await client.request("dispatch", args("sleep 0.2; exit 3"));
		await waitFor(() => (typeof readState(id)?.resumeAt === "number" ? true : undefined));
		await client.request("reply", { id, text: "try another way" });
		await waitFor(async () => ((await find(client, id))?.pid ? true : undefined), 4000);
		expect(readState(id)?.resumeAt).toBeUndefined();
		expect(readState(id)?.crashRestarts ?? 0).toBe(0);
		await client.request("stop", { id });
	});

	it("a worker killed by a signal is a crash, not a clean end (node-pty reports it as code 0)", async () => {
		process.env.ROOST_RESUME_DELAYS_MS = "5000";
		const { client } = await startDaemon();
		const { id } = await client.request("dispatch", args("sleep 0.2; kill -9 $$"));
		const r = await waitFor(async () => {
			const x = await find(client, id);
			return x?.endedAt && typeof readState(id)?.resumeAt === "number" ? x : undefined;
		});
		// a crash: restarted after a pause (DM-5)
		expect(r.state).toBe("working");
		expect(r.error).toMatch(/^worker killed by SIGKILL; continuing in 5 s/);
		await client.request("stop", { id });
		const sh = await client.request("dispatch", { ...args("sleep 0.2; kill -9 $$"), kind: "shell", sessionFile: "" });
		const r2 = await waitFor(async () => {
			const x = await find(client, sh.id);
			return x?.endedAt ? x : undefined;
		});
		expect(r2).toMatchObject({ state: "failed", error: "killed by SIGKILL" });
	});

	it("a start by other means while a restart waits carries the run on, keeping the count", async () => {
		process.env.ROOST_RESUME_DELAYS_MS = "5000";
		const { client } = await startDaemon();
		const { id } = await client.request("dispatch", args("sleep 0.2; exit 3"));
		writeFileSync(readJob(id)!.sessionFile, "{}\n");
		await waitFor(() => (typeof readState(id)?.resumeAt === "number" ? true : undefined));
		// what attach (ensureLive) and Enter twice do: a respawn with no prompt
		await client.request("respawn", { id });
		expect((readState(id)?.command as string[]).at(-1)).toBe("Continue where you left off.");
		expect(readState(id)?.resumeAt).toBeUndefined();
		expect(readState(id)?.crashRestarts ?? 0).toBe(0);
		await client.request("stop", { id });
	});

	it("a start that fails while a restart waits leaves the restart to run, and it fails with why", async () => {
		process.env.ROOST_RESUME_DELAYS_MS = "1500";
		const { client } = await startDaemon();
		const dir = mkdtempSync(join(tmpdir(), "xroost-gone-"));
		const { id } = await client.request("dispatch", { ...args("sleep 0.2; exit 3"), cwd: dir });
		await waitFor(() => (typeof readState(id)?.resumeAt === "number" ? true : undefined));
		rmSync(dir, { recursive: true, force: true });
		await expect(client.request("respawn", { id })).rejects.toMatchObject({ code: "bad_request" });
		expect(typeof readState(id)?.resumeAt).toBe("number");
		const r = await waitFor(async () => {
			const x = await find(client, id);
			return x?.state === "failed" ? x : undefined;
		}, 6000);
		expect(r.error).toMatch(/could not restart it: cwd is gone/);
		expect(r.endedAt).toBeTypeOf("number");
		expect(readState(id)?.resumeAt).toBeUndefined();
	});

	it("a /stop reply while a restart waits stops it", async () => {
		process.env.ROOST_RESUME_DELAYS_MS = "3000";
		const { client } = await startDaemon();
		const { id } = await client.request("dispatch", args("sleep 0.2; exit 3"));
		await waitFor(() => (typeof readState(id)?.resumeAt === "number" ? true : undefined));
		expect(await client.request("reply", { id, text: "/stop" })).toMatchObject({ stopped: true });
		expect((await find(client, id))?.state).toBe("stopped");
		await new Promise((r) => setTimeout(r, 3300));
		expect((await find(client, id))?.pid).toBeNull();
	});
});
