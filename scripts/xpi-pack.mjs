#!/usr/bin/env node
// Pack the xpi CLI into one installable tarball: ./dist-pack/xpi-coding-agent-<version>.tgz (gitignored).
// The tarball is self-contained: the bundle inlines the xpi-* workspace packages, so nothing is published to npm.
//   npm run xpi:pack
//   npm i -g ./dist-pack/xpi-coding-agent-<version>.tgz

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(repoRoot, "dist-pack");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const run = (args) => execFileSync(npm, args, { cwd: repoRoot, stdio: "inherit", shell: process.platform === "win32" });

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
// `npm run build` cleans the coding-agent dist first, so stale files are never packed.
run(["run", "build"]);
run(["pack", "--workspace", "xpi-coding-agent", "--pack-destination", outDir, "--silent"]);
const tarball = readdirSync(outDir).find((name) => name.endsWith(".tgz"));
if (!tarball) throw new Error("npm pack produced no tarball");
console.log(`\nPacked ${join(outDir, tarball)}\nInstall: npm i -g ${join(outDir, tarball)}`);
