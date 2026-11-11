// What every xpi session loads of xpi-roost (`xpi-roost/session`): the session write lock (DM-8)
// and whether this process is a session the daemon runs. Files and the environment only: no
// daemon client, nothing that connects. A session the daemon runs loads the rest (`xpi-roost`).

import { readJobEnv } from "./lib/identity.ts";

export { acquireWriterLock, readWriterLock, releaseWriterLock } from "./lib/locks.ts";

/** Whether this process is a session the daemon started (the host gave it a job's identity). */
export function isRoostSession(env: NodeJS.ProcessEnv = process.env): boolean {
	return readJobEnv(env, "id") !== undefined && readJobEnv(env, "socket") !== undefined;
}
