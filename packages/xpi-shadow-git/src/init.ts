import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callAdapter, findAdapter, lines } from "./adapter.ts";
import { AGENTS_MD_FILE, AGENTS_MD_TEMPLATE } from "./agents-md.ts";
import { localOnlySpecs, scopeOf } from "./config.ts";
import type { SgContext } from "./context.ts";
import { precondition } from "./errors.ts";
import { git, splitZ } from "./git.ts";
import { withLock } from "./lock.ts";
import { appendRegistry, gitDirOf, NAME, nestedEntries, type Repo, realPath, removeRegistry } from "./registry.ts";

export interface InitOptions {
	name: string;
	adapter: string;
	scope: string[];
	localOnly: string[];
	/** Extra `key=value` settings written to the shadow repo's config before the adapter runs. */
	config: string[];
	/** Write the opt-in `.git` file into the workspace (`shadow.gitfile`). */
	gitfile: boolean;
	/** Write the AGENTS.md template into the workspace as a local-only file, committed on main (never on host). */
	agentsMd?: boolean;
}

const NO_SPACE = /^\S+$/;

function checkPaths(what: string, values: string[]): void {
	for (const value of values) {
		if (!NO_SPACE.test(value) || value.startsWith("/") || value.startsWith(":") || value.split("/").includes("..")) {
			throw precondition(
				`${what} ${JSON.stringify(value)}: a path or glob relative to the workspace, with no spaces or ..`,
			);
		}
	}
}

function validate(ctx: SgContext, workspace: string, options: InitOptions): void {
	if (!NAME.test(options.name))
		throw precondition(`${JSON.stringify(options.name)} is not a repo name (letters, digits, . _ -)`);
	if (/[\t\n]/.test(workspace)) throw precondition("the workspace path has a tab or a newline in it");
	checkPaths("scope", options.scope);
	checkPaths("local-only glob", options.localOnly);
	for (const setting of options.config) {
		if (!/^[A-Za-z][A-Za-z0-9.-]*\.[A-Za-z][A-Za-z0-9]*=/.test(setting)) {
			throw precondition(`--config ${JSON.stringify(setting)}: expected <section.key>=<value>`);
		}
	}
	findAdapter(ctx, options.adapter);
	const nested = nestedEntries(ctx, workspace);
	if (nested.length > 0) {
		const first = nested[0];
		throw precondition(
			`${workspace} overlaps the registered workspace ${first.path} (${first.name}); registrations do not nest`,
		);
	}
	if (existsSync(gitDirOf(ctx, options.name))) {
		throw precondition(`${gitDirOf(ctx, options.name)} exists already; pick another name`);
	}
	if (options.agentsMd && existsSync(join(workspace, AGENTS_MD_FILE))) {
		throw precondition(
			`${join(workspace, AGENTS_MD_FILE)} exists: --agents-md would replace it (print the template with "xpi sg agents-md")`,
		);
	}
	if (options.gitfile && existsSync(join(workspace, ".git"))) {
		throw precondition(`${join(workspace, ".git")} exists: --gitfile would replace it`);
	}
}

const excludeLine = (path: string): string => `/${path.replace(/^\.?\/+/, "").replace(/\/+$/, "")}`;

/**
 * Register the cwd as a workspace. Nothing is written into it (the opt-in `.git` file aside): the shadow repo, its
 * excludes and its config are in the store.
 */
export async function initRepo(ctx: SgContext, options: InitOptions): Promise<Repo> {
	const workspace = realPath(ctx.cwd);
	if (!statSync(workspace).isDirectory()) throw precondition(`${workspace} is not a directory`);
	mkdirSync(ctx.store, { recursive: true, mode: 0o700 });
	return withLock(ctx, join(ctx.store, "registry.lock"), async () => {
		validate(ctx, workspace, options);
		const repo: Repo = { ctx, name: options.name, workspace, gitDir: gitDirOf(ctx, options.name) };
		try {
			return populate(repo, options);
		} catch (error) {
			// Each step on its own: one failing (the store's own I/O, say) must not keep the others from running.
			const undo = (step: () => void): void => {
				try {
					step();
				} catch {}
			};
			// validate() refused an existing AGENTS.md, so one holding the template now is this run's own
			const agentsMd = join(workspace, AGENTS_MD_FILE);
			undo(() => {
				if (options.agentsMd && existsSync(agentsMd) && readFileSync(agentsMd, "utf8") === AGENTS_MD_TEMPLATE) {
					rmSync(agentsMd, { force: true });
				}
			});
			undo(() => rmSync(repo.gitDir, { recursive: true, force: true }));
			undo(() => removeRegistry(ctx, repo.name));
			throw error;
		}
	});
}

