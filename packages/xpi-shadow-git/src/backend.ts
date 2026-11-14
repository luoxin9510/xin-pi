import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { configGet } from "./config.ts";
import type { SgContext } from "./context.ts";
import { precondition } from "./errors.ts";
import { cleanEnv } from "./git.ts";
import { run } from "./proc.ts";
import { gitDirOf, type Repo } from "./registry.ts";
import { modeOf } from "./rules.ts";
import type { Sandbox } from "./sandbox.ts";

export type Backend = "namespace" | "policy";

export interface Probe {
	ok: boolean;
	/** Why the namespace backend is not available, or "ok". */
	message: string;
}

const unshareOf = (ctx: SgContext): string => ctx.env.XPI_SG_UNSHARE || "unshare";

// A pid namespace with its own /proc: without it `/proc/<pid>/root` and `/proc/<pid>/cwd` of a process outside reach
// the primary workspace through the host's mount namespace.
const UNSHARE_ARGS = ["--user", "--map-root-user", "--mount", "--pid", "--fork", "--mount-proc"];

/**
 * Whether `unshare --user --map-root-user --mount --pid --fork --mount-proc` works here, and `mount` and `findmnt` are
 * present (the script needs them). Container runtimes often mask parts of `/proc`, which makes the fresh `/proc`
 * mount fail; then the backend is not available. Run once per command. `XPI_SG_UNSHARE` names another program, for tests.
 */
export function probeNamespace(ctx: SgContext): Probe {
	if (process.platform !== "linux" && !ctx.env.XPI_SG_UNSHARE) {
		return { ok: false, message: `the namespace backend needs Linux (this is ${process.platform})` };
	}
	const result = run(
		unshareOf(ctx),
		[...UNSHARE_ARGS, "sh", "-c", "command -v mount > /dev/null && command -v findmnt > /dev/null"],
		{ cwd: "/", env: cleanEnv(ctx.env) },
	);
	if (result.spawnError) {
		return {
			ok: false,
			message: `${unshareOf(ctx)} cannot be run (${result.spawnError.message}); it is part of util-linux`,
		};
	}
	if (result.status !== 0) {
		const reason = result.stderr.trim().split("\n")[0] || "mount or findmnt is missing";
		return { ok: false, message: `unshare ${UNSHARE_ARGS.join(" ")} failed: ${reason}` };
	}
	return { ok: true, message: "ok" };
}

/**
 * The backend for a command: `sandbox.backend` (`auto`, `namespace` or `policy`), with `sandbox.require = namespace`
 * turning a missing namespace backend into exit 2. With `auto` the choice is printed when `announce` is set.
 */
export function resolveBackend(repo: Repo, announce: boolean): Backend {
	const want = configGet(repo, "sandbox.backend") ?? "auto";
	if (want !== "auto" && want !== "namespace" && want !== "policy") {
		throw precondition(`sandbox.backend is ${JSON.stringify(want)}: use auto, namespace or policy`);
	}
	const require = configGet(repo, "sandbox.require");
	if (require !== undefined && require !== "namespace") {
		throw precondition(`sandbox.require is ${JSON.stringify(require)}: only "namespace" is known`);
	}
	if (want === "policy") {
		if (require === "namespace") throw precondition("sandbox.require = namespace, but sandbox.backend = policy");
		return "policy";
	}
	const probe = probeNamespace(repo.ctx);
	if (probe.ok) {
		if (announce && want === "auto") repo.ctx.err("xpi sg: sandbox backend: namespace (auto)\n");
		return "namespace";
	}
	if (want === "namespace" || require === "namespace") {
		throw precondition(`the namespace sandbox backend is not available: ${probe.message}`);
	}
	if (announce) repo.ctx.err(`xpi sg: sandbox backend: policy (auto; namespace is not available: ${probe.message})\n`);
	return "policy";
}

const shq = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

interface Cover {
	path: string;
	dir: boolean;
}

function kindOf(path: string): Cover | undefined {
	try {
		return { path, dir: statSync(path).isDirectory() };
	} catch {
		return undefined;
	}
}

const present = (covers: (Cover | undefined)[]): Cover[] => covers.filter((cover) => cover !== undefined);

/** Paths below `ws` that are hidden, and the ones among them that sit inside a `shared-rw` path (bound into the tree). */
function hiddenPaths(sbx: Sandbox): { all: string[]; inRw: string[] } {
	const candidates = new Set<string>(sbx.metadata);
	for (const rule of sbx.rules) if (rule.ws && rule.mode === "hidden") candidates.add(rule.path);
	const all = [...candidates].filter((path) => path !== "" && modeOf(sbx, true, path) === "hidden");
	const inRw = all.filter((path) =>
		sbx.rules.some(
			(rule) => rule.ws && rule.mode === "shared-rw" && rule.path !== path && path.startsWith(`${rule.path}/`),
		),
	);
	return { all, inRw };
}

/**
 * What a sandbox must not write, because it would run as the user's own commands later (a `core.fsmonitor`, a filter
 * driver, a hook): the shadow repo's `config`, `config.worktree`, `hooks` and `info`, every other sandbox's
 * `worktrees/<id>` and the sandbox directory `<name>.sbx` (the other sandboxes' trees). The sandbox's own
 * `worktrees/<id>` (HEAD, index, logs), `tree` and `scratch` stay writable, except `commondir`, `gitdir` and
 * `config.worktree` of its own `worktrees/<id>`: a `commondir` pointed at a directory of its own would make git read
 * that directory's config. Refs and objects stay writable: that is how a sandbox commits.
 */
