import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmdirSync,
	rmSync,
	statSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { callAdapter, lines } from "./adapter.ts";
import { type Backend, namespaceCommand, probeNamespace, resolveBackend } from "./backend.ts";
import { assertNoImport, configAll, configGet } from "./config.ts";
import type { SgContext } from "./context.ts";
import { failure, precondition } from "./errors.ts";
import { cleanEnv, git, gitIn } from "./git.ts";
import { withLock } from "./lock.ts";
import { run } from "./proc.ts";
import { gitDirOf, type Repo, realPath, resolveRepo } from "./registry.ts";
import { covers, type Mode, modeOf, parseRule, type Rule, ruleText } from "./rules.ts";

export const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// Names inside a sandbox's directory
const RESERVED = new Set(["tree", "scratch", "primary", "policy", "links", "excludes", "lock"]);

/** A sandbox: a git worktree on `sbx/<id>`, a scratch area, a view of the primary workspace, and its path rules. */
export interface Sandbox {
	repo: Repo;
	id: string;
	/** `sbx/<id>`. */
	branch: string;
	/** `<store>/<name>.sbx/<id>`, with real path segments. */
	root: string;
	tree: string;
	scratch: string;
	/** The sandbox's view of the primary workspace: a link to it (`policy`) or a bind mount point (`namespace`). */
	primary: string;
	/** The worktree's git dir: `<name>.git/worktrees/<id>`. */
	gitDir: string;
	workspace: string;
	rules: Rule[];
	/** The adapter's `metadata` paths at creation: hidden unless a rule says otherwise. */
	metadata: string[];
}

export const sandboxesDir = (repo: Repo): string => join(realPath(repo.ctx.store), `${repo.name}.sbx`);

function validateId(id: string): void {
	if (!ID.test(id) || id.endsWith(".lock") || RESERVED.has(id)) {
		throw precondition(
			`${JSON.stringify(id)} is not a sandbox id (letters, digits, . _ -; not ${[...RESERVED].join(", ")})`,
		);
	}
}

function layout(repo: Repo, id: string): Omit<Sandbox, "rules" | "metadata"> {
	const root = join(sandboxesDir(repo), id);
	return {
		repo,
		id,
		branch: `sbx/${id}`,
		root,
		tree: join(root, "tree"),
		scratch: join(root, "scratch"),
		primary: join(root, "primary"),
		gitDir: join(gitDirOf(repo.ctx, repo.name), "worktrees", id),
		workspace: repo.workspace,
	};
}

const policyFile = (root: string): string => join(root, "policy");

function configFile(repo: Repo, file: string, key: string): string[] {
	const result = git(repo, ["config", "--file", file, "--get-all", key], { allowFail: true });
	// 1 is "no such key"; anything else is a file git cannot read
	if (result.status > 1) throw failure(`${file}: ${result.stderr.trim() || "cannot read this git config file"}`);
	return result.status === 0 ? result.stdout.split("\n").filter((line) => line !== "") : [];
}

/** Open a sandbox that exists: its rules and metadata paths come from the snapshot taken at creation. */
export function loadSandbox(repo: Repo, id: string): Sandbox {
	validateId(id);
	const base = layout(repo, id);
	const file = policyFile(base.root);
	if (!existsSync(file) || !existsSync(base.tree)) throw precondition(`no sandbox ${repo.name}/${id}`);
	return {
		...base,
		rules: configFile(repo, file, "sandbox.rule").map((text) => parseRule(text, repo.workspace, file)),
		metadata: configFile(repo, file, "sandbox.metadata"),
	};
}

/** The sandbox that `XPI_SG_SANDBOX` (`<name>/<id>`) names, or undefined when the variable is not set. */
export function sandboxFromEnv(ctx: SgContext): Sandbox | undefined {
	const ref = ctx.env.XPI_SG_SANDBOX;
	if (!ref) return undefined;
	const [name, id, ...rest] = ref.split("/");
	if (!name || !id || rest.length > 0) throw precondition(`XPI_SG_SANDBOX=${ref}: expected <name>/<id>`);
	return loadSandbox(resolveRepo(ctx, name), id);
}

/** Run git as the sandbox: its own index, branch and work tree. */
export function sandboxGit(sbx: Sandbox, args: string[], options: { allowFail?: boolean } = {}) {
	return gitIn(
		sbx.repo.ctx,
		{ cwd: sbx.tree, env: { ...cleanEnv(sbx.repo.ctx.env), GIT_DIR: sbx.gitDir, GIT_WORK_TREE: sbx.tree } },
		args,
		options,
	);
}

