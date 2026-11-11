/**
 * Loads the hub and the hand-off only when they are used: every foreground session registers `/agents`, `/bg` and the
 * left arrow, and none of them should load xpi-roost's client or the hub before then.
 */
export const loadOpenView = () => import("./open-view.ts");
export const loadHandoff = () => import("./handoff.ts");
export const loadHubMain = () => import("./hub-main.ts");
