/** Loads `xpi sg` and xpi-shadow-git only when the command runs (see cli.ts). */
export const loadShadowGitCommand = () => import("./cli.ts");
