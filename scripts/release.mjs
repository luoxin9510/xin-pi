#!/usr/bin/env node
/**
 * xin-pi releases, in two steps that keep main's rule of one PR per change:
 *
 *   node scripts/release.mjs bump <patch|minor|major|x.y.z>
 *     On an up-to-date main: puts every package on the new version (one version for all), refreshes the lockfile
 *     and the coding-agent install lock, commits on a new branch release-vX.Y.Z, pushes it and opens a PR.
 *
 *   node scripts/release.mjs tag
 *     After that PR is merged and CI on main passed: tags main's head vX.Y.Z (the version in its package.json)
 *     and pushes only that tag. The tag starts .github/workflows/release.yml, which builds the binaries and
 *     publishes the GitHub Release.
 *
 * npm is not published by either step or by CI: the owner runs `npm publish` by hand (2FA); the tag step prints
 * the command.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { getPublicWorkspacePackages } from "./release-packages.mjs";

const BUMP_TYPES = new Set(["major", "minor", "patch"]);
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const CODING_AGENT_PACKAGE = "packages/xpi-coding-agent/package.json";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function usage() {
	console.error("Usage: node scripts/release.mjs bump <patch|minor|major|x.y.z>\n       node scripts/release.mjs tag");
	process.exit(1);
}

function fail(message) {
	console.error(`Error: ${message}`);
	process.exit(1);
}

function run(command, args, options = {}) {
	console.log(`$ ${[command, ...args].join(" ")}`);
	return execFileSync(command, args, { encoding: "utf8", stdio: "inherit", ...options });
}

function read(command, args) {
	return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function succeeds(command, args) {
	try {
		read(command, args);
		return true;
	} catch {
		return false;
	}
}

function currentVersion() {
	return JSON.parse(readFileSync(CODING_AGENT_PACKAGE, "utf8")).version;
}

// owner/repo of origin, for gh.
function originRepo() {
	const url = read("git", ["remote", "get-url", "origin"]);
	const match = url.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
	if (!match) fail(`origin is not a GitHub repository: ${url}`);
	return match[1];
}

function compareVersions(a, b) {
	const aParts = a.split(".").map(Number);
	const bParts = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		const diff = aParts[i] - bParts[i];
		if (diff !== 0) return diff;
	}
	return 0;
}

function nextVersion(version, target) {
	if (SEMVER_RE.test(target)) return target;
	const [major, minor, patch] = version.split(".").map(Number);
	if (target === "major") return `${major + 1}.0.0`;
	if (target === "minor") return `${major}.${minor + 1}.0`;
	return `${major}.${minor}.${patch + 1}`;
}

// Releases start from main as it is on origin, with nothing uncommitted.
function requireCleanMain() {
	if (read("git", ["status", "--porcelain"])) fail("the working tree has uncommitted changes.");
	if (read("git", ["branch", "--show-current"]) !== "main") fail("check out main first.");
	run("git", ["fetch", "origin", "main", "--quiet"]);
	if (read("git", ["rev-parse", "HEAD"]) !== read("git", ["rev-parse", "origin/main"])) {
		fail("main is not the same as origin/main; pull or push first.");
	}
}

function requireOneVersion() {
	const versions = [...new Set(getPublicWorkspacePackages().map((pkg) => pkg.version))];
	if (versions.length !== 1) fail(`the packages are not on one version: ${versions.join(", ")}`);
	return versions[0];
}

function tagExists(tag) {
	return (
		succeeds("git", ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`]) ||
		read("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`]) !== ""
	);
}

// npm version can leave lock entries for the previous workspace versions; drop them so the refresh is clean.
function removeStaleWorkspaceLockEntries() {
	const workspaceVersions = new Map(getPublicWorkspacePackages().map((pkg) => [pkg.name, pkg.version]));
	const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
	let removed = 0;
	for (const [path, pkg] of Object.entries(lock.packages)) {
		if (!path.startsWith("packages/") || pkg.link === true) continue;
		for (const [name, version] of workspaceVersions) {
			if (path.endsWith(`/node_modules/${name}`) && pkg.version !== version) {
				delete lock.packages[path];
				removed++;
				break;
			}
		}
	}
	if (removed > 0) writeFileSync("package-lock.json", `${JSON.stringify(lock, null, "\t")}\n`);
}

function bump(target) {
	if (!target || (!BUMP_TYPES.has(target) && !SEMVER_RE.test(target))) usage();
	requireCleanMain();
	const from = requireOneVersion();
	const version = nextVersion(from, target);
	if (compareVersions(version, from) <= 0) fail(`${version} is not newer than ${from}.`);
	const tag = `v${version}`;
	if (tagExists(tag)) fail(`${tag} already exists.`);
	const branch = `release-${tag}`;
	if (succeeds("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])) fail(`branch ${branch} already exists.`);

	run("git", ["checkout", "-b", branch]);
	run(npm, ["version", version, "--workspaces", "--no-git-tag-version", "--no-workspaces-update"]);
	run("node", ["scripts/sync-versions.js"]);
	run(npm, ["install", "--package-lock-only", "--ignore-scripts"]);
	removeStaleWorkspaceLockEntries();
	run(npm, ["install", "--package-lock-only", "--ignore-scripts"]);
	run(npm, ["ci", "--ignore-scripts"]);
	run(npm, ["run", "install-lock:coding-agent"]);
	if (currentVersion() !== version) fail(`${CODING_AGENT_PACKAGE} is at ${currentVersion()}, not ${version}.`);

	// Stage exactly the files the bump touched.
	const changed = read("git", ["ls-files", "--modified", "--others", "--deleted", "--exclude-standard"])
		.split("\n")
		.filter(Boolean);
	run("git", ["add", "--", ...new Set(changed)]);
	// The pre-commit hook runs `npm run check`.
	run("git", ["commit", "-m", `chore: release ${tag}`]);
	run("git", ["push", "-u", "origin", branch]);
	run("gh", [
		"pr",
		"create",
		"--repo",
		originRepo(),
		"--base",
		"main",
		"--head",
		branch,
		"--title",
		`chore: release ${tag}`,
		"--body",
		`Puts every package on ${version}. Once this is merged and CI on main passed, run \`npm run release:tag\` on main.`,
	]);
	console.log(`\nOpened the release PR for ${tag}. After it is merged: git checkout main && git pull && npm run release:tag`);
}

function tag() {
	requireCleanMain();
	const version = requireOneVersion();
	const tagName = `v${version}`;
	if (tagExists(tagName)) fail(`${tagName} already exists: bump the version first (npm run release:patch).`);

	// Only a head that CI has passed is released.
	const repo = originRepo();
	const head = read("git", ["rev-parse", "HEAD"]);
	const runs = JSON.parse(
		read("gh", ["run", "list", "--repo", repo, "--workflow", "ci.yml", "--commit", head, "--json", "status,conclusion"]),
	);
	if (!runs.some((r) => r.status === "completed" && r.conclusion === "success")) {
		fail(`CI has not passed on ${head.slice(0, 9)} yet (gh run list --repo ${repo} --workflow ci.yml --commit ${head}).`);
	}

	run("git", ["tag", "-a", tagName, "-m", `xpi ${tagName}`]);
	// Only this tag: the local clone also holds upstream pi's tags.
	run("git", ["push", "origin", `refs/tags/${tagName}`]);
	console.log(`
Pushed ${tagName}. The release workflow builds the binaries and publishes the GitHub Release:
  gh run list --repo ${repo} --workflow release.yml
  https://github.com/${repo}/releases/tag/${tagName}

npm is published by hand (needs 2FA):
  cd packages/xpi-coding-agent && npm publish --access public`);
}

const [command, target] = process.argv.slice(2);
if (command === "bump") bump(target);
else if (command === "tag" && target === undefined) tag();
else usage();