/** A sandbox's directory that cannot be opened: its tree or policy is missing or unreadable. */
export interface BrokenSandbox {
	id: string;
	reason: string;
}

/** Every sandbox of a repo by id; one that cannot be opened is listed as broken instead of failing the rest. */
export function sandboxEntries(repo: Repo): (Sandbox | BrokenSandbox)[] {
	const dir = sandboxesDir(repo);
	if (!existsSync(dir)) return [];
	const found: (Sandbox | BrokenSandbox)[] = [];
	for (const id of readdirSync(dir).sort()) {
		if (!ID.test(id) || RESERVED.has(id) || !statSync(join(dir, id)).isDirectory()) continue;
		try {
			if (!existsSync(policyFile(join(dir, id)))) throw precondition("its policy file is missing");
			if (!existsSync(join(dir, id, "tree"))) throw precondition("its tree is missing");
			found.push(loadSandbox(repo, id));
		} catch (error) {
			found.push({ id, reason: (error as Error).message.split("\n")[0] });
		}
	}
	return found;
}

/** The sandboxes of a repo that can be opened. */
export const listSandboxes = (repo: Repo): Sandbox[] =>
	sandboxEntries(repo).filter((entry): entry is Sandbox => "root" in entry);

const branchExists = (repo: Repo, id: string): boolean =>
	git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/sbx/${id}`], { allowFail: true }).status === 0;

export interface CreateOptions {
	from?: string;
	profile?: string;
}

function readRules(repo: Repo, profile: string | undefined): { rules: Rule[]; source: string } {
	if (profile === undefined) {
		const source = "sandbox.rule";
		return { rules: configAll(repo, source).map((text) => parseRule(text, repo.workspace, source)), source };
	}
	const file = realPath(resolve(repo.ctx.cwd, profile));
	if (!existsSync(file)) throw precondition(`profile ${profile}: no such file`);
	return {
		rules: configFile(repo, file, "sandbox.rule").map((text) => parseRule(text, repo.workspace, file)),
		source: file,
	};
}

const MODES_THAT_NEED_NO_TRACKED = new Set<Mode>(["scratch", "hidden", "shared-rw"]);

/** A `scratch`, `hidden` or `shared-rw` rule over tracked files would hide the agent's own files, or leave them out of the share. */
function checkTracked(rules: Rule[], metadata: string[], tracked: string[]): void {
	const bad: string[] = [];
	const set = { rules, metadata };
	for (const path of tracked) {
		const mode = modeOf(set, true, path);
		if (mode && MODES_THAT_NEED_NO_TRACKED.has(mode)) {
			const rule = rules.filter((candidate) => candidate.ws && covers(candidate, path)).at(-1);
			bad.push(`  ${path}  (${rule ? ruleText(rule) : "metadata path (hidden)"})`);
		}
	}
	if (bad.length > 0) {
		throw precondition(
			`sandbox rules cover files the shadow repo tracks (${bad.length}); they are the agent's own files, so a scratch, hidden or shared-rw rule cannot cover them:\n${bad.slice(0, 10).join("\n")}${bad.length > 10 ? `\n  ... and ${bad.length - 10} more` : ""}`,
		);
	}
}

function checkRules(rules: Rule[], source: string): void {
	for (const rule of rules) {
		if (rule.mode !== "scratch") continue;
		if (!rule.ws) throw precondition(`${source}: ${ruleText(rule)}: a scratch path has to be under @ws`);
		if (rule.path === "")
			throw precondition(`${source}: ${ruleText(rule)}: scratch cannot cover the whole workspace`);
	}
}