export function gitGuards(sbx: Sandbox): { ownFiles: string[]; readOnly: string[]; own: string; worktrees: string } {
	const dir = gitDirOf(sbx.repo.ctx, sbx.repo.name);
	return {
		ownFiles: ["commondir", "gitdir", "config.worktree"].map((name) => join(sbx.gitDir, name)),
		readOnly: [join(dir, "config"), join(dir, "config.worktree"), join(dir, "hooks"), join(dir, "info")],
		own: sbx.gitDir,
		worktrees: dirname(sbx.gitDir),
	};
}

/**
 * The `sh` script `sbx run` gives to `unshare`. The command is its arguments. The mount order is fixed:
 * 1. bind the workspace at `primary` and remount it read-only, repeating the locked flags;
 * 2. cover `hidden` paths (inside `primary` too);
 * 3. bind `shared-rw` paths read-write at their place in the tree;
 * 4. bind the tree over the workspace's own path;
 * 5. bind `shared-ro` absolute paths read-only over themselves, and cover hidden absolute paths.
 * Every mount point exists before this runs.
 */
export function namespaceScript(sbx: Sandbox): string {
	const ws = sbx.workspace;
	const out: string[] = [
		"set -eu",
		"# Run a setup step; a failure ends the script with 125, so it is not taken for the command's own exit.",
		'step() { "$@" || { echo "xpi sg: sandbox setup failed: $*" >&2; exit 125; }; }',
		"# A read-only remount in a user namespace must repeat the flags the mount was locked with.",
		"ro_remount() {",
		`\tflags=$(findmnt -no OPTIONS --target "$1" | head -n 1 | tr ',' '\\n' | grep -E '^(nosuid|nodev|noexec|noatime|nodiratime|relatime|strictatime)$' | paste -s -d, - || true)`,
		`\tstep mount -o "remount,bind,ro\${flags:+,$flags}" "$1"`,
		"}",
		`# 1. the primary workspace, read-only`,
		`step mount --rbind ${shq(ws)} ${shq(sbx.primary)}`,
		`ro_remount ${shq(sbx.primary)}`,
	];
	const cover = (target: Cover): string =>
		target.dir
			? `step mount -t tmpfs -o ro,mode=0555 tmpfs ${shq(target.path)}`
			: `step mount --bind /dev/null ${shq(target.path)}`;
	const hidden = hiddenPaths(sbx);
	out.push("# 2. hidden paths, inside primary too");
	for (const target of present(hidden.all.map((path) => kindOf(join(ws, path))))) {
		out.push(cover({ path: join(sbx.primary, target.path.slice(ws.length + 1)), dir: target.dir }));
	}
	out.push("# 3. shared-rw paths, bound read-write at their place in the tree");
	for (const rule of sbx.rules) {
		if (!rule.ws || rule.mode !== "shared-rw" || rule.path === "") continue;
		if (kindOf(join(ws, rule.path)))
			out.push(`step mount --rbind ${shq(join(ws, rule.path))} ${shq(join(sbx.tree, rule.path))}`);
	}
	for (const target of present(hidden.inRw.map((path) => kindOf(join(ws, path))))) {
		out.push(cover({ path: join(sbx.tree, target.path.slice(ws.length + 1)), dir: target.dir }));
	}
	out.push("# 4. the tree over the workspace's own path");
	out.push(`step mount --rbind ${shq(sbx.tree)} ${shq(ws)}`);
	out.push("# 5. shared-ro absolute paths, read-only over themselves; hidden absolute paths covered");
	for (const rule of sbx.rules) {
		if (rule.ws || rule.mode !== "shared-ro" || !kindOf(rule.path)) continue;
		out.push(`step mount --rbind ${shq(rule.path)} ${shq(rule.path)}`, `ro_remount ${shq(rule.path)}`);
	}
	for (const rule of sbx.rules) {
		const target = !rule.ws && rule.mode === "hidden" ? kindOf(rule.path) : undefined;
		if (target) out.push(cover(target));
	}
	const guards = gitGuards(sbx);
	out.push("# 6. the shared git directory: what runs as the user's own commands is read-only");
	// Submounts are made first: a read-only remount covers the top mount only, so they stay as they are.
	out.push(`step mount --bind ${shq(guards.own)} ${shq(guards.own)}`);
	for (const file of guards.ownFiles)
		out.push(`step mount --bind ${shq(file)} ${shq(file)}`, `ro_remount ${shq(file)}`);
	out.push(
		`step mount --rbind ${shq(guards.worktrees)} ${shq(guards.worktrees)}`,
		`ro_remount ${shq(guards.worktrees)}`,
	);
	for (const target of guards.readOnly) {
		out.push(`step mount --rbind ${shq(target)} ${shq(target)}`, `ro_remount ${shq(target)}`);
	}
	const sandboxes = dirname(sbx.root);
	out.push("# 7. the other sandboxes: read-only; this one's tree and scratch stay writable");
	for (const own of [sbx.tree, sbx.scratch]) out.push(`step mount --rbind ${shq(own)} ${shq(own)}`);
	out.push(`step mount --rbind ${shq(sandboxes)} ${shq(sandboxes)}`, `ro_remount ${shq(sandboxes)}`);
	out.push(`step cd ${shq(ws)}`, 'exec "$@"');
	return `${out.join("\n")}\n`;
}

/** The program and arguments that run `cmd` in the namespace. */
export function namespaceCommand(ctx: SgContext, sbx: Sandbox, cmd: string[]): { file: string; args: string[] } {
	return { file: unshareOf(ctx), args: [...UNSHARE_ARGS, "sh", "-c", namespaceScript(sbx), "xpi-sg-sandbox", ...cmd] };
}
