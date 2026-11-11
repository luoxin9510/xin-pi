// `xpi-roost/hub`: the hub (pi-roost's agent view) on xpi-tui, for `/agents` in an xpi session and
// `xpi roost hub` in a terminal of its own. xpi supplies what it cannot know (decision 1): the
// daemon connection, the detach key, how a new session is launched, models, presets and xpi's
// commands with how a peek runs each.
export {
	AgentView,
	type AgentViewOptions,
	type BuiltinCommand,
	type BuiltinHow,
	fitScreen,
	type HubCommands,
	type HubCore,
	type HubDisplay,
	type HubLaunching,
	type HubModels,
	type HubResume,
	type LaunchOptions,
	type LaunchRequest,
	pickerShown,
	presetText,
	type Resumable,
} from "./agent-view.ts";
export type { Overlay, OverlayHost } from "./overlay-host.ts";
export { createLogOverlay } from "./overlays/log.ts";
export { createUsageOverlay } from "./overlays/usage.ts";
export { type RoostPort, roostPort, sends } from "./roost-port.ts";
export { ansiTheme, type HubTheme } from "./theme.ts";
