/**
 * The path check of a sandboxed session: `read`, `write`, `edit`, `grep`, `find` and `ls` are held to the sandbox's
 * path policy (xpi-shadow-git `sandboxPolicy`), by the real path of each path they are given.
 */

import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
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

/** Where a sandboxed session may always write, besides its own tree and scratch area. */
export interface WritableDirs {
	/** xpi's agent directory, the session directory and the temp directory (real paths). */
	dirs: string[];
	/** The shadow-git store (real path): inside the agent directory by default, and never writable from a sandbox. */
	store: string;
}

export function writableDirs(agentDir: string, sessionDir: string | undefined, store: string): WritableDirs {
	return {
		dirs: [agentDir, ...(sessionDir ? [sessionDir] : []), tmpdir()].map(realOrSelf),
		store: realOrSelf(store),
	};
}

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
	if (path.includes("://")) return undefined;
	const abs = resolveToCwd(path, cwd);
	const result = sandboxPolicy(sandbox, abs, backend);
	const where = `shadow-git sandbox ${sandbox.repo.name}/${sandbox.id}`;
	if (access === "read") {
		return result.read ? undefined : `${where}: ${abs} is hidden (${result.reason})`;
	}
	if (result.write) return undefined;
	// xpi's own directories and the temp directory are writable. The store inside them is not (it holds the shadow repo
	// and every other sandbox), and neither is the primary workspace, which may itself sit under the temp directory.
	const kept = [writable.store, sandbox.workspace, sandbox.primary];
	if (result.mode === "shared-ro" && !kept.some((root) => within(result.real, root))) {
		if (writable.dirs.some((dir) => within(result.real, dir))) return undefined;
	}
	return `${where}: ${abs} is read-only (${result.reason}); writable: the sandbox tree ${sandbox.tree}, its scratch area ${sandbox.scratch}, xpi's own directories and temp directories`;
}
