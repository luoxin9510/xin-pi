import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EXIT_GRACE_MS, MAX_OUTPUT_BYTES, runCheckCommand } from "../src/extensions/checks/runner.ts";

const dirs: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "xpi-checks-runner-"));
	dirs.push(dir);
	return dir;
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitDead(pid: number): Promise<boolean> {
	for (let i = 0; i < 50; i++) {
		if (!alive(pid)) return true;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return false;
}

// Pids of processes a test started outside the command's group; killed in cleanup.
const strays: number[] = [];

afterEach(() => {
	for (const pid of strays.splice(0)) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// already gone
		}
	}
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("runCheckCommand", () => {
	it("tells onOutput the text as it arrives, in order, and keeps the same output as without it", async () => {
		const cwd = tempDir();
		const command = "echo one; sleep 0.2; echo two >&2; sleep 0.2; printf 'thr\\303\\251e\\n'";
		const told: { text: string; at: number }[] = [];
		const started = Date.now();
		const watched = await runCheckCommand(command, {
			cwd,
			timeoutMs: 10_000,
			onOutput: (text) => told.push({ text, at: Date.now() - started }),
		});
		const plain = await runCheckCommand(command, { cwd, timeoutMs: 10_000 });
		expect(told.map((part) => part.text).join("")).toBe("one\ntwo\nthrée\n");
		// The first line was told before the command ended.
		expect(told[0].at).toBeLessThan(told.at(-1)?.at ?? 0);
		expect(watched.output).toBe(plain.output);
		expect(watched.code).toBe(0);
	});

	it("goes on when onOutput throws", async () => {
		const result = await runCheckCommand("echo hi", {
			cwd: tempDir(),
			timeoutMs: 10_000,
			onOutput: () => {
				throw new Error("view broke");
			},
		});
		expect(result.code).toBe(0);
		expect(result.output).toBe("hi\n");
	});

	it("captures stdout and stderr and the exit code, in the given cwd", async () => {
		const cwd = tempDir();
		writeFileSync(join(cwd, "marker.txt"), "");
		const result = await runCheckCommand("ls marker.txt; echo oops >&2; exit 3", { cwd, timeoutMs: 10_000 });
		expect(result.code).toBe(3);
		expect(result.output).toContain("marker.txt");
		expect(result.output).toContain("oops");
		expect(result.timedOut).toBe(false);
		expect(result.aborted).toBe(false);
	});

	it("kills the whole process group on timeout", async () => {
		const cwd = tempDir();
		// The shell starts a background sleeper that prints its own pid, then waits.
		const result = await runCheckCommand("sleep 30 & echo $!; wait", { cwd, timeoutMs: 300 });
		expect(result.timedOut).toBe(true);
		const pid = Number(result.output.trim().split("\n")[0]);
		expect(pid).toBeGreaterThan(0);
		expect(await waitDead(pid)).toBe(true);
	});

	it("kills the process group when the signal aborts, and not before it starts when already aborted", async () => {
		const cwd = tempDir();
		const controller = new AbortController();
		const running = runCheckCommand("sleep 30 & echo $!; wait", {
			cwd,
			timeoutMs: 30_000,
			signal: controller.signal,
		});
		await new Promise((resolve) => setTimeout(resolve, 300));
		controller.abort();
		const result = await running;
		expect(result.aborted).toBe(true);
		const pid = Number(result.output.trim().split("\n")[0]);
		expect(await waitDead(pid)).toBe(true);

		const already = await runCheckCommand("echo never", { cwd, timeoutMs: 1000, signal: controller.signal });
		expect(already).toMatchObject({ aborted: true, output: "", code: null });
	});

	it("caps the output at 1 MiB", async () => {
		const cwd = tempDir();
		const script = join(cwd, "big.mjs");
		writeFileSync(script, `process.stdout.write("x".repeat(${MAX_OUTPUT_BYTES * 3}));`);
		const result = await runCheckCommand(`"${process.execPath}" big.mjs`, { cwd, timeoutMs: 20_000 });
		expect(result.code).toBe(0);
		expect(Buffer.byteLength(result.output)).toBe(MAX_OUTPUT_BYTES);
	});

	it("finishes on the exit when a child that left the process group holds the pipes (timeout case)", async () => {
		const cwd = tempDir();
		// perl setsid()s into its own session and execs sleep; the shell waits for it, so the command times out.
		const started = Date.now();
		const result = await runCheckCommand('perl -e \'use POSIX; setsid(); exec "sleep", "8"\' & echo $!; wait', {
			cwd,
			timeoutMs: 500,
		});
		const pid = Number(result.output.trim().split("\n")[0]);
		strays.push(pid);
		expect(result.timedOut).toBe(true);
		expect(Date.now() - started).toBeLessThan(500 + EXIT_GRACE_MS + 2000);
		expect(alive(pid)).toBe(true);
	});

	it("finishes shortly after the shell exits though a detached child holds the pipes", async () => {
		const cwd = tempDir();
		const started = Date.now();
		const result = await runCheckCommand('perl -e \'use POSIX; setsid(); exec "sleep", "8"\' & echo $!', {
			cwd,
			timeoutMs: 1000,
		});
		strays.push(Number(result.output.trim().split("\n")[0]));
		expect(result.timedOut).toBe(false);
		expect(result.code).toBe(0);
		expect(Date.now() - started).toBeLessThan(EXIT_GRACE_MS + 2000);
	});

	it("is not a timeout when the shell exits at once and a background child outlives it", async () => {
		const cwd = tempDir();
		const result = await runCheckCommand("sleep 8 & echo $!; echo 'a.ts(1,1): error TS1: bad'", {
			cwd,
			timeoutMs: 400,
		});
		const pid = Number(result.output.trim().split("\n")[0]);
		expect(result.timedOut).toBe(false);
		expect(result.code).toBe(0);
		expect(result.output).toContain("error TS1: bad");
		// The leftover of its own group is killed once the grace is over.
		expect(await waitDead(pid)).toBe(true);
	});
});
