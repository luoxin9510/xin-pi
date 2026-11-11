/**
 * The `"roost"` section of xpi's settings, the user's and a project's merged as xpi-roost merges them: a project's
 * values win, except the four environment keys, which only the user's settings may set (USER_ONLY). The daemon reads
 * the user's section itself from `<agent dir>/settings.json`; this is for the session side and the hub.
 */
import { mergeConfig, type RoostConfig } from "xpi-roost";
import type { Settings } from "../../core/settings-manager.ts";

export function roostSettings(settings: {
	getGlobalSettings(): Settings;
	getProjectSettings(): Settings;
}): RoostConfig {
	const section = (s: Settings) => (s as { roost?: unknown }).roost;
	return mergeConfig(section(settings.getGlobalSettings()), section(settings.getProjectSettings()));
}
