/** Loads `xpi roost` and xpi-roost only when the command runs (see cli.ts). */
export const loadRoostCommand = () => import("./cli.ts");