/** Create the worktree on `sbx/<id>`, the scratch area, `primary` and the links. */
export function createSandbox(repo: Repo, id: string, options: CreateOptions): Sandbox {
	assertNoImport(repo, "sbx create");
	validateId(id);
	const base = layout(repo, id);
	if (existsSync(base.root)) throw precondition(`sandbox ${repo.name}/${id} exists already`);
	if (branchExists(repo, id))
		throw precondition(`branch sbx/${id} exists already (a removed sandbox keeps its branch)`);
	const from = options.from ?? "main";
	if (git(repo, ["rev-parse", "--verify", "--quiet", `${from}^{commit}`], { allowFail: true }).status !== 0) {
		throw precondition(`--from ${from}: no such commit or branch`);
	}
	const { rules, source } = readRules(repo, options.profile);
	checkRules(rules, source);
	const metadata = lines(callAdapter(repo, "metadata")).map((line) =>
		line
			.trim()
			.replace(/^\.\/+/, "")
			.replace(/\/+$/, ""),
	);
	const tracked = git(repo, ["ls-tree", "-r", "-z", "--name-only", from]).stdout.split("\0").filter(Boolean);
	checkTracked(rules, metadata, tracked);

	if (existsSync(base.gitDir)) git(repo, ["worktree", "prune"]);
	if (existsSync(base.gitDir)) throw precondition(`${base.gitDir} exists already; run xpi sg worktree prune`);
	const sbx: Sandbox = { ...base, rules, metadata };
	try {
		mkdirSync(base.root, { recursive: true, mode: 0o700 });
		const file = policyFile(base.root);
		writeFileSync(file, "");
		for (const rule of rules) git(repo, ["config", "--file", file, "--add", "sandbox.rule", ruleText(rule)]);
		for (const path of metadata) git(repo, ["config", "--file", file, "--add", "sandbox.metadata", path]);
		// git names a worktree after its directory's last part, so it is added as `<root>/<id>` and moved to `tree`.
		const stage = join(base.root, id);
		git(repo, ["worktree", "add", "-q", "-b", base.branch, stage, from]);
		git(repo, ["worktree", "move", stage, base.tree]);
		if (!existsSync(base.gitDir)) throw failure(`git did not name the worktree ${id}; ${base.gitDir} is missing`);
		git(repo, [
			"config",
			"--file",
			join(base.gitDir, "config.worktree"),
			"core.excludesFile",
			join(base.root, "excludes"),
		]);
		mkdirSync(base.scratch, { recursive: true });
		const backend = resolveBackend(repo, true);
		refreshTree(sbx, backend);
	} catch (error) {
		discard(sbx);
		git(repo, ["branch", "-D", base.branch], { allowFail: true });
		throw error;
	}
	return sbx;
}

function discard(sbx: Sandbox): void {
	if (existsSync(sbx.tree)) git(sbx.repo, ["worktree", "remove", "--force", sbx.tree], { allowFail: true });
	rmSync(sbx.root, { recursive: true, force: true });
	git(sbx.repo, ["worktree", "prune"], { allowFail: true });
}

/** What the sandbox has not committed: changed files and untracked files that are not ignored. */
export const changedFiles = (sbx: Sandbox): string[] =>
	sandboxGit(sbx, ["status", "--porcelain", "-z", "--no-renames"]).stdout.split("\0").filter(Boolean);

/**
 * Remove the worktree and scratch. The branch `sbx/<id>` stays. Uncommitted work stops it (exit 2) unless `force`.
 * A sandbox that cannot be opened is removed with `force`.
 */
export function removeSandbox(repo: Repo, id: string, force: boolean): void {
	validateId(id);
	let sbx: Sandbox;
	try {
		sbx = loadSandbox(repo, id);
	} catch (error) {
		if (!force || !existsSync(layout(repo, id).root)) throw error;
		discard({ ...layout(repo, id), rules: [], metadata: [] });
		return;
	}
	if (!force) {
		const changed = changedFiles(sbx);
		if (changed.length > 0) {
			throw precondition(
				`sandbox ${repo.name}/${id} has ${changed.length} uncommitted change(s); commit them, or use xpi sg sbx rm ${id} --force`,
			);
		}
	}
	discard(sbx);
}

// ---- the tree ----

const MANIFEST = "links";

type Kind = "l" | "m";

function readManifest(sbx: Sandbox): Map<string, Kind> {
	const found = new Map<string, Kind>();
	const file = join(sbx.root, MANIFEST);
	if (!existsSync(file)) return found;
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (line.length > 2) found.set(line.slice(2), line[0] === "m" ? "m" : "l");
	}
	return found;
}

/** Whether a directory holds anything but directories and the links this tool made: the agent's own files. */
function hasRealFiles(dir: string, base: string, ours: Map<string, Kind>): boolean {
	for (const entry of readdirSync(join(dir, base), { withFileTypes: true })) {
		const path = base === "" ? entry.name : `${base}/${entry.name}`;
		if (entry.isDirectory() ? hasRealFiles(dir, path, ours) : !ours.has(path)) return true;
	}
	return false;
}

const ignoreLine = (path: string): string => `/${path.replace(/[\\*?[\]]/g, "\\$&").replace(/ $/, "\\ ")}`;

interface Want {
	kind: Kind;
	/** For a link, where it points. */
	target?: string;
}

/**
 * Bring the tree's links up to date: the untracked, not-hidden entries of the primary workspace, `scratch` paths and
 * `shared-rw` paths. A directory with no tracked files below it becomes one link. They are listed in the sandbox's own
 * excludes file, so they never show in its `git status`. Links that are right stay as they are, so a command already
 * running in the sandbox never sees one vanish. The caller holds the sandbox's lock (`refreshLocked`). Returns the
 * number of links.
 */
