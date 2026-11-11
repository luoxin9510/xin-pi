/**
 * Where roost cannot run, and what to do about it: the messages of `xpi roost` and `xpi --bg`. Loaded by every xpi
 * start (the `--bg` flag checks them before the session starts), so it imports nothing of xpi-roost.
 */

import { createRequire } from "node:module";
import type { getRoostEntries } from "../../config.ts";

/** How to get node-pty: it is an optional dependency of the npm package. */
export const PTY_HINT =
	"node-pty (a native module, an optional dependency of xpi) is needed to run background sessions. Reinstall xpi with npm, without --ignore-scripts or --omit=optional: npm install -g xpi-coding-agent. On Linux node-pty compiles during the install and needs python3, make and a C++ compiler. Then restart the daemon: xpi roost daemon stop --keep-workers";

export const WINDOWS_MESSAGE =
	"xpi roost: background sessions are not supported on Windows (they need Unix pseudo-terminals and sockets). Use macOS or Linux, for example WSL.";

export const BINARY_MESSAGE =
	"xpi roost: background sessions need the npm installation of xpi: they run as Node processes with the native module node-pty, which a standalone binary does not carry. Install it with: npm install -g xpi-coding-agent";

/** Why roost cannot run here at all, or undefined (a missing node-pty is not such a reason). */
export function roostUnavailable(o: {
	platform: NodeJS.Platform;
	entries: ReturnType<typeof getRoostEntries>;
}): string | undefined {
	if (o.platform === "win32") return WINDOWS_MESSAGE;
	if (!o.entries) return BINARY_MESSAGE;
	return undefined;
}

/** Whether node-pty is installed where this process would find it (resolved, never loaded). */
export function ptyInstalled(): boolean {
	try {
		createRequire(import.meta.url).resolve("node-pty");
		return true;
	} catch {
		return false;
	}
}

/** `xpi --bg` without node-pty: the session it would start needs a PTY host. */
export const NO_PTY_MESSAGE = `xpi --bg: starting a background session needs node-pty, which is not installed. ${PTY_HINT}`;
