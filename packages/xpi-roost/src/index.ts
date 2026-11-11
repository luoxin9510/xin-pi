// What xpi-coding-agent uses of xpi-roost. The daemon and the host are entry files of their
// own (`xpi-roost/daemon`, `xpi-roost/host`), run as processes, never imported here.

export { type RoostCliOptions, roostUsage, runRoostCli } from "./cli.ts";
export { type DetachKeyMatcher, isLocalDetach, localDetachAt } from "./lib/attach.ts";
export { DaemonClient, DaemonError, type DaemonStart, daemonEnv } from "./lib/client.ts";
export { DEFAULTS as ROOST_SETTINGS_DEFAULTS, mergeConfig, type RoostConfig, USER_ONLY } from "./lib/config.ts";
export { ROOST_VERSION } from "./lib/version.ts";
