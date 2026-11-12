/**
 * `xpi roost <subcommand>`: background sessions from the command line. xpi-roost holds the
 * commands and knows nothing of xpi; this supplies the agent directory, the daemon's and the
 * host's entry files, the detach key from the user's keybindings, and what to tell the user
 * when roost cannot run here. node-pty is never loaded in this process: only a host loads it.
 * Without node-pty here, only what starts a host is refused (xpi-roost's `ptyInstalled`): the
 * sessions an older daemon still runs can be listed, read, replied to and stopped.
 */

import { join, resolve } from "node:path";
import {
	buildLaunch,
	type DetachKeyMatcher,
	type DispatchArgs,
	RUN_SLOT,
	runRoostCli,
	type ScheduleLaunchInput,
} from "xpi-roost";
import { isKeyRelease } from "xpi-tui";
import { ENV_SESSION_DIR, expandTildePath, getRoostEntries, VERSION } from "../../config.ts";
import { KeybindingsManager } from "../../core/keybindings.ts";
import { getDefaultSessionDir } from "../../core/session-manager.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { sessionTrust } from "./background.ts";
import { loadHubMain } from "./hub.lazy.ts";
import { BINARY_MESSAGE, PTY_HINT, ptyInstalled, roostUnavailable } from "./messages.ts";
import { launchSettings } from "./settings.ts";

export { BINARY_MESSAGE, PTY_HINT, ptyInstalled, roostUnavailable, WINDOWS_MESSAGE } from "./messages.ts";

// kitty's "report associated text" adds a third field (`CSI 122;5;26u`); the key is the same
const WITHOUT_TEXT = /^(\x1b\[[\d:]+;[\d:]+);[\d:]*u$/;

/** Decision 11: the detach key of an attached session is the user's `app.suspend`, pressed (not released). */
export function detachMatcher(keybindings: KeybindingsManager): DetachKeyMatcher {
	return (key) => !isKeyRelease(key) && keybindings.matches(key.replace(WITHOUT_TEXT, "$1u"), "app.suspend");
}

/**
 * Phase 2 (decision 9): a schedule's launch, built here as `xpi --bg` builds one, by this xpi for the schedule's
 * directory. Trust: only a decision stored for the directory (else `--no-approve`), so a run never waits at the trust
 * question. Model and thinking: the given ones, else the `roost` settings'. The session directory xpi would use there
 * (the building xpi's `--session-dir`, else the environment's, else the settings', else the default), each run's file `{{run}}.jsonl` in it. The environment:
 * this process's, filtered by the `roost` settings; the daemon stores it with the schedule.
 */
export function scheduleLaunch(
	input: ScheduleLaunchInput,
	o: {
		agentDir: string;
		env?: NodeJS.ProcessEnv;
		execPath?: string;
		entry?: string;
		/** The `--session-dir` of the xpi that builds it (the hub's); first, as xpi takes it. */
		sessionDir?: string;
	},
): DispatchArgs {
	const trusted = sessionTrust(input.cwd, [], undefined, o.agentDir);
	const settings = launchSettings(input.cwd, trusted, o.agentDir);
	const env = o.env ?? process.env;
	const envSessionDir = env[ENV_SESSION_DIR];
	const sessionDir = resolve(
		input.cwd,
		o.sessionDir ??
			(envSessionDir ? expandTildePath(envSessionDir) : undefined) ??
			SettingsManager.create(input.cwd, o.agentDir, { projectTrusted: trusted }).getSessionDir() ??
			getDefaultSessionDir(input.cwd, o.agentDir),
	);
	const execPath = o.execPath ?? process.execPath;
	return buildLaunch({
		task: input.task ?? "",
		cwd: input.cwd,
		sessionFile: join(sessionDir, `${RUN_SLOT}.jsonl`),
		name: input.name,
		origin: "dispatch",
		// this xpi's executable and entry; no flags of the `xpi roost` command line
		argv: [execPath, o.entry ?? process.argv[1]!],
		execPath,
		env,
		trusted,
		...settings.env,
		...((input.model ?? settings.model) ? { model: input.model ?? settings.model } : {}),
		...((input.thinking ?? settings.thinking) ? { thinking: input.thinking ?? settings.thinking } : {}),
		piVersion: VERSION,
	});
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
		scheduleLaunch: (input) => scheduleLaunch(input, { agentDir: options.agentDir }),
		hub: async (rest) => {
			const { runHub } = await loadHubMain();
			return runHub(rest, { cwd: process.cwd(), agentDir: options.agentDir });
		},
	});
}
