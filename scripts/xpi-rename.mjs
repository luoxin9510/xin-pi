#!/usr/bin/env node
// Translates upstream pi names into xin-pi names. One table drives everything.
//
//   node scripts/xpi-rename.mjs              rewrite the whole repo and git mv package directories
//   node scripts/xpi-rename.mjs <path>...    rewrite only the given files/directories (for code ported from upstream)
//   node scripts/xpi-rename.mjs --check      exit 1 if any old name is left (whole repo, or the given paths)
//   node scripts/xpi-rename.mjs --dry-run    list the files that would change
//
// Idempotent: running it twice changes nothing. A line containing `xpi-rename-keep` is never rewritten
// or reported (used for the legacy specifiers the extension loader keeps as aliases).
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---- The table -----------------------------------------------------------------------------------------------

/** Workspace packages: upstream name, upstream directory under packages/, new name (= new directory). */
export const PACKAGES = [
	{ oldName: "@earendil-works/pi-ai", oldDir: "ai", newName: "xpi-ai" },
	{ oldName: "@earendil-works/pi-agent-core", oldDir: "agent", newName: "xpi-agent-core" },
	{ oldName: "@earendil-works/pi-tui", oldDir: "tui", newName: "xpi-tui" },
	{ oldName: "@earendil-works/pi-coding-agent", oldDir: "coding-agent", newName: "xpi-coding-agent" },
	{ oldName: "@earendil-works/pi-codemode", oldDir: "codemode", newName: "xpi-codemode" },
	{ oldName: "@earendil-works/pi-mcp", oldDir: "mcp", newName: "xpi-mcp" },
	{ oldName: "@earendil-works/pi-schema", oldDir: "schema", newName: "xpi-schema" },
	{ oldName: "@earendil-works/pi-telemetry", oldDir: "telemetry", newName: "xpi-telemetry" },
	{ oldName: "@earendil-works/pi-evals", oldDir: "evals", newName: "xpi-evals" },
];

/** Other names renamed as plain words. The install-lock package name is derived from the coding-agent name. */
export const NAMES = [
	{ oldName: "@earendil-works/pi-coding-agent-install", newName: "xpi-coding-agent-install" },
	{ oldName: "pi-monorepo", newName: "xpi-monorepo" },
];

/** Names under the old scope that are NOT ours and stay (external packages). */
export const KEEP_SCOPED = ["@earendil-works/gondolin"];

/** App-config environment variables. Not listed on purpose: CI secrets, build-time constants, release tooling. */
export const ENV_VARS = [
	"PI_AGENT_DIR",
	"PI_CACHE_RETENTION",
	"PI_CLEAR_ON_SHRINK",
	"PI_CLIPBOARD_OSC52",
	"PI_CLIPBOARD_WRITE",
	"PI_CODEMODE_MAX_WORKERS",
	"PI_CODING_AGENT_DIR",
	"PI_CODING_AGENT_SESSION_DIR",
	"PI_CODING_AGENT",
	"PI_EVAL_ARTIFACT_DIR",
	"PI_EVAL_ARTIFACT_GID",
	"PI_EVAL_ARTIFACT_UID",
	"PI_EVAL_CONTAINER",
	"PI_EVAL_RUNS_PER_VARIANT",
	"PI_EVAL_SANDBOX_GID",
	"PI_EVAL_SANDBOX_UID",
	"PI_EVAL_VARIANT",
	"PI_EXPERIMENTAL",
	"PI_HARDWARE_CURSOR",
	"PI_HYPERLINKS",
	"PI_IMAGE_PROTOCOL",
	"PI_INSTALLER_API_BASE",
	"PI_MANAGED_INSTALL_ROOT",
	"PI_MCP_CONFORMANCE_REPORT",
	"PI_MODEL",
	"PI_NO_LOCAL_LLM",
	"PI_OAUTH_CALLBACK_HOST",
	"PI_OFFLINE",
	"PI_PACKAGE_DIR",
	"PI_PROGRAM_STATUS",
	"PI_PROVIDER",
	"PI_RADIUS_GATEWAY",
	"PI_REASONING_LEVEL",
	"PI_SELF_UPDATE_COMMAND",
	"PI_SESSION_FILE",
	"PI_SESSION_ID",
	"PI_SHARE_VIEWER_URL",
	"PI_SKIP_VERSION_CHECK",
	"PI_SPAWN_HOOK",
	"PI_STARTUP_BENCHMARK",
	"PI_TELEMETRY",
	"PI_TEST_NATIVE_CLIPBOARD",
	"PI_TIMING",
	"PI_TRUE_COLOR",
	"PI_TUI_DEBUG",
	"PI_TUI_DEBUG_REDRAW",
	"PI_TUI_ESC_TIMEOUT",
	"PI_TUI_WIN32_TOOLCHAIN",
	"PI_TUI_WRITE_LOG",
	"PI_WSL_CLIPBOARD_IMAGE_PATH",
];

