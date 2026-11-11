// M63: what each kind of caller gets from each op, pinned. The daemon's answer to every op
// for a Person, a Session (a job's worker) and an Unregistered agent, with arguments that do
// nothing harmful once allowed: "ok", or the error's code and message. A change to who may
// do what shows here.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DaemonClient } from "../src/lib/client.ts";
import { TEST_DIR_PREFIX } from "../src/lib/orphans.ts";
import { isAlive } from "../src/lib/proc.ts";
import { listJobIds, readState } from "../src/lib/store.ts";

const DAEMON = resolve("src/daemon/main.ts");
const HOST = resolve("src/host/main.ts");
const ENV_NAMES = ["ROOST_HOME", "ROOST_RUNTIME_DIR", "ROOST_HOST_ENTRY", "ROOST_AGENT_DIR"];

let home: string;
let rt: string;
let work: string;
let daemon: ChildProcess | undefined;
const clients: DaemonClient[] = [];
const saved: Record<string, string | undefined> = {};

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

async function connect(): Promise<DaemonClient> {
	const c = await DaemonClient.connect();
	clients.push(c);
	return c;
}

const report = () => ({
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
});

let n = 0;
const sleeper = (name: string) => {
	const script = join(work, `fake-xpi-${n}.sh`);
	writeFileSync(script, "exec sleep 60\n");
	const sessionFile = join(work, `c${n++}.jsonl`);
	return {
		cwd: work,
		sessionFile,
		command: ["/bin/sh", script, "--session", sessionFile],
		env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
		name,
		origin: "dispatch" as const,
	};
};

type Who = "person" | "job" | "unregistered";
const WHO: Who[] = ["person", "job", "unregistered"];

/**
 * The ops, each with arguments that are refused or harmless once allowed, and two of
 * pi-roost's ops that are not ported (an unknown op to everyone). `shutdown` is last. The
 * Person asks each on a connection of its own: one that said hello is an agent's.
 */
const OPS: [string, Record<string, unknown>][] = [
	["ack", { id: "nope", token: "nope", seq: 1 }],
	["ping", {}],
	["list", {}],
	["resolve", { query: "nope" }],
	["status", {}],
	["dispatch", {}],
	["subscribe", {}],
	["stop", { id: "nope" }],
	["rm", { id: "nope" }],
	["respawn", { id: "nope" }],
	["pin", { id: "nope" }],
	["rename", { id: "nope", name: "x" }],
	["reorder", { ids: [] }],
	["reply", { id: "nope", text: "x" }],
	["events", { limit: 1 }],
	["peers", {}],
	["task", { action: "list" }],
	// last: an agent's word makes a connection an agent's
	["hello", { protocol: 1, id: "nope", token: "nope" }],
	["report", { id: "nope", token: "nope", report: report() }],
];

describe("M63: who may do what", () => {
	const by: Record<Who, DaemonClient> = {} as Record<Who, DaemonClient>;
	const ids: string[] = [];

	beforeAll(async () => {
		home = mkdtempSync(join(tmpdir(), `${TEST_DIR_PREFIX}m-`));
		rt = mkdtempSync("/tmp/xrtm-");
		work = mkdtempSync(join(tmpdir(), `${TEST_DIR_PREFIX}mw-`));
		for (const k of ENV_NAMES) saved[k] = process.env[k];
		Object.assign(process.env, {
			ROOST_HOME: home,
			ROOST_RUNTIME_DIR: rt,
			ROOST_HOST_ENTRY: HOST,
			ROOST_AGENT_DIR: home,
		});
		daemon = spawn(process.execPath, [DAEMON], {
			stdio: "ignore",
			env: { ...process.env, ROOST_PARENT_PID: String(process.pid) },
		});
		by.person = await waitFor(async () => {
			try {
				const c = await connect();
				await c.request("ping", {});
				return c;
			} catch {
				return undefined;
			}
		});
		// a session: a job the Person dispatched, its worker reporting on a connection of its own
		const job = await by.person.request("dispatch", sleeper("job"));
		ids.push(job.id);
		await waitFor(async () => (await by.person.request("list", {})).jobs.find((j) => j.id === job.id)?.pid);
		by.job = await connect();
		await by.job.request("report", { id: job.id, token: readState(job.id)?.jobToken as string, report: report() });
		// an Unregistered agent: said hello (refused: no such job), so an agent's connection
		by.unregistered = await connect();
		await by.unregistered.request("hello", { id: "nope", token: "nope" } as never).catch(() => {});
	}, 30_000);

	afterAll(() => {
		for (const c of clients) c.close();
		for (const id of listJobIds()) {
			const pid = readState(id)?.hostPid;
			if (pid && isAlive(pid)) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {}
			}
		}
		if (daemon && daemon.exitCode === null) daemon.kill("SIGKILL");
		rmSync(home, { recursive: true, force: true });
		rmSync(rt, { recursive: true, force: true });
		rmSync(work, { recursive: true, force: true });
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	});

	/** The answer, with what differs from run to run (ids, paths) named. */
	async function answer(c: DaemonClient, op: string, args: Record<string, unknown>): Promise<string> {
		try {
			await c.request(op as never, args as never);
			return "ok";
		} catch (err) {
			const e = err as { code?: string; message?: string };
			let m = `${e.code ?? "?"}: ${e.message ?? ""}`;
			for (const [i, id] of ids.entries()) m = m.split(id).join(`<id${i}>`);
			return m.split(work).join("<work>");
		}
	}

	it("each op, for each kind of caller", async () => {
		const table: Record<string, Record<Who, string>> = {};
		for (const [op, args] of OPS) {
			table[op] = {} as Record<Who, string>;
			for (const w of WHO) table[op][w] = await answer(w === "person" ? await connect() : by[w], op, args);
		}
		// shutdown last, the Person last of all (it stops the daemon)
		table.shutdown = {} as Record<Who, string>;
		for (const w of WHO.filter((x) => x !== "person")) table.shutdown[w] = await answer(by[w], "shutdown", {});
		table.shutdown.person = "(not run: it stops the daemon)";
		expect(table).toMatchSnapshot();
	}, 60_000);
});
