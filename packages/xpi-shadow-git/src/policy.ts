import { relative } from "node:path";
import type { Backend } from "./backend.ts";
import { type Mode, modeOf, realOf, WRITABLE, within } from "./rules.ts";
import type { Sandbox } from "./sandbox.ts";

export interface PolicyResult {
	/** The mode of the path where it really is. */
	mode: Mode;
	read: boolean;
	write: boolean;
	/** The real path the check used (for a new file, its parent directory's real path plus the name). */
	real: string;
	/** One line that says where the path is and why. */
	reason: string;
}

const result = (mode: Mode, real: string, reason: string): PolicyResult => ({
	mode,
	read: mode !== "hidden",
	write: WRITABLE.has(mode),
	real,
	reason,
});

/**
 * What a sandboxed command may do with an absolute path, by its real path (a new file by its parent directory's), so
 * a write through a link into `primary` is seen as a write to the primary file.
 *
 * `backend` says where the workspace's own path leads. Under `policy` (the default) it is the primary workspace, and
 * the sandbox's tree is a directory in the store. Under `namespace` the tree is mounted over it.
 */
export function sandboxPolicy(sbx: Sandbox, path: string, backend: Backend = "policy"): PolicyResult {
	const real = realOf(path);
	const rulesOf = (rel: string): Mode | undefined => modeOf(sbx, true, rel);

	if (within(real, sbx.scratch)) {
		const mode = rulesOf(relative(sbx.scratch, real)) === "hidden" ? "hidden" : "scratch";
		return result(mode, real, "the sandbox's scratch area");
	}
	const treeRoot = within(real, sbx.tree)
		? sbx.tree
		: backend === "namespace" && within(real, sbx.workspace)
			? sbx.workspace
			: undefined;
	if (treeRoot !== undefined) {
		const mode = rulesOf(relative(treeRoot, real)) ?? "private";
		return result(mode, real, mode === "private" ? "the sandbox's own copy" : `a ${mode} path of the sandbox`);
	}
	const primaryRoot = within(real, sbx.primary)
		? sbx.primary
		: within(real, sbx.workspace)
			? sbx.workspace
			: undefined;
	if (primaryRoot !== undefined) {
		const mode = rulesOf(relative(primaryRoot, real));
		if (mode === "hidden") return result("hidden", real, "hidden in the primary workspace");
		if (mode === "shared-rw") return result("shared-rw", real, "a shared-rw path of the primary workspace");
		return result("shared-ro", real, "the primary workspace, which a sandbox only reads");
	}
	const mode = modeOf(sbx, false, real) ?? "shared-ro";
	return result(
		mode,
		real,
		mode === "shared-ro" ? "outside the workspace, read-only unless a rule says so" : `a ${mode} path by rule`,
	);
}
