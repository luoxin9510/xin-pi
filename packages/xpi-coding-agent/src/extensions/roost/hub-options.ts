/**
 * T17: what the hub needs from xpi, for the hub inside a session (`/agents`, `open-view.ts`) and the one in a
 * terminal of its own (`xpi roost hub`, `hub-main.ts`): the daemon of this agent directory, the detach key, how an xpi
 * session and a shell command are launched and resumed, models, presets, settings written back, xpi's commands and how
 * a peek runs each. What the host xpi knows (its models, its session, its trust decision) comes in `h`.
 */

import { realpathSync } from "node:fs";
import { buildLaunch, DaemonClient, type DaemonStart, daemonEnv, envPolicy, fallbackName } from "xpi-roost";
import {
	type AgentViewOptions,
	notifySequence,
	notifyText,
	type Overlay,
	type Preset,
	type Resumable,
	ROOST_LOCATION_ENV,
	resolveNotify,
	workerEnv,
} from "xpi-roost/hub";
import { readWriterLock } from "xpi-roost/session";
import { getRoostEntries, VERSION } from "../../config.ts";
import { KeybindingsManager } from "../../core/keybindings.ts";
import { type SessionInfo, SessionManager } from "../../core/session-manager.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { ProjectTrustStore } from "../../core/trust-manager.ts";
import { SessionSelectorComponent } from "../../modes/interactive/components/session-selector.ts";
import { detachMatcher } from "./cli.ts";
import { builtinCommands } from "./commands.ts";
import { roostSettings } from "./settings.ts";

export interface XpiHost {
	/** Directory new sessions start in. */
	cwd: string;
	agentDir: string;
	/** The command line sessions repeat (xpi's CLI, its -e extensions and model flags). */
	argv: string[];
	/** Whether the project is trusted (the session's own answer for `cwd`; the hub in a terminal: none). */
	projectTrusted?: boolean;
	commands: () => { name: string; source: string }[];
	/** Models with credentials, "provider/id". */
	models: () => string[];
	scopedModels: () => string[];
	/** The session the host xpi is in (it cannot be resumed in the background). */
	currentSession: () => string | undefined;
	sessionDir: () => string | undefined;
}

/** The roost of this agent directory: its location goes into this process's environment, as `xpi roost` does. */
export function roostStart(agentDir: string): DaemonStart {
	const entries = getRoostEntries();
	if (!entries) throw new Error("background sessions need the npm installation of xpi");
	const start: DaemonStart = { agentDir, ...entries };
	const location = daemonEnv(start);
	for (const name of ROOST_LOCATION_ENV) process.env[name] = location[name];
	return start;
}

const same = (a: string, b: string): boolean => {
	try {
		return realpathSync(a) === realpathSync(b);
	} catch {
		return a === b;
	}
};

/**
 * Fact 2 of the PR 4 brief: the trust decision a session the hub starts in `dir` gets (`--approve`/`--no-approve`), so
 * it never stops at "Trust project folder?" in its PTY. The host xpi's own answer for its directory; elsewhere a stored
 * decision (`trust.json`, the nearest one). Undefined when there is none: a directory without project resources, or a
 * `defaultProjectTrust` of always or never, decides for itself without asking; a directory with resources and no
 * decision under "ask" still asks (not settled here).
 */
export function trustFor(dir: string, h: Pick<XpiHost, "cwd" | "agentDir" | "projectTrusted">): boolean | undefined {
	if (h.projectTrusted !== undefined && same(dir, h.cwd)) return h.projectTrusted;
	const stored = new ProjectTrustStore(h.agentDir).get(dir);
	return stored ?? undefined;
}

/** The user's settings (global only): the hub writes the `"roost"` keys it changes there. */
function userSettings(h: Pick<XpiHost, "cwd" | "agentDir">): SettingsManager {
	return SettingsManager.create(h.cwd, h.agentDir, { projectTrusted: false });
}

