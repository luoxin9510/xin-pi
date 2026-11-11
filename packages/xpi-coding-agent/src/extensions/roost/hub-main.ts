/**
 * T17: `xpi roost hub [dir]`, the hub in a terminal of its own, without an xpi session around it (pi-roost's
 * `pi-roost hub`). Drawn with xpi-tui; sessions start as the hub inside a session starts them (`hub-options.ts`), running
 * this xpi (`process.argv[1]`). Loaded only by that command.
 */

import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { AgentView, ansiTheme } from "xpi-roost/hub";
import { ProcessTerminal, TuiAltScreen } from "xpi-tui";
import { ENV_SESSION_DIR, expandTildePath } from "../../config.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { initTheme } from "../../modes/interactive/theme/theme.ts";
import { hubOptions, trustFor } from "./hub-options.ts";

/** The models `xpi --list-models` lists (those with credentials), as "provider/id". */
export function parseModelList(out: string): string[] {
	const models: string[] = [];
	// a table under a header; anything else (no credentials: a message) lists nothing
	const lines = out.split("\n");
	const header = lines.findIndex((l) => /^provider\s+model\b/.test(l.trim()));
	if (header < 0) return [];
	for (const line of lines.slice(header + 1)) {
		const [provider, id] = line.trim().split(/\s+/);
		if (provider && id) models.push(`${provider}/${id}`);
	}
	return models;
}

function listModels(cli: string): Promise<string[]> {
	return new Promise((done) => {
		execFile(process.execPath, [cli, "--list-models"], { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 }, (err, out) =>
			done(err ? [] : parseModelList(out)),
		);
	});
}

/** Why `dir` cannot be the hub's directory, or undefined. */
export function hubDirProblem(dir: string): string | undefined {
	try {
		if (!statSync(dir).isDirectory()) return `xpi roost hub: ${dir} is not a directory`;
	} catch {
		return `xpi roost hub: no directory ${dir}`;
	}
	return undefined;
}

/**
 * The settings `xpi roost hub` reads for itself: its theme and where sessions live. A project's settings count only as
 * far as the sessions started here would trust the folder (a stored decision: the hub asks nobody).
 */
export function standaloneSettings(cwd: string, agentDir: string): { theme?: string; sessionDir?: string } {
	const settings = SettingsManager.create(cwd, agentDir, {
		projectTrusted: trustFor(cwd, { cwd, agentDir, argv: [], projectTrusted: undefined }),
	});
	// where xpi keeps sessions without --session-dir: the environment's choice, else the settings'
	const envSessionDir = process.env[ENV_SESSION_DIR];
	return {
		theme: settings.getTheme(),
		sessionDir: envSessionDir ? expandTildePath(envSessionDir) : settings.getSessionDir(),
	};
}

/** Run the hub until the user leaves it; resolves to the exit code. */
export async function runHub(args: string[], o: { cwd: string; agentDir: string }): Promise<number> {
	if (args.length > 1 || args[0]?.startsWith("-")) {
		process.stderr.write("usage: xpi roost hub [dir]\n");
		return 2;
	}
	const cwd = resolve(o.cwd, args[0] ?? ".");
	const problem = hubDirProblem(cwd);
	if (problem) {
		process.stderr.write(`${problem}\n`);
		return 1;
	}
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		process.stderr.write("xpi roost hub needs a terminal\n");
		return 1;
	}
	const { theme, sessionDir } = standaloneSettings(cwd, o.agentDir);
	// xpi's components the hub shows (its /resume list) draw with xpi's theme
	try {
		initTheme(theme);
	} catch {
		initTheme();
	}
	const cli = process.argv[1]!;
	let models: string[] = [];
	void listModels(cli).then((m) => {
		models = m;
	});
	const options = hubOptions({
		cwd,
		agentDir: o.agentDir,
		// what new sessions run: this xpi, with its default extensions
		argv: [process.execPath, cli],
		commands: () => [],
		models: () => models,
		scopedModels: () => [],
		currentSession: () => undefined,
		sessionDir: () => sessionDir,
	});
	const terminal = new ProcessTerminal();
	// a closed tab or a kill: exit, so xpi-tui's exit handler gives the terminal back
	for (const sig of ["SIGTERM", "SIGHUP"] as const)
		process.once(sig, () => process.exit(128 + (sig === "SIGTERM" ? 15 : 1)));
	// as xpi draws by default: the alternate screen, the shell kept below
	const tui = new TuiAltScreen(terminal);
	let view: AgentView | undefined;
	await new Promise<void>((done) => {
		view = new AgentView({
			tui,
			theme: ansiTheme(),
			...options,
			// a terminal of its own: always the whole screen
			fullscreen: true,
			setTitle: (title) => terminal.setTitle(title),
			done: () => done(),
		});
		tui.addChild(view);
		tui.setFocus(view);
		tui.start();
		void view.start();
	});
	// keys still arriving (a kitty key release of the Esc that closed it) stay out of the shell
	await terminal.drainInput(1000).catch(() => {});
	// its daemon connection and timers go with it, so the process can end
	view?.dispose();
	tui.stop();
	return 0;
}