// ---- Mechanics -----------------------------------------------------------------------------------------------

const KEEP_MARKER = "xpi-rename-keep";
const NAME_END = "(?![A-Za-z0-9_-])";
const alt = (items) => [...items].sort((a, b) => b.length - a.length).map(escapeRegex).join("|");
function escapeRegex(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const nameMap = new Map([...PACKAGES, ...NAMES].map((entry) => [entry.oldName, entry.newName]));
const dirMap = new Map(PACKAGES.map((entry) => [entry.oldDir, entry.newName]));
const envMap = new Map(ENV_VARS.map((name) => [name, `X${name}`]));

// `pi-monorepo` is a bare word; it must not be part of a longer identifier (`xpi-monorepo`).
// Also matches the regex-escaped form `@earendil-works\/pi-ai` found inside regular expression literals.
const scopedNameRegex = new RegExp(`${alt([...nameMap.keys()].filter((name) => name.startsWith("@"))).replaceAll("/", "\\\\?/")}${NAME_END}`, "g");
const bareNameRegex = new RegExp(`(?<![A-Za-z0-9_@/.-])pi-monorepo${NAME_END}`, "g");
const dirRegex = new RegExp(`(?<![A-Za-z0-9_-])packages/(${alt(dirMap.keys())})${NAME_END}`, "g");
// Cross-package relative paths (`../../tui/src/x.ts`): rewritten only when they resolve to packages/<oldDir> from the
// file's own location, so an inner directory that happens to be called `agent` or `ai` is left alone.
const relativeDirRegex = new RegExp(`((?:\\.\\./)+)(${alt(dirMap.keys())})${NAME_END}`, "g");
const joinedDirRegex = new RegExp(`("packages",\\s*")(${alt(dirMap.keys())})(")`, "g");
const envRegex = new RegExp(`(?<![A-Za-z0-9_])(${alt(envMap.keys())})(?![A-Za-z0-9_])`, "g");

// Anything still under the old scope after rewriting, other than the explicit keeps, is reported.
const leftoverScopeRegex = new RegExp(`@earendil-works\\\\?/(?!(?:${alt(KEEP_SCOPED.map((name) => name.split("/")[1]))})${NAME_END})[A-Za-z0-9_.-]*`, "g");
const leftoverOldDirRegex = dirRegex;
const leftoverEnvRegex = envRegex;

function translateRelativeDirs(line, file) {
	if (!file) return line;
	return line.replace(relativeDirRegex, (match, ups, dir) => {
		const resolved = resolve(dirname(file), ups, dir);
		return dirname(resolved) === join(repoRoot, "packages") ? `${ups}${dirMap.get(dir)}` : match;
	});
}

// URLs point at the original project (or npm) and stay as they are.
function guardUrl(line, replace) {
	return (match, ...rest) => {
		const offset = rest[rest.length - 2];
		const tokenStart = Math.max(line.lastIndexOf(" ", offset), line.lastIndexOf("(", offset), line.lastIndexOf("\"", offset), line.lastIndexOf("`", offset), line.lastIndexOf("'", offset)) + 1;
		return line.slice(tokenStart, offset).includes("://") ? match : replace(match, ...rest);
	};
}

export function translate(text, file) {
	return text
		.split("\n")
		.map((line) => {
			if (line.includes(KEEP_MARKER)) return line;
			return translateRelativeDirs(line, file)
				.replace(scopedNameRegex, guardUrl(line, (match) => nameMap.get(match.replace("\\/", "/")) ?? match))
				.replace(bareNameRegex, "xpi-monorepo")
				.replace(dirRegex, guardUrl(line, (_match, dir) => `packages/${dirMap.get(dir)}`))
				.replace(joinedDirRegex, (_match, open, dir, close) => `${open}${dirMap.get(dir)}${close}`)
				.replace(envRegex, (match) => envMap.get(match) ?? match);
		})
		.join("\n");
}

export function findLeftovers(text) {
	const found = [];
	text.split("\n").forEach((line, index) => {
		if (line.includes(KEEP_MARKER)) return;
		for (const regex of [leftoverScopeRegex, bareNameRegex, leftoverOldDirRegex, leftoverEnvRegex]) {
			for (const match of line.matchAll(regex)) {
				const before = line.slice(0, match.index);
				const tokenStart = Math.max(before.lastIndexOf(" "), before.lastIndexOf("("), before.lastIndexOf("\""), before.lastIndexOf("`"), before.lastIndexOf("'")) + 1;
				if (regex !== leftoverEnvRegex && before.slice(tokenStart).includes("://")) continue;
				found.push({ line: index + 1, hit: match[0] });
			}
		}
	});
	return found;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".scratch", "native"]);