export function hubOptions(h: XpiHost): Omit<AgentViewOptions, "tui" | "theme" | "setTitle" | "done"> {
	const start = roostStart(h.agentDir);
	const settingsNow = () =>
		roostSettings(SettingsManager.create(h.cwd, h.agentDir, { projectTrusted: h.projectTrusted ?? false }));
	const config = settingsNow();
	const keybindings = KeybindingsManager.create(h.agentDir);
	return {
		cwd: h.cwd,
		connect: () => DaemonClient.connectOrStart(start),
		isDetachKey: detachMatcher(keybindings),
		detachKeyName: keybindings.getKeys("app.suspend").join(" or ") || "app.suspend",
		builtins: builtinCommands,
		launch: (task, o = {}) => {
			const cwd = o.cwd ?? h.cwd;
			const name = o.name ?? fallbackName(task);
			const sessionFile = o.sessionFile ?? SessionManager.create(cwd).getSessionFile();
			if (!sessionFile) throw new Error("could not allocate a session file");
			const now = settingsNow();
			return buildLaunch({
				task,
				cwd,
				sessionFile,
				name,
				origin: o.origin ?? "dispatch",
				argv: h.argv,
				execPath: process.execPath,
				env: process.env,
				trusted: trustFor(cwd, h),
				...envPolicy(now),
				piVersion: VERSION,
				// a resumed session keeps its own model unless the hub chose one
				model: o.model ?? (o.origin === "adopt" ? undefined : now.dispatchModel),
				thinking: o.thinking ?? (o.origin === "adopt" ? undefined : now.dispatchThinking),
			});
		},
		launchShell: (command, cwd) => {
			const now = settingsNow();
			return {
				kind: "shell" as const,
				cwd,
				sessionFile: "",
				command: [process.env.SHELL || "/bin/sh", "-lc", command],
				env: workerEnv(process.env, envPolicy(now)),
				...(now.inheritEnv && now.workspaceEnv !== "off" ? { workspaceEnv: now.workspaceEnv } : {}),
				...(now.envDenyList.length
					? { envDeny: now.envDenyList, ...(now.envAllowList.length ? { envForce: now.envAllowList } : {}) }
					: {}),
				name: `! ${fallbackName(command)}`,
				origin: "dispatch" as const,
			};
		},
		// M27: read again each time (a save from another hub, or an edited file)
		presets: () => settingsNow().presets ?? {},
		savePreset: (name: string, preset: Preset | null) => {
			const s = userSettings(h);
			const current = { ...((roostSettings(s) && userPresets(s)) ?? {}) };
			if (preset) current[name] = preset;
			else delete current[name];
			s.setRoostSetting("presets", Object.keys(current).length > 0 ? current : undefined);
		},
		userPreset: (name) => Object.hasOwn(userPresets(userSettings(h)) ?? {}, name),
		commands: h.commands,
		models: h.models,
		scopedModels: h.scopedModels,
		currentSession: h.currentSession,
		resumable: async (cwd) =>
			// a session another xpi is writing cannot be run here (the write lock)
			(await SessionManager.list(cwd))
				.filter((s) => !readWriterLock(s.path))
				.map(
					(s): Resumable => ({
						path: s.path,
						name: s.name || fallbackName(s.firstMessage || "session"),
						cwd: s.cwd,
						modified: s.modified.getTime(),
					}),
				),
		sessionSelector: (o) => sessionSelector(h, o),
		defaultModel: () => settingsNow().dispatchModel ?? launchDefaultModel(h),
		groupBy: config.groupBy,
		onGroupBy: (groupBy) => userSettings(h).setRoostSetting("groupBy", groupBy),
		notify: (row, kind) => {
			const { title, body } = notifyText(row, kind);
			const seq = notifySequence(resolveNotify(settingsNow().notify), title, body);
			if (seq) process.stdout.write(seq);
		},
		fullscreen: config.fullscreen,
		rowDetails: config.rowDetails,
	};
}

/** The presets of the user's own settings file (not a project's). */
function userPresets(s: SettingsManager): Record<string, Preset> | undefined {
	return roostSettings({ getGlobalSettings: () => s.getGlobalSettings(), getProjectSettings: () => ({}) }).presets;
}

/** M23: xpi's own /resume list: search, this directory or all of them, sort. */
function sessionSelector(h: XpiHost, o: Parameters<NonNullable<AgentViewOptions["sessionSelector"]>>[0]): Overlay {
	const seen = new Map<string, SessionInfo>();
	const keep = (list: SessionInfo[]) => {
		for (const s of list) seen.set(s.path, s);
		return list;
	};
	const selector = new SessionSelectorComponent(
		// this xpi's session directory (a --session-dir too)
		(onProgress, signal) => SessionManager.list(o.cwd, h.sessionDir(), onProgress, signal).then(keep),
		(onProgress, signal) => SessionManager.listAll(onProgress, signal).then(keep),
		(path) => {
			const s = seen.get(path);
			o.onSelect({
				path,
				name: s?.name || fallbackName(s?.firstMessage || "session"),
				cwd: s?.cwd || o.cwd,
				modified: s ? s.modified.getTime() : Date.now(),
			});
		},
		o.onCancel,
		o.onCancel,
		o.requestRender,
		undefined,
		h.currentSession(),
	);
	// a session a background job or another xpi is writing is never deleted from here
	const list = selector.getSessionList() as unknown as {
		onDeleteSession?: (path: string) => Promise<void>;
		onError?: (message: string) => void;
	};
	const remove = list.onDeleteSession;
	list.onDeleteSession = async (path) => {
		if (o.busy(path) || readWriterLock(path)) {
			list.onError?.("in use by a running session: stop it first");
			return;
		}
		await remove?.(path);
	};
	return {
		render: (width: number) => selector.render(width),
		handleInput: (data: string) => selector.handleInput(data),
		get focused() {
			return selector.focused;
		},
		set focused(v: boolean) {
			selector.focused = v;
		},
		// its session lists may still be loading
		dispose: () => (selector as unknown as { cancelLoads?: () => void }).cancelLoads?.(),
	};
}

/**
 * M23: what a session started from here runs without a chosen model: the hub's own `--model` (new sessions inherit
 * its command line), else xpi's default from settings.
 */
let defaultCache: { cwd: string; at: number; value: string | undefined } | undefined;
function launchDefaultModel(h: Pick<XpiHost, "cwd" | "agentDir" | "argv">): string | undefined {
	const { argv, cwd } = h;
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--model" && argv[i + 1]) return argv[i + 1];
		if (argv[i]?.startsWith("--model=")) return argv[i]!.slice("--model=".length);
	}
	// read on render: a few seconds' cache
	if (defaultCache && defaultCache.cwd === cwd && Date.now() - defaultCache.at < 5000) return defaultCache.value;
	let value: string | undefined;
	try {
		const s = SettingsManager.create(cwd, h.agentDir);
		const model = s.getDefaultModel();
		const provider = s.getDefaultProvider();
		value = model ? (model.includes("/") || !provider ? model : `${provider}/${model}`) : undefined;
	} catch {
		value = undefined;
	}
	defaultCache = { cwd, at: Date.now(), value };
	return value;
}
