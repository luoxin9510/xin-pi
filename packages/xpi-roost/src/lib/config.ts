// Roost's settings: the "roost" section of xpi's settings.json, the user's
// (`<agent dir>/settings.json`) and a project's. Unknown keys are ignored; a bad file or
// section is skipped. The daemon reads the user's section itself; xpi's own settings code
// reads and writes it for the extension and the hub.
import { join } from "node:path";
import { readJson } from "./atomic.ts";

export interface RoostConfig {
	leftArrowOpensAgents: boolean;
	reapIdleMinutes: number;
	/** M15: records of sessions ended this many days ago are removed (0: never). */
	cleanupDays: number;
	dispatchModel?: string;
	dispatchThinking?: string;
	envAllowList: string[];
	/** M20: workers start with the launching shell's environment (false: envAllowList only). */
	inheritEnv: boolean;
	/** M20: names (or `PREFIX*`) never carried. */
	envDenyList: string[];
	/** M20: the workspace's environment on top: its shell's cd hooks (direnv, mise, fnm), direnv only, or off. */
	workspaceEnv: "shell" | "direnv" | "off";
	groupBy: "state" | "directory";
	/** The hub covers the whole terminal (false: below the conversation, like the editor). */
	fullscreen: boolean;
	/** M8: each row shows its model and context window use. */
	rowDetails: boolean;
	/** NT-1: how the hub makes the terminal notify. */
	notify: "auto" | "osc9" | "osc777" | "bell" | "off";
	/** M27: saved choices for new sessions, by name (the user's and a project's, merged). */
	presets?: Record<string, Preset>;
}

/** M27: what a preset sets for new sessions; everything is optional. */
export interface Preset {
	model?: string;
	thinking?: string;
	/** Relative to the hub's directory, as `@dir` takes it. */
	dir?: string;
}

export const PRESET_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/;
/** The /preset subcommands: not names. */
const PRESET_WORDS = new Set(["off", "save", "rm"]);
export function presetName(name: string): boolean {
	return PRESET_NAME.test(name) && !PRESET_WORDS.has(name);
}

/** M27: a preset from JSON, or undefined when it is not one. */
export function presetFrom(v: unknown): Preset | undefined {
	if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
	const o = v as Record<string, unknown>;
	const p: Preset = {};
	if (typeof o.model === "string" && o.model.includes("/") && o.model.length <= 200) p.model = o.model;
	if (typeof o.thinking === "string" && /^[a-z]{1,16}$/.test(o.thinking)) p.thinking = o.thinking;
	// a directory under the hub's: a cloned project's preset cannot point elsewhere
	// (the hub checks again, after links, that it stays under the hub's directory)
	if (typeof o.dir === "string" && o.dir && o.dir.length <= 200 && relativeDir(o.dir)) p.dir = o.dir;
	return p;
}

function relativeDir(d: string): boolean {
	if (d.startsWith("/") || d.startsWith("\\") || d.startsWith("~") || /^[A-Za-z]:/.test(d)) return false;
	return !d.split(/[\\/]/).includes("..") && !/[\x00-\x1f]/.test(d);
}

function presetsFrom(v: unknown): Record<string, Preset> | undefined {
	if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
	const out: Record<string, Preset> = Object.create(null);
	for (const [name, raw] of Object.entries(v as Record<string, unknown>).slice(0, 100)) {
		const p = presetName(name) ? presetFrom(raw) : undefined;
		if (p) out[name] = p;
	}
	return out;
}

/**
 * Keys a project's settings may not set: a cloned repository must not choose which of
 * your environment reaches its sessions.
 */
export const USER_ONLY = ["envAllowList", "inheritEnv", "envDenyList", "workspaceEnv"] as const;

export const DEFAULTS: RoostConfig = {
	leftArrowOpensAgents: true,
	reapIdleMinutes: 60,
	cleanupDays: 30,
	envAllowList: [],
	inheritEnv: true,
	envDenyList: [],
	workspaceEnv: "shell",
	groupBy: "state",
	fullscreen: true,
	rowDetails: true,
	notify: "auto",
};

