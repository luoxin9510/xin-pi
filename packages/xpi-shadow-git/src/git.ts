import type { SgContext } from "./context.ts";
import { failure, precondition } from "./errors.ts";
import { type RunResult, run } from "./proc.ts";
import type { Repo } from "./registry.ts";

export const MIN_GIT = [2, 20] as const;

// Variables that would point git at another repository than the one a command means.
const REPO_VARIABLES = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_COMMON_DIR",
	"GIT_PREFIX",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_NAMESPACE",
];

/** The environment without any repository selection. */
export function cleanEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const clean = { ...env };
	for (const name of REPO_VARIABLES) delete clean[name];
	return clean;
}

/** The environment that makes git work on the shadow repo. */
export function repoEnv(repo: Repo): NodeJS.ProcessEnv {
	return { ...cleanEnv(repo.ctx.env), GIT_DIR: repo.gitDir, GIT_WORK_TREE: repo.workspace };
}

const checked = new Set<string>();

/** Exit 2 unless the configured git is at least 2.20. Checked once per binary and process. */
export function checkGitVersion(ctx: SgContext): void {
	if (checked.has(ctx.git)) return;
	const result = run(ctx.git, ["--version"], { cwd: ctx.cwd, env: cleanEnv(ctx.env) });
	if (result.spawnError) {
		throw precondition(
			`cannot run git (${ctx.git}): ${result.spawnError.message}. Set XPI_SG_GIT to a git 2.20 or newer.`,
		);
	}
	const match = /git version (\d+)\.(\d+)/.exec(result.stdout);
	const major = Number(match?.[1]);
	const minor = Number(match?.[2]);
	if (!match || major < MIN_GIT[0] || (major === MIN_GIT[0] && minor < MIN_GIT[1])) {
		throw precondition(
			`${ctx.git} reports "${result.stdout.trim()}"; shadow-git needs git ${MIN_GIT.join(".")} or newer. Set XPI_SG_GIT to one.`,
		);
	}
	checked.add(ctx.git);
}

export interface GitOptions {
	input?: string;
	/** Return a non-zero exit instead of failing the command. */
	allowFail?: boolean;
}

// Internal commits and merges ignore the user's hooks and signing settings.
const INTERNAL = ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "merge.autoEdit=no"];

/** Run git with a chosen working directory and environment. A non-zero exit fails with git's stderr (exit 1). */
export function gitIn(
	ctx: SgContext,
	where: { cwd: string; env: NodeJS.ProcessEnv },
	args: string[],
	options: GitOptions = {},
): RunResult {
	const result = run(ctx.git, [...INTERNAL, ...args], { cwd: where.cwd, env: where.env, input: options.input });
	if (result.status !== 0 && !options.allowFail) {
		throw failure(result.stderr.trim() || result.stdout.trim() || `git ${args[0]} failed (exit ${result.status})`);
	}
	return result;
}

/** Run git on the shadow repo from the workspace root. */
export function git(repo: Repo, args: string[], options: GitOptions = {}): RunResult {
	return gitIn(repo.ctx, { cwd: repo.workspace, env: repoEnv(repo) }, args, options);
}

/** NUL-separated output as a list. */
export const splitZ = (text: string): string[] => text.split("\0").filter((entry) => entry !== "");
