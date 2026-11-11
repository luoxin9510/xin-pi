// `xpi-roost/hub`: the hub (pi-roost's agent view) on xpi-tui, for `/agents` in an xpi session and
// `xpi roost hub` in a terminal of its own. xpi supplies what it cannot know (decision 1): the
// daemon connection, the detach key, how a new session is launched, models, presets and xpi's
// commands with how a peek runs each.

// what the adapter needs around the view: the shell launch's environment, the location the hub's own process
// carries, preset files, notifications
export type { Preset } from "../lib/config.ts";
export { workerEnv } from "../lib/dispatch.ts";
export { notifySequence, notifyText, resolveNotify, setJobEventBus } from "../lib/job-events.ts";
export { ROOST_LOCATION_ENV } from "../lib/paths.ts";
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
