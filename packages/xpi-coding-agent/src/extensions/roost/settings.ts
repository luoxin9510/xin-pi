/**
 * The `"roost"` section of xpi's settings, the user's and a project's merged as xpi-roost merges them: a project's
 * values win, except the four environment keys, which only the user's settings may set (USER_ONLY). The daemon reads
 * the user's section itself from `<agent dir>/settings.json`; this is for the session side and the hub.
 */
import { envPolicy, mergeConfig, type RoostConfig } from "xpi-roost";
import { getAgentDir } from "../../config.ts";
import { type Settings, SettingsManager } from "../../core/settings-manager.ts";

export function roostSettings(settings: {
	getGlobalSettings(): Settings;
	getProjectSettings(): Settings;
}): RoostConfig {
	const section = (s: Settings) => (s as { roost?: unknown }).roost;
	return mergeConfig(section(settings.getGlobalSettings()), section(settings.getProjectSettings()));
}

/**
 * What the `"roost"` settings give a new session (T14): its environment (`inheritEnv`, `envAllowList`, `envDenyList`,
 * `workspaceEnv`, the user's only) and its model and thinking level (`dispatchModel`, `dispatchThinking`). Read from the
 * files: the extension API's merged settings would let a project's environment keys through.
 */
export function launchSettings(
	cwd: string,
	projectTrusted: boolean,
	agentDir: string = getAgentDir(),
): { env: ReturnType<typeof envPolicy>; model?: string; thinking?: string } {
	const config = roostSettings(SettingsManager.create(cwd, agentDir, { projectTrusted }));
	return {
		env: envPolicy(config),
		...(config.dispatchModel ? { model: config.dispatchModel } : {}),
		...(config.dispatchThinking ? { thinking: config.dispatchThinking } : {}),
	};
}
