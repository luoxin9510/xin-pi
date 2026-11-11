import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readJson, writeFileAtomic, writeJsonAtomic } from "../src/lib/atomic.ts";
import { newJobId, newToken } from "../src/lib/ids.ts";
import {
	acquireDaemonLock,
	acquireWriterLock,
	readDaemonLock,
	readWriterLock,
	releaseDaemonLock,
	releaseWriterLock,
} from "../src/lib/locks.ts";
import { TEST_DIR_PREFIX } from "../src/lib/orphans.ts";
import {
	agentDirKey,
	daemonLockPath,
	daemonSocketPath,
	ensureDirs,
	hostSocketPath,
	jobDir,
	jobsDir,
	roostEnvironment,
	roostHome,
	runtimeDir,
	withoutRoostLocation,
} from "../src/lib/paths.ts";
import { isAlive, processStartToken, sameProcess } from "../src/lib/proc.ts";
import {
	createJob,
	type JobRecord,
	type JobState,
	listJobIds,
	readExit,
	readJob,
	readState,
	removeJob,
	updateState,
	writeExit,
} from "../src/lib/store.ts";
import { ROOST_VERSION } from "../src/lib/version.ts";

let home: string;
let rt: string;
const children: ChildProcess[] = [];

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), `${TEST_DIR_PREFIX}home-`));
	rt = mkdtempSync("/tmp/xrt-");
	process.env.ROOST_HOME = home;
	process.env.ROOST_RUNTIME_DIR = rt;
});

const savedEnv = { ...process.env };
const madeRuntime: string[] = [];

afterEach(() => {
	for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
	Object.assign(process.env, savedEnv);
	for (const d of madeRuntime.splice(0)) {
		try {
			if (lstatSync(d).isSymbolicLink()) unlinkSync(d);
			else rmSync(d, { recursive: true, force: true });
		} catch {}
	}
	for (const c of children.splice(0)) c.kill("SIGKILL");
	rmSync(home, { recursive: true, force: true });
	rmSync(rt, { recursive: true, force: true });
});

function deadPid(): number {
	const r = spawnSync("true");
	return r.pid;
}

function sleeper(): ChildProcess {
	const c = spawn("sleep", ["5"], { stdio: "ignore" });
	children.push(c);
	return c;
}

describe("paths", () => {
	it("honours env overrides and builds paths", () => {
		expect(roostHome()).toBe(home);
		expect(runtimeDir()).toBe(rt);
		expect(jobDir("abc")).toBe(join(home, "jobs", "abc"));
		expect(hostSocketPath("abc")).toBe(join(rt, "host-abc.sock"));
	});

	it("ensureDirs creates 0700 dirs", () => {
		rmSync(rt, { recursive: true });
		ensureDirs();
		expect(statSync(jobsDir()).mode & 0o777).toBe(0o700);
		expect(statSync(rt).mode & 0o777).toBe(0o700);
	});

	it("ensureDirs rejects a symlinked runtime dir", () => {
		const target = mkdtempSync("/tmp/xrt-");
		const link = `${target}-link`;
		rmSync(rt, { recursive: true });
		spawnSync("ln", ["-s", target, link]);
		process.env.ROOST_RUNTIME_DIR = link;
		try {
			expect(() => ensureDirs()).toThrow();
		} finally {
			// the link itself (rmSync on a link to a directory fails on Linux)
			try {
				unlinkSync(link);
			} catch {}
			rmSync(target, { recursive: true, force: true });
		}
	});
});

