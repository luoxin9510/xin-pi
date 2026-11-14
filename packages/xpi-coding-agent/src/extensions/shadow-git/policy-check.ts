/**
 * The path check of a sandboxed session: `read`, `write`, `edit`, `grep`, `find` and `ls` are held to the sandbox's
 * path policy (xpi-shadow-git `sandboxPolicy`), by the real path of each path they are given.
 */

import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { type Backend, type Sandbox, sandboxPolicy } from "xpi-shadow-git";
import { resolveToCwd } from "../../core/tools/path-utils.ts";

const realOrSelf = (path: string): string => {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
};

const within = (path: string, root: string): boolean =>
	path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);

/**
 * Where a sandboxed session may always write, besides its own tree and scratch area: what a child needs to run and no
 * more. Not xpi's agent directory as a whole: `settings.json`, `auth.json` and `extensions/` there are read by the next
 * session that is not sandboxed.
 */
export interface WritableDirs {
	/** The session directory (a subagent's session is below its parent's), the temp directory and the user's agent memory (real paths). */
	dirs: string[];
	/** The shadow-git store (real path): never writable from a sandbox, wherever it is. */
	store: string;
}

export function writableDirs(sessionDir: string | undefined, store: string): WritableDirs {
	return {
		dirs: [...(sessionDir ? [sessionDir] : []), tmpdir(), join(homedir(), ".claude", "agent-memory")].map(realOrSelf),
		store: realOrSelf(store),
	};
}

const SCHEME = /^@?[a-z][a-z0-9+.-]*:\/\//i;

export type Access = "read" | "write";

/** A one-line reason when the tool call must be refused, else undefined. Paths of other schemes (`name://`) are not files. */
export function pathDenied(
	sandbox: Sandbox,
	backend: Backend,
	writable: WritableDirs,
	cwd: string,
	path: string,
	access: Access,
): string | undefined {
	const where = `shadow-git sandbox ${sandbox.repo.name}/${sandbox.id}`;
	// `name://...` paths are resolved by the host's schemes, which may locate a file anywhere: not checked, so not allowed.
	// (A path that merely contains "://" after a directory, such as `/ws/x://y`, is an ordinary path and is checked.)
	if (SCHEME.test(path)) return `${where}: ${path} is a scheme path, which a sandbox cannot check; use a file path`;
	const abs = resolveToCwd(path, cwd);
	const result = sandboxPolicy(sandbox, abs, backend);
	if (access === "read") {
		return result.read ? undefined : `${where}: ${abs} is hidden (${result.reason})`;
	}
	if (result.write) return undefined;
	// The session directory and the temp directory are writable. The store is not (it holds the shadow repo
	// and every other sandbox), and neither is the primary workspace, which may itself sit under the temp directory.
	const kept = [writable.store, sandbox.workspace, sandbox.primary];
	if (result.mode === "shared-ro" && !kept.some((root) => within(result.real, root))) {
		if (writable.dirs.some((dir) => within(result.real, dir))) return undefined;
	}
	return `${where}: ${abs} is read-only (${result.reason}); writable: the sandbox tree ${sandbox.tree}, its scratch area ${sandbox.scratch}, the session directory and temp directories`;
}
