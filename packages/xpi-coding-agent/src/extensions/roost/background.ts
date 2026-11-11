/**
 * `xpi --bg "<task>"` (T14): hand the task to the daemon as a new background session and exit. Loaded only when the
 * flag is given. The session runs this same xpi (`process.argv[1]`) with the flags that choose its extensions and model,
 * in this directory, with the environment the user's `"roost"` settings allow. Wherever those lists say otherwise, the
 * host gives it the agent directory and the state and runtime directories (decision 7).
 */

import { buildLaunch, DaemonClient, fallbackName, ROOST_VERSION, requestOnce } from "xpi-roost";
import { getAgentDir, getRoostEntries, VERSION } from "../../config.ts";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { BINARY_MESSAGE } from "./messages.ts";
import { launchSettings } from "./settings.ts";

/** What `xpi --bg` prints once it has exited (anything written while the TUI is up is drawn over). */
export function backgroundedText(id: string, name: string, notes: string[] = []): string {
	return [
		`backgrounded · ${id} · ${name}`,
		...notes.map((n) => `  note: ${n}`),
		`  xpi roost attach ${id}   open it (the app.suspend key detaches)`,
		`  xpi roost logs ${id}     its screen`,
		`  xpi roost stop ${id}     stop it`,
		`  xpi roost ls --json${" ".repeat(Math.max(1, id.length - 4))}     list all`,
		"",
	].join("\n");
}

/** Whether the command line chose a model or thinking level itself (then the settings' dispatch choice does not). */
export function chosenOnCommandLine(argv: string[]): { model: boolean; thinking: boolean } {
	const has = (...names: string[]) => argv.some((a) => names.some((n) => a === n || a.startsWith(`${n}=`)));
	return { model: has("--model", "--provider"), thinking: has("--thinking") };
}

export interface BackgroundDeps {
	/** This process's command line (tests): the session runs `argv[1]` with the flags it repeats. */
	argv?: string[];
	/** Runs `fn` once xpi has exited and its TUI is gone (tests). */
	atExit?: (fn: () => void) => void;
}

export async function backgroundAndExit(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	task: string,
	deps: BackgroundDeps = {},
): Promise<void> {
	const argv = deps.argv ?? process.argv;
	// xpi exits through process.exit; an exit listener can still print after the TUI is gone and change the code
	const atExit = deps.atExit ?? ((fn: () => void) => process.once("exit", fn));
	const fail = (message: string) => {
		atExit(() => {
			process.stderr.write(`xpi --bg: ${message}\n`);
			process.exitCode = 1;
		});
		ctx.shutdown();
	};
	if (!ctx.hasUI) return fail("--bg needs interactive mode; it cannot be combined with -p or --mode");
	const entries = getRoostEntries();
	if (!entries) return fail(BINARY_MESSAGE);

	const nameFlag = pi.getFlag("bg-name");
	const name = typeof nameFlag === "string" && nameFlag.trim() ? nameFlag.trim() : fallbackName(task);
	// The session file this start would have written (xpi --session <file> --bg continues that one); xpi writes session
	// files lazily, so it need not exist. This process never opens it: it took no write lock. None: --no-session, which
	// the flag's check refuses already.
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (!sessionFile) return fail("cannot be combined with --no-session: a background session needs a session file");

	const settings = launchSettings(ctx.cwd, ctx.isProjectTrusted());
	const chosen = chosenOnCommandLine(argv.slice(2));
	const agentDir = getAgentDir();
	const start = { agentDir, ...entries };
	let client: DaemonClient | undefined;
	try {
		client = await DaemonClient.connectOrStart(start);
		// M51: sent again (taken once) when the answer is lost to a restart of the daemon
		const { id, name: finalName } = await requestOnce(
			async () => {
				if (client && !client.isClosed) return client;
				client = await DaemonClient.connectOrStart(start);
				return client;
			},
			"dispatch",
			buildLaunch({
				task,
				cwd: ctx.cwd,
				sessionFile,
				name,
				origin: "bg",
				argv,
				execPath: process.execPath,
				env: process.env,
				// the answer this process got (the prompt, --approve, or a stored decision) goes with the session
				trusted: ctx.isProjectTrusted(),
				...settings.env,
				...(!chosen.model && settings.model ? { model: settings.model } : {}),
				...(!chosen.thinking && settings.thinking ? { thinking: settings.thinking } : {}),
				piVersion: VERSION,
			}),
			{ tag: "bg" },
		);
		const notes: string[] = [];
		try {
			const status = await client.request("status", {});
			if (status.version !== ROOST_VERSION)
				notes.push(
					`the background service is ${status.version}, this xpi is ${ROOST_VERSION}; restart it with: xpi roost daemon stop --keep-workers, then xpi roost respawn --all`,
				);
			if (status.ptyError) notes.push(`the background service cannot load node-pty: ${status.ptyError}`);
		} catch {
			// the session is started; the notes are a courtesy
		}
		atExit(() => process.stdout.write(backgroundedText(id, finalName, notes)));
		ctx.shutdown();
	} catch (err) {
		fail((err as Error).message);
	} finally {
		client?.close();
	}
}