describe("paths by agent directory (decision 14)", () => {
	const uid = process.getuid?.() ?? 0;
	function bare(): string {
		delete process.env.ROOST_HOME;
		delete process.env.ROOST_RUNTIME_DIR;
		delete process.env.ROOST_AGENT_DIR;
		delete process.env.XDG_RUNTIME_DIR;
		const agent = mkdtempSync(join(tmpdir(), `${TEST_DIR_PREFIX}a-`));
		madeRuntime.push(agent);
		return agent;
	}

	it("state in <agent dir>/xpi-roost, sockets in a runtime directory keyed by the agent directory", () => {
		const a = bare();
		const b = bare();
		expect(roostHome(a)).toBe(join(a, "xpi-roost"));
		expect(agentDirKey(a)).toMatch(/^[0-9a-f]{12}$/);
		expect(agentDirKey(a)).not.toBe(agentDirKey(b));
		expect(runtimeDir(a)).toBe(`/tmp/xpi-roost-${uid}/${agentDirKey(a)}`);
		expect(daemonSocketPath(a)).not.toBe(daemonSocketPath(b));
		// the agent directory from the environment, as the daemon and a host have it
		process.env.ROOST_AGENT_DIR = a;
		expect(roostHome()).toBe(join(a, "xpi-roost"));
		expect(runtimeDir()).toBe(runtimeDir(a));
		delete process.env.ROOST_AGENT_DIR;
		expect(() => roostHome()).toThrow(/no agent directory/);
		// the overrides win
		process.env.ROOST_HOME = home;
		process.env.ROOST_RUNTIME_DIR = rt;
		expect(roostHome(a)).toBe(home);
		expect(runtimeDir(a)).toBe(rt);
	});

	it("XDG_RUNTIME_DIR when its socket paths fit, /tmp otherwise", () => {
		const a = bare();
		process.env.XDG_RUNTIME_DIR = rt;
		expect(runtimeDir(a)).toBe(join(rt, `xpi-roost-${agentDirKey(a)}`));
		process.env.XDG_RUNTIME_DIR = join(rt, "x".repeat(90));
		expect(runtimeDir(a)).toBe(`/tmp/xpi-roost-${uid}/${agentDirKey(a)}`);
	});

	it("ensureDirs makes both /tmp levels 0700 and refuses a link at the keyed level", () => {
		const a = bare();
		const dir = runtimeDir(a);
		madeRuntime.push(dir);
		ensureDirs(a);
		expect(statSync(dir).mode & 0o777).toBe(0o700);
		expect(lstatSync(`/tmp/xpi-roost-${uid}`).mode & 0o777).toBe(0o700);
		expect(statSync(join(a, "xpi-roost", "jobs")).isDirectory()).toBe(true);
		rmSync(dir, { recursive: true });
		const target = mkdtempSync("/tmp/xrt-");
		madeRuntime.push(target);
		symlinkSync(target, dir);
		expect(() => ensureDirs(a)).toThrow(/symlink/);
	});

	it("a roost's location travels to its session, never another's", () => {
		const loc = {
			ROOST_AGENT_DIR: "/a",
			ROOST_HOME: "/h",
			ROOST_RUNTIME_DIR: "/r",
			ROOST_HOST_ENTRY: "/e",
			OTHER: "x",
		};
		expect(roostEnvironment(loc)).toEqual({
			ROOST_AGENT_DIR: "/a",
			ROOST_HOME: "/h",
			ROOST_RUNTIME_DIR: "/r",
			ROOST_HOST_ENTRY: "/e",
			XPI_CODING_AGENT_DIR: "/a",
		});
		expect(withoutRoostLocation(loc)).toEqual({ OTHER: "x" });
	});
});

describe("atomic", () => {
	it("writes and reads json, leaving no temp files", () => {
		const f = join(home, "a.json");
		writeJsonAtomic(f, { x: 1 });
		expect(readJson(f)).toEqual({ x: 1 });
		writeFileAtomic(f, new Uint8Array([123, 125]));
		expect(readJson(f)).toEqual({});
		expect(statSync(f).mode & 0o777).toBe(0o600);
		expect(require_ls(home)).toEqual(["a.json"]);
	});

	it("readJson returns undefined for missing and garbage", () => {
		expect(readJson(join(home, "nope.json"))).toBeUndefined();
		const f = join(home, "bad.json");
		writeFileSync(f, "{not json");
		expect(readJson(f)).toBeUndefined();
	});
});

