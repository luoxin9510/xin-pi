// Runs one check command through the shell and reports how it ended. Plain module: no session, so it can be tested
// with a fake command. The process is started in its own process group so a kill takes the shell's children with it
// (`npx tsc` is a shell, npx and node).

import { spawn } from "node:child_process";
import { killProcessTree } from "../../utils/shell.ts";

/** Most output kept per command. Past it the rest is dropped (the process keeps running to its end or timeout). */
export const MAX_OUTPUT_BYTES = 1024 * 1024;

export interface RunOptions {
	cwd: string;
	timeoutMs: number;
	/** Aborting kills the process group; the result has `aborted: true`. */
	signal?: AbortSignal;
}

export interface RunResult {
	command: string;
	/** stdout then stderr, as text, capped at {@link MAX_OUTPUT_BYTES} in all. */
	output: string;
	/** Exit code; null when the process was killed or could not start. */
	code: number | null;
	timedOut: boolean;
	aborted: boolean;
}

/** The runner as the extension sees it; tests pass a fake. */
export type CheckRunner = (command: string, options: RunOptions) => Promise<RunResult>;

export const runCheckCommand: CheckRunner = (command, { cwd, timeoutMs, signal }) =>
	new Promise<RunResult>((resolve) => {
		const result: RunResult = { command, output: "", code: null, timedOut: false, aborted: false };
		if (signal?.aborted) {
			resolve({ ...result, aborted: true });
			return;
		}
		const chunks: Buffer[] = [];
		let size = 0;
		const collect = (chunk: Buffer) => {
			const room = MAX_OUTPUT_BYTES - size;
			if (room <= 0) return;
			const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
			chunks.push(kept);
			size += kept.length;
		};

		// detached: the child leads its own group, which killProcessTree signals as a whole.
		const child = spawn(command, {
			cwd,
			shell: true,
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
		});
		child.stdout.on("data", collect);
		child.stderr.on("data", collect);

		const kill = () => {
			if (child.pid !== undefined) killProcessTree(child.pid);
		};
		const timer = setTimeout(() => {
			result.timedOut = true;
			kill();
		}, timeoutMs);
		const onAbort = () => {
			result.aborted = true;
			kill();
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		let settled = false;
		const finish = (code: number | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve({ ...result, output: Buffer.concat(chunks).toString("utf8"), code });
		};
		// "close" fires after the pipes end, so all output is in; a killed shell whose grandchild still holds the pipe
		// is why the kill goes to the group.
		child.on("close", (code) => finish(code));
		child.on("error", (error) => {
			chunks.push(Buffer.from(`${error.message}\n`));
			finish(null);
		});
	});
