import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { precondition } from "./errors.ts";
import { pidAlive } from "./lock.ts";
import type { Repo } from "./registry.ts";

/** `<store>/<name>.sessions`: a top-level xpi session in the primary workspace writes `<pid>` here and removes it at exit. */
export const sessionsDir = (repo: Repo): string => join(repo.ctx.store, `${repo.name}.sessions`);

/** The pids of the live sessions. Entries whose pid is not alive are dropped. */
export function liveSessions(repo: Repo): number[] {
	const dir = sessionsDir(repo);
	if (!existsSync(dir)) return [];
	const live: number[] = [];
	for (const entry of readdirSync(dir)) {
		const pid = Number(entry);
		if (!Number.isInteger(pid) || pid <= 0) continue;
		if (pidAlive(pid)) live.push(pid);
		else rmSync(join(dir, entry), { force: true });
	}
	return live.sort((a, b) => a - b);
}

/** Exit 2 while another live session is listed: it edits the primary workspace without the lock. */
export function assertNoOtherSession(repo: Repo, what: string): void {
	const others = liveSessions(repo).filter((pid) => pid !== repo.ctx.ownSessionPid);
	if (others.length > 0) {
		throw precondition(
			`${what} needs no other xpi session in ${repo.workspace} (live: pid ${others.join(", ")}); it edits the workspace without the lock`,
		);
	}
}
