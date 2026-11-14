// What xpi-coding-agent uses of xpi-roost. The daemon and the host are entry files of their
// own (`xpi-roost/daemon`, `xpi-roost/host`), run as processes, never imported here. What every
// xpi session needs (the write lock) is `xpi-roost/session`, which connects to nothing.

export { type RoostCliOptions, roostUsage, runRoostCli, type ScheduleLaunchInput } from "./cli.ts";
export { type DeliverItem, type JobIdentity, jobIdentity, Reporter } from "./lib/agent-client.ts";
export { readJson } from "./lib/atomic.ts";
export { type DetachKeyMatcher, isLocalDetach, localDetachAt } from "./lib/attach.ts";
export { DaemonClient, DaemonError, type DaemonStart, daemonEnv, requestOnce } from "./lib/client.ts";
export {
	DEFAULTS as ROOST_SETTINGS_DEFAULTS,
	envPolicy,
	mergeConfig,
	type RoostConfig,
	USER_ONLY,
} from "./lib/config.ts";
export { buildLaunch, fallbackName } from "./lib/dispatch.ts";
export { clip, messageText } from "./lib/heuristics.ts";
export { hostControl } from "./lib/hostclient.ts";
export { JOB_ENV, readJobEnv } from "./lib/identity.ts";
export { type ContextInfo, type DispatchArgs, PROTOCOL_VERSION } from "./lib/protocol.ts";
export { type AwayLog, awayIsEmpty, emptyAway, recapList } from "./lib/recap.ts";
export { lastFor, RESTART_PROMPT, type RestartClient, respawnOne, restartRoost } from "./lib/restart.ts";
export { RUN_SLOT } from "./lib/schedule.ts";
export { writeCommands } from "./lib/store.ts";
export { sessionUsage, type UsageInfo } from "./lib/usage.ts";
export { buildOnDisk, isStale, ROOST_BUILD, ROOST_VERSION } from "./lib/version.ts";
export { CUSTOM_DIALOG_MS, FIRST_PROMPT_MS, WorkerTracker } from "./lib/worker-state.ts";
