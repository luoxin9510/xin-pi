/**
 * `xpi sg <subcommand>`: a private git history over a workspace owned by another version control system.
 * xpi-shadow-git holds the commands and knows nothing of xpi; this supplies the store (inside the agent
 * directory) and where the adapters shipped with xpi are.
 */

import { join } from "node:path";
import { runSg } from "xpi-shadow-git";
import { getShadowGitAdaptersDir } from "../../config.ts";

export interface ShadowGitCommandOptions {
	cwd: string;
	agentDir: string;
}

/** Run `xpi sg <args>`; the result is the process exit code (0, 1 or 2). */
export function runShadowGitCommand(args: string[], options: ShadowGitCommandOptions): Promise<number> {
	return runSg(args, {
		cwd: options.cwd,
		defaultStore: join(options.agentDir, "shadow-git"),
		builtinAdaptersDir: getShadowGitAdaptersDir(),
	});
}
