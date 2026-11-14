import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_OUTPUT_BYTES, runCheckCommand } from "../src/extensions/checks/runner.ts";

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

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("runCheckCommand", () => {
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
});
