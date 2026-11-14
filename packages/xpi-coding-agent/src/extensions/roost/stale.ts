/**
 * Spec 03: `/reload` reads extensions, skills and settings again, but not xpi's own code or its built-in extensions.
 * When xpi was rebuilt and installed again since this process started, a reload is not enough; this says so.
 * Files only, as the rest of what every session loads (`xpi-roost/session`).
 */

import { buildOnDisk, isRoostSession, isStale, ROOST_BUILD, readJobEnv } from "xpi-roost/session";
import type { ExtensionContext } from "../../core/extensions/types.ts";
import { formatResumeCommand, type ResumableSession } from "../../utils/resume-command.ts";

const WHAT = "xpi's own code changed since this session started, and /reload does not load it";

/**
 * The notice a `/reload` shows in a process that runs an older build than the installed one, or undefined when it
 * does not (the build ids are unknown, as from sources, or equal). `roostId` is the job id inside a session the daemon
 * runs; `resume` is the command that opens a foreground session again.
 */
export function reloadNotice(o: {
	running: string | undefined;
	onDisk: string | undefined;
	roostId?: string;
	resume?: string;
}): string | undefined {
	if (!isStale(o.running, o.onDisk)) return undefined;
	if (o.roostId) return `${WHAT}. Restart this session to run the installed build: /restart`;
	return o.resume
		? `${WHAT}. Quit and start it again: ${o.resume}`
		: `${WHAT}. Quit and start xpi again to run the installed build.`;
}

/**
 * The runner hands extensions the session's own SessionManager, typed read-only. A host that hands over less (a
 * read-only stand-in) gets the notice without the command instead of a throw in the reload.
 */
function resumeCommandOf(ctx: ExtensionContext): string | undefined {
	const sm = ctx.sessionManager as unknown as Partial<ResumableSession>;
	if (typeof sm.isPersisted !== "function" || typeof sm.usesDefaultSessionDir !== "function") return undefined;
	return formatResumeCommand(sm as ResumableSession);
}

/**
 * What `/restart` says in a session the daemon does not run: it cannot restart itself (nothing outside it could start
 * it again), so it is quit and started again by hand.
 */
export function restartByHand(ctx: ExtensionContext): string {
	const resume = resumeCommandOf(ctx);
	const how = resume ? `quit it and start it again: ${resume}` : "quit it and start xpi again";
	return `/restart works in background sessions. This session runs in the foreground: ${how}`;
}

/** The notice for this process now. */
export function reloadNoticeFor(ctx: ExtensionContext): string | undefined {
	const onDisk = buildOnDisk();
	if (!isStale(ROOST_BUILD, onDisk)) return undefined;
	// not a bare ROOST_JOB_ID: an xpi started from the agent's shell inherits it and is no session of the daemon's
	const roostId = isRoostSession() ? readJobEnv(process.env, "id") : undefined;
	return reloadNotice({
		running: ROOST_BUILD,
		onDisk,
		roostId,
		resume: roostId ? undefined : resumeCommandOf(ctx),
	});
}
