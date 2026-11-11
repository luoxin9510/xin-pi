/**
 * `builtin:roost`: the session side of background sessions (xpi-roost).
 *
 * - Every xpi session: the session write lock (DM-8), taken at `session_start` and released at `session_shutdown`, so
 *   the daemon never starts a session file another process has open. Files only (`xpi-roost/session`): an ordinary
 *   start loads nothing that connects to the daemon.
 * - `xpi --bg "<task>"` (`--bg-name`): hands the task to the daemon as a new session and exits (`background.ts`,
 *   loaded only then).
 * - A session the daemon started (the host gave it a job's identity): the worker role (`worker.ts`, loaded only then).
 *
 * Nothing in a subagent child. The hub, `/agents`, `/bg` and `/bg-fork` are not here yet.
 */

import { acquireWriterLock, isRoostSession, releaseWriterLock } from "xpi-roost/session";
import { getRoostEntries } from "../../config.ts";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { NO_PTY_MESSAGE, ptyInstalled, roostUnavailable } from "./messages.ts";

/** Why `--bg` cannot start a session here, or undefined. Checked before the session starts. */
export function bgProblem(
	task: string,
	o: {
		platform?: NodeJS.Platform;
		entries?: ReturnType<typeof getRoostEntries> | null;
		ptyFound?: () => boolean;
	} = {},
): string | undefined {
	if (task.trim() === "") return '--bg needs a task, for example: xpi --bg "run the tests"';
	const entries = o.entries === undefined ? getRoostEntries() : (o.entries ?? undefined);
	const problem = roostUnavailable({ platform: o.platform ?? process.platform, entries });
	if (problem) return problem;
	return (o.ptyFound ?? ptyInstalled)() ? undefined : NO_PTY_MESSAGE;
}

export default async function roost(pi: ExtensionAPI): Promise<void> {
	// A subagent child is its parent's: it is not a session of its own to lock, hand over or report.
	if (process.env.XPI_SUBAGENT_DEPTH) return;

	pi.registerFlag("bg", {
		type: "string",
		description: 'Start <task> as a background session (see xpi roost) and exit, e.g. xpi --bg "run the tests"',
		validate: (value) => bgProblem(value),
	});
	pi.registerFlag("bg-name", { type: "string", description: "Name of the session --bg starts" });

	registerWriteLock(pi);

	// A session the daemon runs: report, take replies, detach instead of ending.
	if (isRoostSession()) {
		const { registerWorker } = await import("./worker.ts");
		registerWorker(pi);
	}
}

/**
 * DM-8: the session file this process has open is locked (`<file>.lock`, the pid and its start time) while it is open;
 * the daemon refuses to start or restart a session on a locked file. Not on Windows (roost does not run there).
 */
export function registerWriteLock(pi: ExtensionAPI, platform: NodeJS.Platform = process.platform): void {
	let locked: string | undefined;
	const unlock = () => {
		if (locked) {
			try {
				releaseWriterLock(locked);
			} catch {
				// the directory went away with the session: nothing to release
			}
		}
		locked = undefined;
	};
	const lock = (ctx: ExtensionContext) => {
		unlock();
		if (platform === "win32") return;
		const file = ctx.sessionManager.getSessionFile();
		if (!file) return; // --no-session
		let result: ReturnType<typeof acquireWriterLock>;
		try {
			result = acquireWriterLock(file);
		} catch {
			return; // an unwritable session directory: the session itself will say so
		}
		if (result.ok) locked = file;
		else if (ctx.hasUI && result.holder.pid > 0)
			ctx.ui.notify(`this session is also open in process ${result.holder.pid}`, "warning");
	};

	pi.on("session_start", async (event, ctx) => {
		const task = pi.getFlag("bg");
		// `xpi --bg`: this process only hands the task over; it never opens the session itself
		if (typeof task === "string" && event.reason === "startup") {
			const { backgroundAndExit } = await import("./background.ts");
			return backgroundAndExit(pi, ctx, task);
		}
		if (typeof pi.getFlag("bg-name") === "string" && event.reason === "startup" && ctx.hasUI)
			ctx.ui.notify("--bg-name names the session --bg starts; without --bg it does nothing", "warning");
		lock(ctx);
	});
	pi.on("session_shutdown", () => unlock());
}
