// DM-9: after an upgrade the running daemon still has the old code. The command line is
// another version here (mocked); the daemon it starts is the real one.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runRoostCli } from "../src/cli.ts";
import { DaemonClient } from "../src/lib/client.ts";
import { pidAlive, TEST_DIR_PREFIX } from "../src/lib/orphans.ts";
import { ROOST_LOCATION_ENV, runtimeDir } from "../src/lib/paths.ts";

const disk = vi.hoisted(() => ({ build: undefined as string | undefined }));
vi.mock("../src/lib/version.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/lib/version.ts")>()),
	ROOST_VERSION: "0.0.1-new",
	buildOnDisk: () => disk.build,
}));

const ENV_NAMES = [...ROOST_LOCATION_ENV, "ROOST_PARENT_PID", "XDG_RUNTIME_DIR"];
const saved: Record<string, string | undefined> = {};
let agentDir: string;

beforeEach(() => {
	for (const k of ENV_NAMES) {
		saved[k] = process.env[k];
		delete process.env[k];
	}
	process.env.ROOST_PARENT_PID = String(process.pid);
	agentDir = mkdtempSync(join(tmpdir(), `${TEST_DIR_PREFIX}cliv-`));
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
	rmSync(runtimeDir(agentDir), { recursive: true, force: true });
	rmSync(agentDir, { recursive: true, force: true });
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

async function roost(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
	let out = "";
	let err = "";
	const code = await runRoostCli(argv, {
		start: { agentDir, daemonEntry: resolve("src/daemon/main.ts"), hostEntry: resolve("src/host/main.ts") },
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

describe("a daemon of another version", () => {
	it("each command warns once and says how to restart it; the command still runs", async () => {
		const ls = await roost("ls");
		expect(ls.code).toBe(0);
		expect(ls.out).toBe("no background sessions\n");
		const warning = "this xpi is 0.0.1-new; restart it with: xpi roost restart";
		expect(ls.err).toContain(warning);
		expect(ls.err.split(warning)).toHaveLength(2);
		const status = await roost("daemon", "status");
		expect(status.err).toContain(warning);
		expect(status.out).not.toContain("version     0.0.1-new");
	}, 30_000);
});

describe("a daemon of an older build, at the same version (spec 03)", () => {
	const recipe = "xpi roost restart";

	/** The real daemon runs from sources and has no build id; its answers are made to say one (and this version). */
	function daemonSays(build: string | undefined, jobs?: (rows: unknown[]) => unknown[]) {
		type Request = (op: string, args: unknown) => Promise<unknown>;
		const real = DaemonClient.prototype.request as unknown as Request;
		vi.spyOn(DaemonClient.prototype as unknown as { request: Request }, "request").mockImplementation(async function (
			this: DaemonClient,
			op: string,
			args: unknown,
		) {
			const r = (await real.call(this, op, args)) as Record<string, unknown>;
			if (op === "status") return { ...r, version: "0.0.1-new", ...(build ? { build } : {}) } as never;
			if (op === "list" && jobs) return { jobs: jobs(r.jobs as unknown[]) } as never;
			return r as never;
		} as never);
	}
	afterEach(() => {
		vi.restoreAllMocks();
		disk.build = undefined;
	});

	it("warns, once, naming `xpi roost restart`", async () => {
		disk.build = "bbbbbbbbbbbbbbbb";
		daemonSays("aaaaaaaaaaaaaaaa");
		const ls = await roost("ls");
		const warning = `warning: the background service runs an older build of xpi than the installed one; restart it with: ${recipe}\n`;
		expect(ls.err).toBe(warning);
		const status = await roost("daemon", "status");
		expect(status.out).toContain("build       aaaaaaaaaaaaaaaa  (older than the installed bbbbbbbbbbbbbbbb)");
		expect(status.err).toContain("runs an older build");
	}, 30_000);

	it("does not warn when the ids match, or either is unknown", async () => {
		for (const [daemon, onDisk] of [
			["aaaaaaaaaaaaaaaa", "aaaaaaaaaaaaaaaa"],
			[undefined, "bbbbbbbbbbbbbbbb"],
			["aaaaaaaaaaaaaaaa", undefined],
		] as const) {
			vi.restoreAllMocks();
			disk.build = onDisk;
			daemonSays(daemon);
			const ls = await roost("ls");
			expect(ls.err).toBe("");
		}
		vi.restoreAllMocks();
		daemonSays(undefined);
		const status = await roost("daemon", "status");
		expect(status.out).toContain("build       unknown");
	}, 30_000);

	it("ls says on stderr how many running sessions are stale", async () => {
		disk.build = "bbbbbbbbbbbbbbbb";
		const row = (id: string, pid: number | null, build?: string) => ({
			id,
			cwd: "/tmp",
			kind: "pi",
			startedAt: 1,
			state: "done",
			pid,
			status: null,
			waitingFor: null,
			sessionFile: "/tmp/x.jsonl",
			name: id,
			endedAt: null,
			summary: null,
			question: null,
			choices: [],
			model: null,
			thinking: null,
			context: null,
			usage: null,
			error: null,
			stateSince: 1,
			reaped: false,
			pinned: false,
			order: null,
			orderKey: null,
			task: null,
			queued: 0,
			schedule: null,
			...(build ? { build } : {}),
		});
		daemonSays("bbbbbbbbbbbbbbbb", () => [
			row("a", 1, "aaaaaaaaaaaaaaaa"),
			row("b", 2, "aaaaaaaaaaaaaaaa"),
			row("c", 3, "bbbbbbbbbbbbbbbb"),
			row("d", 4),
			row("e", null, "aaaaaaaaaaaaaaaa"),
		]);
		const ls = await roost("ls");
		expect(ls.err).toBe(`2 sessions run an older build: ${recipe}\n`);
	}, 30_000);
});
