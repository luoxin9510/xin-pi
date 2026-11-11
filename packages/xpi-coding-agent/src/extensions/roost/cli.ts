/**
 * `xpi roost <subcommand>`: background sessions from the command line. xpi-roost holds the
 * commands and knows nothing of xpi; this supplies the agent directory, the daemon's and the
 * host's entry files, the detach key from the user's keybindings, and what to tell the user
 * when roost cannot run here. node-pty is never loaded in this process: only a host loads it.
 * Without node-pty here, only what starts a host is refused (xpi-roost's `ptyInstalled`): the
 * sessions an older daemon still runs can be listed, read, replied to and stopped.
 */

import { type DetachKeyMatcher, runRoostCli } from "xpi-roost";
import { isKeyRelease } from "xpi-tui";
import { getRoostEntries } from "../../config.ts";
import { KeybindingsManager } from "../../core/keybindings.ts";
import { loadHubMain } from "./hub.lazy.ts";
import { BINARY_MESSAGE, PTY_HINT, ptyInstalled, roostUnavailable } from "./messages.ts";

export { BINARY_MESSAGE, PTY_HINT, ptyInstalled, roostUnavailable, WINDOWS_MESSAGE } from "./messages.ts";

// kitty's "report associated text" adds a third field (`CSI 122;5;26u`); the key is the same
const WITHOUT_TEXT = /^(\x1b\[[\d:]+;[\d:]+);[\d:]*u$/;

/** Decision 11: the detach key of an attached session is the user's `app.suspend`, pressed (not released). */
export function detachMatcher(keybindings: KeybindingsManager): DetachKeyMatcher {
	return (key) => !isKeyRelease(key) && keybindings.matches(key.replace(WITHOUT_TEXT, "$1u"), "app.suspend");
}

export async function runRoostCommand(
	args: string[],
	options: { agentDir: string; ptyInstalled?: () => boolean },
): Promise<number> {
	const entries = getRoostEntries();
	const problem = roostUnavailable({ platform: process.platform, entries });
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
		ptyInstalled: (options.ptyInstalled ?? ptyInstalled)(),
		hub: async (rest) => {
			const { runHub } = await loadHubMain();
			return runHub(rest, { cwd: process.cwd(), agentDir: options.agentDir });
		},
	});
}
