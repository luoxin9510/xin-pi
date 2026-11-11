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

vi.mock("../src/lib/version.ts", () => ({ ROOST_VERSION: "0.0.1-new" }));

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
		const warning =
			"this xpi is 0.0.1-new; restart it with: xpi roost daemon stop --keep-workers, then xpi roost respawn --all";
		expect(ls.err).toContain(warning);
		expect(ls.err.split(warning)).toHaveLength(2);
		const status = await roost("daemon", "status");
		expect(status.err).toContain(warning);
		expect(status.out).not.toContain("version     0.0.1-new");
	}, 30_000);
});
