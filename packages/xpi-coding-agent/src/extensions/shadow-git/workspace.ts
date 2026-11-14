/** Finding the shadow-git repo for a directory, and the context the core runs with inside xpi. */

import { join } from "node:path";
import { createContext, type Repo, resolveRepo, type SgContext, SgError, type SgOptions } from "xpi-shadow-git";
import { getAgentDir, getShadowGitAdaptersDir } from "../../config.ts";

/** The core's options for xpi: the store inside the agent directory, the adapters shipped with xpi, this process as the session. */
export function shadowGitOptions(cwd: string, extra: Partial<SgOptions> = {}): SgOptions {
	return {
		cwd,
		defaultStore: join(getAgentDir(), "shadow-git"),
		builtinAdaptersDir: getShadowGitAdaptersDir(),
		ownSessionPid: process.pid,
		...extra,
	};
}

export const shadowGitContext = (cwd: string, extra: Partial<SgOptions> = {}): SgContext =>
	createContext(shadowGitOptions(cwd, extra));

/** A context that prints nothing: the terminal belongs to the TUI. What the core would say (an `auto` backend choice) is dropped. */
export const quietContext = (cwd: string): SgContext =>
	shadowGitContext(cwd, { stdio: "capture", stdout: () => {}, stderr: () => {} });

/** The registered workspace that contains `cwd` (the longest registered path wins), or undefined. */
export function findWorkspace(cwd: string): Repo | undefined {
	try {
		return resolveRepo(shadowGitContext(cwd), undefined);
	} catch (error) {
		if (error instanceof SgError) return undefined;
		throw error;
	}
}

/** `<name>/<id>` of the sandbox this process runs in, or undefined in the primary workspace. */
export const sandboxRef = (): string | undefined => process.env.XPI_SG_SANDBOX || undefined;

/** The message for an attempt to make a sandbox inside a sandbox. */
export const NESTING_MESSAGE =
	'sandboxes do not nest: this session runs in a shadow-git sandbox, so isolation "worktree" and teammates (each of which would get a sandbox) are not available here';
