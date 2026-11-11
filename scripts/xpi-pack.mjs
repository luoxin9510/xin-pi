#!/usr/bin/env node
// Pack xpi-coding-agent as it is published: ./dist-pack/xpi-coding-agent-<version>.tgz (gitignored).
// The tarball is self-contained (scripts/coding-agent-publish.mjs): the CLI and the library entry are bundles that
// inline the xpi-* workspace packages, and their declaration files are included, so nothing else is published to npm.
//   npm run xpi:pack
//   npm i -g ./dist-pack/xpi-coding-agent-<version>.tgz     (install it)
//   npm publish ./dist-pack/xpi-coding-agent-<version>.tgz --access public     (publish it; the owner, 2FA)

import { mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packCodingAgent } from "./coding-agent-publish.mjs";
import { execNpmSync } from "./npm-command.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(repoRoot, "dist-pack");

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
// `npm run build` cleans the coding-agent dist first, so stale files are never packed.
execNpmSync(["run", "build"], { cwd: repoRoot, stdio: "inherit" });
const packed = packCodingAgent({
	packageDir: join(repoRoot, "packages", "xpi-coding-agent"),
	packagesDir: join(repoRoot, "packages"),
	destination: outDir,
});
const tarball = join(outDir, packed.filename);
console.log(`\nPacked ${tarball}\nInstall: npm i -g ${tarball}\nPublish: npm publish ${tarball} --access public`);