function require_ls(dir: string): string[] {
	return spawnSync("ls", ["-A", dir], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
}

describe("proc / ids / version", () => {
	it("own pid alive and same process", () => {
		const tok = processStartToken(process.pid);
		expect(tok).toBeTruthy();
		expect(isAlive(process.pid)).toBe(true);
		expect(sameProcess(process.pid, tok as string)).toBe(true);
		expect(sameProcess(process.pid, "bogus")).toBe(false);
	});

	it("dead pid is not alive", () => {
		const pid = deadPid();
		expect(isAlive(pid)).toBe(false);
		expect(processStartToken(pid)).toBeUndefined();
		expect(sameProcess(pid, "x")).toBe(false);
	});

	it("ids have the right shape", () => {
		expect(newJobId()).toMatch(/^[0-9a-f]{8}$/);
		expect(newToken()).toMatch(/^[0-9a-f]{32}$/);
	});

	it("reads the package version", () => {
		expect(ROOST_VERSION).toMatch(/^\d+\.\d+\.\d+/);
	});
});

describe("writer lock", () => {
	it("acquires (creating the parent dir), re-acquires, releases", () => {
		const f = join(home, "sessions", "s.jsonl");
		expect(acquireWriterLock(f)).toEqual({ ok: true });
		expect(acquireWriterLock(f)).toEqual({ ok: true });
		expect(readWriterLock(f)?.pid).toBe(process.pid);
		releaseWriterLock(f);
		expect(existsSync(`${f}.lock`)).toBe(false);
		expect(readWriterLock(f)).toBeUndefined();
	});

	it("replaces a stale lock and reads it as undefined", () => {
		const f = join(home, "s.jsonl");
		const lock = { pid: deadPid(), token: "old", at: 1 };
		writeFileSync(`${f}.lock`, JSON.stringify(lock));
		expect(readWriterLock(f)).toBeUndefined();
		expect(acquireWriterLock(f)).toEqual({ ok: true });
		expect(readWriterLock(f)?.pid).toBe(process.pid);
	});

	it("refuses when a live other process holds it", () => {
		const f = join(home, "s.jsonl");
		const c = sleeper();
		const lock = { pid: c.pid as number, token: processStartToken(c.pid as number), at: 1 };
		writeFileSync(`${f}.lock`, JSON.stringify(lock));
		const r = acquireWriterLock(f);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.holder.pid).toBe(c.pid);
		expect(readWriterLock(f)?.pid).toBe(c.pid);
		releaseWriterLock(f); // not ours: must stay
		expect(existsSync(`${f}.lock`)).toBe(true);
	});
});

describe("daemon lock", () => {
	it("acquire stores extras; second acquire from same process is refused", () => {
		ensureDirs();
		expect(acquireDaemonLock({ socket: "s" })).toEqual({ ok: true });
		expect(readDaemonLock()?.socket).toBe("s");
		const r = acquireDaemonLock({});
		expect(r.ok).toBe(false);
		releaseDaemonLock();
		expect(existsSync(daemonLockPath())).toBe(false);
	});

	it("replaces a stale lock", () => {
		ensureDirs();
		writeFileSync(daemonLockPath(), JSON.stringify({ pid: deadPid(), token: "old", at: 1 }));
		expect(acquireDaemonLock({})).toEqual({ ok: true });
		expect(readDaemonLock()?.pid).toBe(process.pid);
	});

	it("refuses when a live other process holds it, and does not release it", () => {
		ensureDirs();
		const c = sleeper();
		const pid = c.pid as number;
		writeFileSync(daemonLockPath(), JSON.stringify({ pid, token: processStartToken(pid), at: 1 }));
		const r = acquireDaemonLock({});
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.holder.pid).toBe(pid);
		releaseDaemonLock();
		expect(existsSync(daemonLockPath())).toBe(true);
	});
});

describe("store", () => {
	const record = (id: string): JobRecord => ({
		id,
		name: "n",
		cwd: "/tmp",
		sessionFile: "/tmp/s.jsonl",
		command: ["node", "pi"],
		env: {},
		origin: "bg",
		createdAt: 1,
		roostVersion: ROOST_VERSION,
	});
	const state = (): JobState => ({ state: "working", startedAt: 1, updatedAt: 1 });

	it("create / read / update / exit / list / remove", () => {
		createJob(record("aaaa1111"), { ...state(), extra: "keep" });
		createJob(record("bbbb2222"), state());
		mkdirSync(join(jobsDir(), "junk"));
		expect(statSync(join(jobDir("aaaa1111"), "tmp")).isDirectory()).toBe(true);
		expect(readJob("aaaa1111")?.name).toBe("n");
		expect(listJobIds().sort()).toEqual(["aaaa1111", "bbbb2222"]);

		const next = updateState("aaaa1111", { state: "done", endedAt: 5 });
		expect(next.state).toBe("done");
		expect(next.extra).toBe("keep");
		expect(next.updatedAt).toBeGreaterThan(1);
		expect(readState("aaaa1111")).toEqual(next);

		expect(readExit("aaaa1111")).toBeUndefined();
		writeExit("aaaa1111", { code: 0, signal: null, at: 9 });
		expect(readExit("aaaa1111")).toEqual({ code: 0, signal: null, at: 9 });

		removeJob("aaaa1111");
		expect(listJobIds()).toEqual(["bbbb2222"]);
		expect(readJob("aaaa1111")).toBeUndefined();
	});
});