/** The keys of a "roost" section that are well formed. */
export function pickConfig(raw: unknown): Partial<RoostConfig> {
	if (!raw || typeof raw !== "object") return {};
	const r = raw as Record<string, unknown>;
	const out: Partial<RoostConfig> = {};
	if (typeof r.leftArrowOpensAgents === "boolean") out.leftArrowOpensAgents = r.leftArrowOpensAgents;
	if (typeof r.reapIdleMinutes === "number" && r.reapIdleMinutes > 0) out.reapIdleMinutes = r.reapIdleMinutes;
	if (typeof r.cleanupDays === "number" && r.cleanupDays >= 0 && r.cleanupDays <= 3650)
		out.cleanupDays = r.cleanupDays;
	for (const k of ["dispatchModel", "dispatchThinking"] as const) {
		if (typeof r[k] === "string" && r[k]) out[k] = r[k] as string;
	}
	if (Array.isArray(r.envAllowList))
		out.envAllowList = r.envAllowList.filter((v): v is string => typeof v === "string");
	if (typeof r.inheritEnv === "boolean") out.inheritEnv = r.inheritEnv;
	if (r.workspaceEnv === "shell" || r.workspaceEnv === "direnv" || r.workspaceEnv === "off")
		out.workspaceEnv = r.workspaceEnv;
	if (Array.isArray(r.envDenyList))
		out.envDenyList = r.envDenyList.filter((v): v is string => typeof v === "string" && v !== "");
	if (typeof r.fullscreen === "boolean") out.fullscreen = r.fullscreen;
	if (typeof r.rowDetails === "boolean") out.rowDetails = r.rowDetails;
	if (r.groupBy === "state" || r.groupBy === "directory") out.groupBy = r.groupBy;
	const presets = presetsFrom(r.presets);
	if (presets) out.presets = presets;
	if (
		r.notify === "auto" ||
		r.notify === "osc9" ||
		r.notify === "osc777" ||
		r.notify === "bell" ||
		r.notify === "off"
	) {
		out.notify = r.notify;
	}
	return out;
}

/** The settings from the user's and a project's "roost" sections (a project cannot set USER_ONLY keys). */
export function mergeConfig(user: unknown, project: unknown): RoostConfig {
	const u = pickConfig(user);
	const p = pickConfig(project);
	for (const k of USER_ONLY) delete p[k];
	// M27: presets merge by name (a project's wins)
	const presets =
		u.presets || p.presets
			? Object.assign(Object.create(null) as Record<string, Preset>, u.presets, p.presets)
			: undefined;
	return { ...DEFAULTS, ...u, ...p, ...(presets ? { presets } : {}) };
}

/** The "roost" section of a settings.json file, or undefined. */
export function roostSection(settingsFile: string): unknown {
	return readJson<Record<string, unknown>>(settingsFile)?.roost;
}

/** The user's settings, as the daemon reads them: `<agent dir>/settings.json` (the daemon has no project). */
export function loadUserConfig(agentDir: string | undefined): RoostConfig {
	return mergeConfig(agentDir ? roostSection(join(agentDir, "settings.json")) : undefined, undefined);
}

/** M20: the environment settings, as buildLaunch takes them. */
export function envPolicy(config: Pick<RoostConfig, "envAllowList" | "inheritEnv" | "envDenyList" | "workspaceEnv">): {
	extraEnv: string[];
	inheritEnv: boolean;
	envDenyList: string[];
	workspaceEnv: "shell" | "direnv" | "off";
} {
	return {
		extraEnv: config.envAllowList,
		inheritEnv: config.inheritEnv,
		envDenyList: config.envDenyList,
		workspaceEnv: config.inheritEnv ? config.workspaceEnv : "off",
	};
}
