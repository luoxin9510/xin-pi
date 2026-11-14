/**
 * `builtin:roost`: the session side of background sessions (xpi-roost).
 *
 * - Every xpi session: the session write lock (DM-8), taken at `session_start` and released at `session_shutdown`, so
 *   the daemon never starts a session file another process has open. Files only (`xpi-roost/session`): an ordinary
 *   start loads nothing that connects to the daemon.
 * - `xpi --bg "<task>"` (`--bg-name`): hands the task to the daemon as a new session and exits (`background.ts`,
 *   loaded only then).
 * - A session the daemon started (the host gave it a job's identity): the worker role (`worker.ts`, loaded only then).
 * - Every other session: the foreground role (`foreground.ts`): `/bg`, `/background`, `/bg-fork` and the left arrow
 *   on an empty prompt.
 * - Both: `/agents`, the hub (`open-view.ts`, loaded when it opens).
 *
 * Nothing in a subagent child. xpi-roost's client and the hub load only when used (`hub.lazy.ts`).
 */

import { acquireWriterLock, isRoostSession, isScratchSession, releaseWriterLock } from "xpi-roost/session";
import { parseArgs } from "../../cli/args.ts";
import { getAgentDir, getRoostEntries } from "../../config.ts";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { registerForeground } from "./foreground.ts";
import { loadOpenView } from "./hub.lazy.ts";
import { NO_PTY_MESSAGE, ptyInstalled, roostUnavailable } from "./messages.ts";
import { reloadNoticeFor } from "./stale.ts";
import { hubContext, setHubApi } from "./view-state.ts";

/**
 * What else on the command line `--bg` cannot go with. This process only hands the task over, but xpi would still send
 * any other message (positional, `@file`, `-p`, piped stdin) to the model before it exits, so those are refused, as is
 * `--no-session`: the daemon's session needs a session file.
 */
export function bgArgsProblem(argv: string[], terminal: boolean): string | undefined {
	const parsed = parseArgs(argv);
	if (parsed.print || parsed.mode !== undefined)
		return "--bg needs interactive mode: it cannot be combined with -p or --mode";
	if (!terminal) return "--bg needs a terminal: its standard input and output cannot be redirected";
	if (parsed.messages.length > 0 || parsed.fileArgs.length > 0)
		return '--bg takes the whole task as its value: quote it as one argument, for example xpi --bg "fix the tests in src/"; other messages and @files are not allowed with it';
	if (parsed.noSession) return "--bg cannot be combined with --no-session: a background session needs a session file";
	return undefined;
}

/** Why `--bg` cannot start a session here, or undefined. Checked before the session starts. */
export function bgProblem(
	task: string,
	o: {
		platform?: NodeJS.Platform;
		entries?: ReturnType<typeof getRoostEntries> | null;
		ptyFound?: () => boolean;
		/** xpi's arguments (default: this process's). */
		argv?: string[];
		/** Whether standard input and output are a terminal (default: this process's). */
		terminal?: boolean;
	} = {},
): string | undefined {
	if (task.trim() === "") return '--bg needs a task, for example: xpi --bg "run the tests"';
	const args = bgArgsProblem(
		o.argv ?? process.argv.slice(2),
		o.terminal ?? (process.stdin.isTTY === true && process.stdout.isTTY === true),
	);
	if (args) return args;
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
	// spec 03: a reload does not load xpi's own code; say so when it changed (any session, roost or not)
	pi.on("session_start", (event, ctx) => {
		if (event.reason !== "reload" || !ctx.hasUI) return;
		const notice = reloadNoticeFor(ctx);
		if (notice) ctx.ui.notify(notice, "warning");
	});
	// the hub reads this runtime's commands and event bus (a /bg switch makes an earlier runtime's API stale)
	setHubApi(pi);

	// T17: the hub, in any session (a session the daemon runs reaches the daemon that runs it)
	pi.registerCommand("agents", {
		description: "Background sessions: start, peek, reply, attach (the hub)",
		handler: async (_args, ctx) => {
			const problem = roostUnavailable({ platform: process.platform, entries: getRoostEntries() });
			if (problem) return ctx.ui.notify(problem, "error");
			const { openAgentView } = await loadOpenView();
			await openAgentView(ctx, hubContext());
		},
	});

	// A session the daemon runs: report, take replies, detach instead of ending.
	if (isRoostSession()) {
		const { registerWorker } = await import("./worker.ts");
		registerWorker(pi);
	} else registerForeground(pi);
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
		// /bg passes through a hand-off session that is never written: nothing to lock
		if (isScratchSession(file, getAgentDir())) return;
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