function populate(repo: Repo, options: InitOptions): Repo {
	git(repo, ["init", "-q"]);
	// `core.worktree` goes to config.worktree of the main worktree, so linked worktrees (sandboxes) keep their own.
	git(repo, ["config", "--unset", "core.worktree"], { allowFail: true });
	git(repo, ["config", "core.bare", "false"]);
	git(repo, ["config", "core.repositoryformatversion", "1"]);
	git(repo, ["config", "extensions.worktreeConfig", "true"]);
	git(repo, ["config", "--worktree", "core.worktree", repo.workspace]);
	git(repo, ["symbolic-ref", "HEAD", "refs/heads/host"]);
	if (git(repo, ["config", "--get", "user.email"], { allowFail: true }).status !== 0) {
		git(repo, ["config", "user.name", "shadow-git"]);
		git(repo, ["config", "user.email", "shadow-git@localhost"]);
	}
	git(repo, ["config", "shadow.adapter", options.adapter]);
	if (options.scope.length > 0) git(repo, ["config", "shadow.scope", options.scope.join(" ")]);
	const localOnly =
		options.agentsMd && !options.localOnly.includes(AGENTS_MD_FILE)
			? [...options.localOnly, AGENTS_MD_FILE]
			: options.localOnly;
	for (const glob of localOnly) git(repo, ["config", "--add", "shadow.localOnly", glob]);
	for (const setting of options.config) {
		const at = setting.indexOf("=");
		git(repo, ["config", setting.slice(0, at), setting.slice(at + 1)]);
	}
	git(repo, ["config", "shadow.gitfile", options.gitfile ? "true" : "false"]);

	const exclude = join(repo.gitDir, "info", "exclude");
	mkdirSync(join(repo.gitDir, "info"), { recursive: true });
	const own = [...lines(callAdapter(repo, "excludes")), ...lines(callAdapter(repo, "metadata")).map(excludeLine)];
	if (options.gitfile) own.push("/.git");
	const old = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
	writeFileSync(
		exclude,
		`${old}${old.endsWith("\n") || old === "" ? "" : "\n"}# shadow-git: adapter excludes and host VCS metadata\n${own.join("\n")}\n`,
	);

	callAdapter(repo, "prepare");
	baseline(repo);
	git(repo, ["commit", "-q", "--allow-empty", "-m", "sg: baseline"]);
	git(repo, ["checkout", "-q", "-b", "main"]);
	// The template lands on main only: host stays the host's state, and the file is local-only, so never exported.
	if (options.agentsMd) {
		writeFileSync(join(repo.workspace, AGENTS_MD_FILE), AGENTS_MD_TEMPLATE);
		// -f: a workspace .gitignore or the adapter's excludes may match AGENTS.md
		git(repo, ["add", "-f", "--", `:(literal)${AGENTS_MD_FILE}`]);
		git(repo, ["commit", "-q", "-m", "sg: add AGENTS.md (local-only)"]);
	}
	if (options.gitfile) writeFileSync(join(repo.workspace, ".git"), `gitdir: ${repo.gitDir}\n`);
	appendRegistry(repo.ctx, { path: repo.workspace, name: repo.name });
	return repo;
}

// `git add` fails on a pathspec that matches nothing, and a scope path or a local-only glob may match nothing yet.
function baseline(repo: Repo): void {
	const scope = scopeOf(repo);
	const specs =
		scope.length === 0
			? ["."]
			: scope
					.filter((path) => existsSync(join(repo.workspace, path)))
					.map((path) => `:(literal)${path.replace(/\/+$/, "")}`);
	const localOnly = localOnlySpecs(repo);
	if (localOnly.length > 0) {
		const found = splitZ(git(repo, ["ls-files", "-o", "--exclude-standard", "-z", "--", ...localOnly]).stdout);
		specs.push(...found.map((path) => `:(literal)${path}`));
	}
	if (specs.length > 0) git(repo, ["add", "-A", "--", ...specs]);
}