export function refreshTree(sbx: Sandbox, backend: Backend): number {
	const ws = sbx.workspace;
	const old = readManifest(sbx);
	const wanted = new Map<string, Want>();

	// the shadow repo's hooks directory has to exist for the namespace to make it read-only
	mkdirSync(join(gitDirOf(sbx.repo.ctx, sbx.repo.name), "hooks"), { recursive: true });

	// primary: a link to the workspace, or an empty mount point
	const primary = sbx.primary;
	try {
		const stat = lstatSync(primary);
		if (backend === "policy" && !(stat.isSymbolicLink() && readlinkSync(primary) === ws)) {
			rmSync(primary, { recursive: false, force: true });
		}
		if (backend === "namespace" && stat.isSymbolicLink()) unlinkSync(primary);
	} catch {}
	if (backend === "policy") {
		if (!existsSync(primary)) symlinkSync(ws, primary);
	} else mkdirSync(primary, { recursive: true });

	const trackedFiles = new Set(sandboxGit(sbx, ["ls-files", "-z"]).stdout.split("\0").filter(Boolean));
	const trackedDirs = new Set<string>();
	for (const file of trackedFiles) {
		for (let dir = dirname(file); dir !== "." && !trackedDirs.has(dir); dir = dirname(dir)) trackedDirs.add(dir);
	}
	// A directory with a rule below it that is not the default has to be a real directory in the tree.
	const ruleDirs = new Set<string>();
	const note = (path: string): void => {
		for (let dir = dirname(path); dir !== "."; dir = dirname(dir)) ruleDirs.add(dir);
	};
	for (const rule of sbx.rules) if (rule.ws && rule.mode !== "shared-ro") note(rule.path);
	for (const path of sbx.metadata) note(path);

	const treeHasReal = (path: string): boolean => {
		try {
			return lstatSync(join(sbx.tree, path)).isDirectory() && hasRealFiles(sbx.tree, path, old);
		} catch {
			return false;
		}
	};

	const walk = (rel: string): void => {
		for (const entry of readdirSync(join(ws, rel), { withFileTypes: true })) {
			const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
			if ((rel === "" && entry.name === ".git") || entry.name.includes("\n")) continue;
			const mode = modeOf(sbx, true, path);
			if (mode === "hidden" || mode === "private" || mode === "scratch" || mode === "shared-rw") continue;
			if (trackedFiles.has(path)) continue;
			if (entry.isDirectory() && (trackedDirs.has(path) || ruleDirs.has(path) || treeHasReal(path))) {
				mkdirSync(join(sbx.tree, path), { recursive: true });
				walk(path);
			} else wanted.set(path, { kind: "l", target: join(sbx.primary, path) });
		}
	};
	walk("");

	for (const rule of sbx.rules) {
		if (!rule.ws || rule.path === "") continue;
		if (rule.mode === "scratch") {
			mkdirSync(join(sbx.scratch, rule.path), { recursive: true });
			wanted.set(rule.path, { kind: "l", target: join(sbx.scratch, rule.path) });
		} else if (rule.mode === "shared-rw" && existsSync(join(ws, rule.path))) {
			wanted.set(rule.path, backend === "policy" ? { kind: "l", target: join(ws, rule.path) } : { kind: "m" });
		}
	}

	// Links no longer wanted go; the rest are made if they are not there already.
	for (const [path, kind] of old) {
		if (wanted.get(path)?.kind === kind) continue;
		const at = join(sbx.tree, path);
		try {
			const stat = lstatSync(at);
			if (kind === "l" && stat.isSymbolicLink()) unlinkSync(at);
			else if (kind === "m" && stat.isDirectory()) rmdirSync(at);
			else if (kind === "m" && stat.isFile() && stat.size === 0) unlinkSync(at);
		} catch {}
	}
	const made = new Map<string, Kind>();
	for (const [path, want] of wanted) {
		const at = join(sbx.tree, path);
		if (want.kind === "m") {
			mkdirSync(dirname(at), { recursive: true });
			if (lstatSync(join(ws, path)).isDirectory()) mkdirSync(at, { recursive: true });
			else if (!existsSync(at)) writeFileSync(at, "");
			made.set(path, "m");
			continue;
		}
		if (placeLink(at, want.target ?? "", old, path)) made.set(path, "l");
	}

	writeFileSync(
		join(sbx.root, MANIFEST),
		[...made].map(([path, kind]) => `${kind} ${path}`).join("\n") + (made.size > 0 ? "\n" : ""),
	);
	writeFileSync(
		join(sbx.root, "excludes"),
		`# shadow-git: links and mount points in the sandbox tree\n${[...made.keys()].map(ignoreLine).join("\n")}${made.size > 0 ? "\n" : ""}`,
	);
	return [...made.values()].filter((kind) => kind === "l").length;
}

