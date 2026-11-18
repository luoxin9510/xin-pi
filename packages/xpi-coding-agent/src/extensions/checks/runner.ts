// Runs one check command through the shell and reports how it ended. Plain module: no session, so it can be tested
// with a fake command. The process is started in its own process group so a kill takes the shell's children with it
// (`npx tsc` is a shell, npx and node).

import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { killProcessTree, trackDetachedChildPid, untrackDetachedChildPid } from "../../utils/shell.ts";

/** Most output kept per command. Past it the rest is dropped (the process keeps running to its end or timeout). */
export const MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * How long output may still arrive after the process exited, or after we killed it. A grandchild that left the process
 * group (setsid, a daemon such as eslint_d) can hold the pipes open for good, so waiting for them to close would hang.
 */
export const EXIT_GRACE_MS = 1500;

export interface RunOptions {
	cwd: string;
	timeoutMs: number;
	/** Aborting kills the process group; the result has `aborted: true`. */
	signal?: AbortSignal;
	/**
	 * Called with stdout and stderr text as it arrives, past the cap on kept output too (a live view wants the latest
	 * lines). A character split between two chunks comes whole in the second. An error it throws is ignored.
	 */
	onOutput?: (text: string) => void;
}

export interface RunResult {
	command: string;
	/** stdout and stderr interleaved as they arrived, as text, capped at {@link MAX_OUTPUT_BYTES} in all. */
	output: string;
	/** Exit code; null when the process was killed or could not start. */
	code: number | null;
	timedOut: boolean;
	aborted: boolean;
}

/** The runner as the extension sees it; tests pass a fake. */
export type CheckRunner = (command: string, options: RunOptions) => Promise<RunResult>;

export const runCheckCommand: CheckRunner = (command, { cwd, timeoutMs, signal, onOutput }) =>
	new Promise<RunResult>((resolve) => {
		const result: RunResult = { command, output: "", code: null, timedOut: false, aborted: false };
		if (signal?.aborted) {
			resolve({ ...result, aborted: true });
			return;
		}
		const chunks: Buffer[] = [];
		let size = 0;
		// One decoder per stream, so a character split between chunks of one stream is joined.
		const decoders = { out: new StringDecoder("utf8"), err: new StringDecoder("utf8") };
		const tell = (text: string) => {
			if (!onOutput || text === "") return;
			try {
				onOutput(text);
			} catch {
				// the live view is not the command
			}
		};
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
		const pid = child.pid;
		// So print and interactive mode kill the group on SIGTERM and SIGHUP too.
		if (pid !== undefined) trackDetachedChildPid(pid);
		child.stdout.on("data", (chunk: Buffer) => {
			collect(chunk);
			tell(decoders.out.write(chunk));
		});
		child.stderr.on("data", (chunk: Buffer) => {
			collect(chunk);
			tell(decoders.err.write(chunk));
		});

		let exited = false;
		let settled = false;
		let graceTimer: ReturnType<typeof setTimeout> | undefined;
		const kill = () => {
			if (pid !== undefined) killProcessTree(pid);
		};
		const finish = (code: number | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearTimeout(graceTimer);
			signal?.removeEventListener("abort", onAbort);
			if (pid !== undefined) untrackDetachedChildPid(pid);
			child.stdout.destroy();
			child.stderr.destroy();
			// Bytes of a character the output ended in the middle of.
			tell(decoders.out.end());
			tell(decoders.err.end());
			resolve({ ...result, output: Buffer.concat(chunks).toString("utf8"), code });
		};
		// After a kill the result ends once the grace is over, whether or not the pipes closed.
		const giveUp = () => {
			graceTimer ??= setTimeout(() => finish(null), EXIT_GRACE_MS);
		};
		const timer = setTimeout(() => {
			// A process that already exited (its background children keep the pipes) did not time out.
			if (exited) return;
			result.timedOut = true;
			kill();
			giveUp();
		}, timeoutMs);
		const onAbort = () => {
			result.aborted = true;
			kill();
			giveUp();
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		child.on("exit", (code) => {
			exited = true;
			clearTimeout(timer);
			// Output normally ends at once ("close"); a background child that holds the pipes gets the grace, then its
			// group is killed so nothing of the check outlives it.
			clearTimeout(graceTimer);
			graceTimer = setTimeout(() => {
				kill();
				finish(code);
			}, EXIT_GRACE_MS);
		});
		// "close" fires after the pipes end, so all output is in.
		child.on("close", (code) => finish(code));
		child.on("error", (error) => {
			chunks.push(Buffer.from(`${error.message}\n`));
			finish(null);
		});
	});
