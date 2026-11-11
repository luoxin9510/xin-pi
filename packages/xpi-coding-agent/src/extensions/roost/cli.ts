/**
 * `xpi roost <subcommand>`: background sessions from the command line. xpi-roost holds the
 * commands and knows nothing of xpi; this supplies the agent directory, the daemon's and the
 * host's entry files, the detach key from the user's keybindings, and what to tell the user
 * when roost cannot run here. node-pty is never loaded in this process: only a host loads it.
 */

import { createRequire } from "node:module";
import { type DetachKeyMatcher, runRoostCli } from "xpi-roost";
import { isKeyRelease } from "xpi-tui";
import { getRoostEntries } from "../../config.ts";
import { KeybindingsManager } from "../../core/keybindings.ts";

/** How to get node-pty: it is an optional dependency of the npm package. */
export const PTY_HINT =
	"node-pty (a native module, an optional dependency of xpi) is needed to run background sessions. Reinstall xpi with npm, without --ignore-scripts or --omit=optional: npm install -g xpi-coding-agent. On Linux node-pty compiles during the install and needs python3, make and a C++ compiler. Then restart the daemon: xpi roost daemon stop --keep-workers";

export const WINDOWS_MESSAGE =
	"xpi roost: background sessions are not supported on Windows (they need Unix pseudo-terminals and sockets). Use macOS or Linux, for example WSL.";

export const BINARY_MESSAGE =
	"xpi roost: background sessions need the npm installation of xpi: they run as Node processes with the native module node-pty, which a standalone binary does not carry. Install it with: npm install -g xpi-coding-agent";

export const NO_PTY_MESSAGE = `xpi roost: node-pty is not installed. ${PTY_HINT}`;

/** Why roost cannot run here, or undefined. `ptyFound` is asked only after the platform and runtime checks. */
export function roostUnavailable(o: {
	platform: NodeJS.Platform;
	entries: ReturnType<typeof getRoostEntries>;
	ptyFound: () => boolean;
}): string | undefined {
	if (o.platform === "win32") return WINDOWS_MESSAGE;
	if (!o.entries) return BINARY_MESSAGE;
	if (!o.ptyFound()) return NO_PTY_MESSAGE;
	return undefined;
}

/** Whether node-pty is installed where this process would find it (resolved, never loaded). */
function ptyInstalled(): boolean {
	try {
		createRequire(import.meta.url).resolve("node-pty");
		return true;
	} catch {
		return false;
	}
}

// kitty's "report associated text" adds a third field (`CSI 122;5;26u`); the key is the same
const WITHOUT_TEXT = /^(\x1b\[[\d:]+;[\d:]+);[\d:]*u$/;

/** Decision 11: the detach key of an attached session is the user's `app.suspend`, pressed (not released). */
export function detachMatcher(keybindings: KeybindingsManager): DetachKeyMatcher {
	return (key) => !isKeyRelease(key) && keybindings.matches(key.replace(WITHOUT_TEXT, "$1u"), "app.suspend");
}

/** Commands that work without node-pty: they only read or stop. */
const WITHOUT_PTY = new Set(["help", "-h", "--help", "hub"]);

export async function runRoostCommand(args: string[], options: { agentDir: string }): Promise<number> {
	const entries = getRoostEntries();
	const needsPty = !(args.length === 0 || WITHOUT_PTY.has(args[0]!) || args[0] === "daemon");
	const problem = roostUnavailable({
		platform: process.platform,
		entries,
		ptyFound: () => !needsPty || ptyInstalled(),
	});
	if (problem || !entries) {
		process.stderr.write(`${problem ?? BINARY_MESSAGE}\n`);
		return 1;
	}
	const keybindings = KeybindingsManager.create(options.agentDir);
	const detachKeys = keybindings.getKeys("app.suspend");
	if (args[0] === "attach" && detachKeys.length === 0) {
		process.stderr.write(
			'xpi roost: attach detaches with the app.suspend key, which has none: bind one in keybindings.json (for example "app.suspend": "ctrl+z")\n',
		);
		return 1;
	}
	return runRoostCli(args, {
		start: { agentDir: options.agentDir, ...entries },
		isDetachKey: detachMatcher(keybindings),
		detachKeyName: detachKeys.join(" or ") || "app.suspend",
		ptyHint: PTY_HINT,
	});
}