const SKIP_FILES = /(^|\/)(CHANGELOG[^/]*|LICENSE|package-lock\.json|xpi-rename\.mjs)$|\.(jsonl|png|jpe?g|gif|webp|ico|node|tgz|wasm|ttf|woff2?)$/;
const SKIP_PREFIXES = ["packages/coding-agent/test/fixtures/", "packages/xpi-coding-agent/test/fixtures/"];

function listFiles(target, out) {
	const stats = statSync(target);
	const rel = relative(repoRoot, target);
	if (stats.isDirectory()) {
		if (SKIP_DIRS.has(target.split("/").pop())) return;
		for (const entry of readdirSync(target)) listFiles(join(target, entry), out);
	} else if (!SKIP_FILES.test(rel) && !SKIP_PREFIXES.some((prefix) => rel.startsWith(prefix))) {
		out.push(target);
	}
}

function repoFiles() {
	const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8", maxBuffer: 1 << 28 })
		.split("\0")
		.filter(Boolean)
		.map((file) => join(repoRoot, file))
		.filter((file) => existsSync(file));
	return tracked.filter((file) => {
		const rel = relative(repoRoot, file);
		if (rel.split("/").some((part) => SKIP_DIRS.has(part))) return false;
		return !SKIP_FILES.test(rel) && !SKIP_PREFIXES.some((prefix) => rel.startsWith(prefix));
	});
}

function readText(file) {
	const buffer = readFileSync(file);
	if (buffer.includes(0)) return undefined;
	return buffer.toString("utf8");
}

function main() {
	const args = process.argv.slice(2);
	const check = args.includes("--check");
	const dryRun = args.includes("--dry-run");
	const paths = args.filter((arg) => !arg.startsWith("--")).map((arg) => resolve(arg));
	const files = [];
	if (paths.length > 0) for (const path of paths) listFiles(path, files);
	else files.push(...repoFiles());

	if (check) {
		let bad = 0;
		for (const file of files) {
			const text = readText(file);
			if (text === undefined) continue;
			for (const { line, hit } of findLeftovers(text)) {
				console.error(`${relative(repoRoot, file)}:${line}: ${hit}`);
				bad++;
			}
		}
		if (paths.length === 0) {
			for (const { oldDir } of PACKAGES) {
				if (existsSync(join(repoRoot, "packages", oldDir))) {
					console.error(`packages/${oldDir}: directory not renamed`);
					bad++;
				}
			}
		}
		if (bad > 0) {
			console.error(`xpi-rename --check: ${bad} leftover(s)`);
			process.exit(1);
		}
		console.log("xpi-rename --check: clean");
		return;
	}

	if (paths.length === 0 && !dryRun) {
		for (const { oldDir, newName } of PACKAGES) {
			const from = join(repoRoot, "packages", oldDir);
			const to = join(repoRoot, "packages", newName);
			if (existsSync(from) && !existsSync(to)) {
				execFileSync("git", ["mv", from, to], { cwd: repoRoot });
				console.log(`git mv packages/${oldDir} packages/${newName}`);
			}
		}
	}

	let changed = 0;
	const current = paths.length === 0 && !dryRun ? repoFiles() : files;
	for (const file of current) {
		const text = readText(file);
		if (text === undefined) continue;
		const next = translate(text, file);
		if (next === text) continue;
		changed++;
		console.log(`${dryRun ? "would change" : "rewrote"} ${relative(repoRoot, file)}`);
		if (!dryRun) writeFileSync(file, next);
	}
	console.log(`xpi-rename: ${changed} file(s) ${dryRun ? "would change" : "changed"}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
