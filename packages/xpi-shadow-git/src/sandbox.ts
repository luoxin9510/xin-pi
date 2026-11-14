import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmdirSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { callAdapter, lines } from "./adapter.ts";
import { type Backend, namespaceCommand, probeNamespace, resolveBackend } from "./backend.ts";
import { assertNoImport, configAll, configGet } from "./config.ts";
import type { SgContext } from "./context.ts";
import { failure, precondition } from "./errors.ts";
import { cleanEnv, git, gitIn } from "./git.ts";
import { run } from "./proc.ts";
import { gitDirOf, type Repo, realPath, resolveRepo } from "./registry.ts";
import { covers, type Mode, modeOf, parseRule, type Rule, ruleText } from "./rules.ts";

export const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// Names inside a sandbox's directory
const RESERVED = new Set(["tree", "scratch", "primary", "policy", "links", "excludes"]);

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

/** The sandboxes of a repo, by id. */
export function listSandboxes(repo: Repo): Sandbox[] {
	const dir = sandboxesDir(repo);
	if (!existsSync(dir)) return [];
	const found: Sandbox[] = [];
	for (const id of readdirSync(dir).sort()) {
		if (!ID.test(id) || !existsSync(policyFile(join(dir, id)))) continue;
		found.push(loadSandbox(repo, id));
	}
	return found;
}

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
			bad.push(`  ${path}  (${rule ? ruleText(rule) : `hidden: host metadata ${mode}`})`);
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

/** Remove the worktree and scratch. The branch `sbx/<id>` stays. Uncommitted work stops it (exit 2) unless `force`. */
export function removeSandbox(repo: Repo, id: string, force: boolean): void {
	const sbx = loadSandbox(repo, id);
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

function readManifest(sbx: Sandbox): { kind: "l" | "m"; path: string }[] {
	const file = join(sbx.root, MANIFEST);
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line.length > 2)
		.map((line) => ({ kind: line[0] === "m" ? "m" : "l", path: line.slice(2) }));
}

function dropManifest(sbx: Sandbox): void {
	for (const entry of readManifest(sbx).reverse()) {
		const at = join(sbx.tree, entry.path);
		try {
			const stat = lstatSync(at);
			if (entry.kind === "l" && stat.isSymbolicLink()) unlinkSync(at);
			else if (entry.kind === "m" && stat.isDirectory()) rmdirSync(at);
			else if (entry.kind === "m" && stat.isFile() && stat.size === 0) unlinkSync(at);
		} catch {}
	}
}

/** Whether a directory holds anything but directories: files or links of the agent's own. */
function hasRealFiles(dir: string): boolean {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (!entry.isDirectory() || hasRealFiles(join(dir, entry.name))) return true;
	}
	return false;
}

const ignoreLine = (path: string): string => `/${path.replace(/[\\*?[\]]/g, "\\$&").replace(/ $/, "\\ ")}`;

/**
 * Bring the tree's links up to date: the untracked, not-hidden entries of the primary workspace, `scratch` paths and
 * `shared-rw` paths. A directory with no tracked files below it becomes one link. They are listed in the sandbox's own
 * excludes file, so they never show in its `git status`. Returns the number of links.
 */
export function refreshTree(sbx: Sandbox, backend: Backend): number {
	const ws = sbx.workspace;
	dropManifest(sbx);
	const kinds = new Map<string, "l" | "m">();

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

	const place = (path: string, target: string): void => {
		const at = join(sbx.tree, path);
		try {
			if (lstatSync(at).isSymbolicLink()) unlinkSync(at);
			else if (lstatSync(at).isDirectory() && !hasRealFiles(at)) rmSync(at, { recursive: true, force: true });
			else return;
		} catch {}
		mkdirSync(dirname(at), { recursive: true });
		symlinkSync(target, at);
		kinds.set(path, "l");
	};

	const walk = (rel: string): void => {
		for (const entry of readdirSync(join(ws, rel), { withFileTypes: true })) {
			const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
			if ((rel === "" && entry.name === ".git") || entry.name.includes("\n")) continue;
			const mode = modeOf(sbx, true, path);
			if (mode === "hidden" || mode === "private" || mode === "scratch" || mode === "shared-rw") continue;
			if (trackedFiles.has(path)) continue;
			const at = join(sbx.tree, path);
			const real = entry.isDirectory() && (trackedDirs.has(path) || ruleDirs.has(path) || treeHasReal(at));
			if (real) {
				mkdirSync(at, { recursive: true });
				walk(path);
			} else place(path, join(sbx.primary, path));
		}
	};
	walk("");

	for (const rule of sbx.rules) {
		if (!rule.ws || rule.path === "") continue;
		if (rule.mode === "scratch") {
			mkdirSync(join(sbx.scratch, rule.path), { recursive: true });
			place(rule.path, join(sbx.scratch, rule.path));
		} else if (rule.mode === "shared-rw" && existsSync(join(ws, rule.path))) {
			if (backend === "policy") place(rule.path, join(ws, rule.path));
			else {
				const at = join(sbx.tree, rule.path);
				mkdirSync(dirname(at), { recursive: true });
				if (lstatSync(join(ws, rule.path)).isDirectory()) mkdirSync(at, { recursive: true });
				else if (!existsSync(at)) writeFileSync(at, "");
				kinds.set(rule.path, "m");
			}
		}
	}

	writeFileSync(
		join(sbx.root, MANIFEST),
		[...kinds].map(([path, kind]) => `${kind} ${path}`).join("\n") + (kinds.size > 0 ? "\n" : ""),
	);
	writeFileSync(
		join(sbx.root, "excludes"),
		`# shadow-git: links and mount points in the sandbox tree\n${[...kinds.keys()].map(ignoreLine).join("\n")}${kinds.size > 0 ? "\n" : ""}`,
	);
	return [...kinds.values()].filter((kind) => kind === "l").length;
}

function treeHasReal(at: string): boolean {
	try {
		return lstatSync(at).isDirectory() && hasRealFiles(at);
	} catch {
		return false;
	}
}

// ---- run ----

export function runInSandbox(repo: Repo, id: string, cmd: string[]): number {
	const ctx = repo.ctx;
	if (ctx.env.XPI_SG_SANDBOX)
		throw precondition("sandboxes do not nest: xpi sg sbx run is not available inside a sandbox");
	if (cmd.length === 0) throw precondition("usage: xpi sg sbx run <id> -- <command> [args]");
	const sbx = loadSandbox(repo, id);
	const backend = resolveBackend(repo, true);
	refreshTree(sbx, backend);
	// These always replace what the parent passed down.
	const env: NodeJS.ProcessEnv = {
		...cleanEnv(ctx.env),
		XPI_SG_STORE: ctx.store,
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
	try {
		if (want === "policy") return "policy";
		if (want === "namespace" || want === "auto") {
			const probe = probeNamespace(repo.ctx);
			if (probe.ok) return "namespace";
			if (want === "auto" && configGet(repo, "sandbox.require") !== "namespace") return "policy";
			return "unavailable";
		}
	} catch {}
	return want;
}

export function listText(repo: Repo): string[] {
	const sandboxes = listSandboxes(repo);
	if (sandboxes.length === 0) return [];
	const backend = backendLabel(repo);
	return sandboxes.map((sbx) => describeSandbox(sbx, backend));
}
