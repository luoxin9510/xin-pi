/**
 * `/restart` in a session the daemon runs (spec 03). Loaded only when the command runs: it connects to the daemon.
 *
 * The daemon refuses `respawn` and `shutdown` on a worker's own connection, so this opens a new one. The restart is one
 * request that the daemon finishes after this process is gone; this session goes last. A person typed the command, so
 * nothing was cut short and no prompt is sent: the daemon's usual continue prompt carries a working session on.
 */

import { buildOnDisk, DaemonClient, DaemonError, lastFor, readJobEnv, respawnOne, restartRoost } from "xpi-roost";
import { getAgentDir, getRoostEntries } from "../../config.ts";

type Notify = (text: string, kind: "info" | "warning" | "error") => void;

export async function restartFromSession(all: boolean, notify: Notify): Promise<void> {
	const self = readJobEnv(process.env, "id");
	if (!self) return notify("this is not a background session", "error");
	try {
		if (all) {
			const entries = getRoostEntries();
			if (!entries) return notify("the background service is not available here", "error");
			const start = { agentDir: getAgentDir(), ...entries };
			const code = await restartRoost(
				{ self },
				{
					connect: () => DaemonClient.connectOrStart(start),
					buildOnDisk,
					say: (line) => notify(line, "info"),
				},
			);
			if (code !== 0)
				notify("restart finished with problems (see above); xpi roost restart shows them again", "error");
			return;
		}
		// a new connection, not the reporter's
		const client = await DaemonClient.connect();
		try {
			const { jobs } = await client.request("list", {});
			const last = lastFor(self, jobs, [self]);
			notify("restarting this session onto the installed build…", "info");
			const r = await respawnOne((a) => client.request("respawn", a), self, last);
			// normally this process is gone before the answer arrives
			if (!r?.started) notify(`not restarted${r?.error ? `: ${r.error}` : ""}`, "error");
		} finally {
			client.close();
		}
	} catch (err) {
		// the daemon ending this process closes the connection: that is the restart, not a failure
		if (err instanceof DaemonError && err.code === "closed") return;
		notify(`restart failed: ${(err as Error).message}`, "error");
	}
}
