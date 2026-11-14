// What every xpi session loads of xpi-roost (`xpi-roost/session`): the session write lock (DM-8)
// and whether this process is a session the daemon runs. Files and the environment only: no
// daemon client, nothing that connects. A session the daemon runs loads the rest (`xpi-roost`).

import { JOB_ENV_NAMES, readJobEnv } from "./lib/identity.ts";

export { readJobEnv };

export { acquireWriterLock, readWriterLock, releaseWriterLock } from "./lib/locks.ts";
// the hand-off sessions `/bg` passes through: never locked, never handed over
export { isScratchSession, scratchDir } from "./lib/paths.ts";
// the build this process runs and the one installed now (spec 03): files only, as the rest of this entry
export { buildOnDisk, isStale, ROOST_BUILD } from "./lib/version.ts";

const SEEN = Symbol.for("xpi-roost.job-session");

/**
 * Whether this process is a session the daemon started: the host gave it a job's identity, token included. The worker
 * takes the token out of the environment, so a process it starts (`xpi -p` in bash, a check script) inherits the id
 * and the socket but not the token, and is not one. This process keeps its answer for its job id, so a `/reload`,
 * which runs the extension again after the token is gone, still is.
 */
export function isRoostSession(env: NodeJS.ProcessEnv = process.env): boolean {
	const id = readJobEnv(env, "id");
	if (id === undefined || readJobEnv(env, "socket") === undefined) return false;
	const g = globalThis as { [SEEN]?: string };
	if (env === process.env && g[SEEN] === id) return true;
	if (readJobEnv(env, "token") === undefined) return false;
	if (env === process.env) g[SEEN] = id;
	return true;
}

/**
 * Spec 03: an xpi started from a session's shell (a foreground xpi in bash) inherits the session's id and socket, but
 * is not that session. Left in its environment, they would reach what it starts in turn: `xpi roost restart` run by
 * its agent would name the outer session as the caller and send it the restart prompt, and its `/agents` would take
 * the outer session for itself. Called once by xpi's roost extension in every process that is not a session.
 */
export function forgetInheritedJob(env: NodeJS.ProcessEnv = process.env): void {
	if (readJobEnv(env, "id") === undefined || isRoostSession(env)) return;
	for (const k of Object.keys(env)) if (JOB_ENV_NAMES.includes(k) || k.startsWith("ROOST_JOB_")) delete env[k];
}