/** Make the link `at` -> `target` unless it is right already. A real file or a directory with the agent's files stays. */
function placeLink(at: string, target: string, ours: Map<string, Kind>, path: string): boolean {
	try {
		const stat = lstatSync(at);
		if (stat.isSymbolicLink()) {
			if (readlinkSync(at) === target) return true;
			if (!ours.has(path)) return false; // the agent's own link
			unlinkSync(at);
		} else if (stat.isDirectory() && !hasRealFiles(dirname(at), basename(at), ours)) {
			rmSync(at, { recursive: true, force: true });
		} else return false;
	} catch {}
	mkdirSync(dirname(at), { recursive: true });
	try {
		symlinkSync(target, at);
	} catch (error) {
		// another refresh made it first
		if ((error as NodeJS.ErrnoException).code !== "EEXIST" || readlinkSync(at) !== target) throw error;
	}
	return true;
}

const lockOf = (sbx: Sandbox): string => join(sbx.root, "lock");

/** `refreshTree` under the sandbox's lock, so two `sbx run` of one sandbox do not race. */
export function refreshLocked(sbx: Sandbox, backend: Backend): Promise<number> {
	return withLock(sbx.repo.ctx, lockOf(sbx), () => refreshTree(sbx, backend));
}

// ---- run ----

export async function runInSandbox(repo: Repo, id: string, cmd: string[]): Promise<number> {
	const ctx = repo.ctx;
	if (ctx.env.XPI_SG_SANDBOX)
		throw precondition("sandboxes do not nest: xpi sg sbx run is not available inside a sandbox");
	if (cmd.length === 0) throw precondition("usage: xpi sg sbx run <id> -- <command> [args]");
	const sbx = loadSandbox(repo, id);
	const backend = resolveBackend(repo, true);
	await refreshLocked(sbx, backend);
	// These always replace what the parent passed down.
	const env: NodeJS.ProcessEnv = {
		...cleanEnv(ctx.env),
		XPI_SG_STORE: realPath(ctx.store),
		XPI_SG_SANDBOX: `${repo.name}/${id}`,
		XPI_SG_BACKEND: backend,
		GIT_DIR: sbx.gitDir,
		GIT_WORK_TREE: backend === "namespace" ? repo.workspace : sbx.tree,
	};
	const stdio = ctx.stdio === "inherit" ? "inherit" : "pipe";
	const result =
		backend === "namespace"
			? ((command) => run(command.file, command.args, { cwd: "/", env, stdio }))(namespaceCommand(ctx, sbx, cmd))
			: run(cmd[0], cmd.slice(1), { cwd: sbx.tree, env, stdio });
	if (stdio === "pipe") {
		ctx.out(result.stdout);
		ctx.err(result.stderr);
	}
	if (result.spawnError) throw failure(`cannot run ${cmd[0]}: ${result.spawnError.message}`);
	return result.status;
}

// ---- ls ----

export function describeSandbox(sbx: Sandbox, backend: string): string {
	const ahead = git(sbx.repo, ["rev-list", "--count", `main..${sbx.branch}`], { allowFail: true });
	const changed = changedFiles(sbx).length;
	return `${sbx.id}  ${sbx.branch}  ${ahead.status === 0 ? ahead.stdout.trim() : "?"} commit(s) ahead of main  ${changed} changed file(s)  backend ${backend}`;
}

/** The backend the sandboxes of this repo would use now, as text, without failing. */
export function backendLabel(repo: Repo): string {
	const want = configGet(repo, "sandbox.backend") ?? "auto";
	if (want === "policy") return "policy";
	if (want !== "namespace" && want !== "auto") return want;
	if (probeNamespace(repo.ctx).ok) return "namespace";
	return want === "auto" && configGet(repo, "sandbox.require") !== "namespace" ? "policy" : "unavailable";
}

/** One line per sandbox for `sbx ls` and `status`. A sandbox that cannot be opened says why instead of failing the rest. */
export function listText(repo: Repo): string[] {
	const entries = sandboxEntries(repo);
	if (entries.length === 0) return [];
	const backend = backendLabel(repo);
	return entries.map((entry) => {
		if (!("root" in entry)) return `${entry.id}  broken: ${entry.reason}`;
		try {
			return describeSandbox(entry, backend);
		} catch (error) {
			return `${entry.id}  broken: ${(error as Error).message.split("\n")[0]}`;
		}
	});
}
