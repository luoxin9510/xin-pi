import { createContext, type SgContext, type SgOptions } from "./context.ts";
import { precondition, SgError } from "./errors.ts";
import { checkGitVersion, repoEnv } from "./git.ts";
import { initRepo } from "./init.ts";
import { run } from "./proc.ts";
import { type Repo, readRegistry, resolveRepo } from "./registry.ts";
import { status } from "./status.ts";
import { abortImport, asWriter, exportMain, importHost, mergeBranch } from "./sync.ts";

const HELP = `Usage: xpi sg [--repo <name>] <command>

  init <name> --adapter <a> [--scope <paths>] [--local-only <glob>...] [--config <key>=<value>] [--gitfile]
                    Register the current directory as a workspace
  import [--abort]  Bring host changes into the host branch and merge them into main; resume or abort a stopped one
  export            Print the export plan (host..main)
  export --apply    Check the plan in through the adapter and advance host
  status            git status, commits ahead of host, the adapter's summary
  env               Print GIT_DIR and GIT_WORK_TREE as shell exports
  list              Print the registered workspaces
  merge <branch>    Merge a branch into main (merge --continue and --abort go to git)
  <git command>     Anything else runs git on the shadow repo

push, fetch, pull, clone, remote and submodule are not available: the shadow repo is local.
Exit codes: 0 success, 1 a git or adapter failure, 2 a failed precondition.
`;

const BLOCKED = new Set(["push", "fetch", "pull", "clone", "remote", "submodule"]);

function takeFlags(args: string[], flags: string[]): Set<string> {
	const found = new Set<string>();
	for (const arg of args) {
		if (!flags.includes(arg)) throw precondition(`unknown argument ${arg}`);
		found.add(arg);
	}
	return found;
}

function parseInit(args: string[]): Parameters<typeof initRepo>[1] {
	const [name, ...rest] = args;
	if (!name || name.startsWith("--"))
		throw precondition("usage: xpi sg init <name> --adapter <a> [--scope <paths>] [--local-only <glob>...]");
	let adapter: string | undefined;
	let scope: string[] = [];
	const localOnly: string[] = [];
	const config: string[] = [];
	let gitfile = false;
	for (let at = 0; at < rest.length; at++) {
		const flag = rest[at];
		const value = (): string => {
			const next = rest[++at];
			if (next === undefined) throw precondition(`${flag} needs a value`);
			return next;
		};
		if (flag === "--adapter") adapter = value();
		else if (flag === "--scope") scope = value().split(/\s+/).filter(Boolean);
		else if (flag === "--config") config.push(value());
		else if (flag === "--gitfile") gitfile = true;
		else if (flag === "--local-only") {
			localOnly.push(value());
			while (rest[at + 1] !== undefined && !rest[at + 1].startsWith("--")) localOnly.push(rest[++at]);
		} else throw precondition(`unknown argument ${flag}`);
	}
	if (!adapter) throw precondition("init needs --adapter <name>");
	return { name, adapter, scope, localOnly, config, gitfile };
}

// git's global options that take a separate value
const GLOBAL_WITH_VALUE = new Set([
	"-c",
	"-C",
	"--git-dir",
	"--work-tree",
	"--namespace",
	"--exec-path",
	"--config-env",
	"--super-prefix",
]);

/** The git command in `args`, after git's global options (`-c k=v`, `-C dir`, `--git-dir=x`, ...). A guard rail, not enforcement. */
export function gitCommandWord(args: string[]): string | undefined {
	for (let at = 0; at < args.length; at++) {
		const arg = args[at];
		if (!arg.startsWith("-")) return arg;
		if (GLOBAL_WITH_VALUE.has(arg)) at++;
	}
	return undefined;
}

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

function passThrough(repo: Repo, args: string[]): number {
	const result = run(repo.ctx.git, args, {
		cwd: repo.ctx.cwd,
		env: repoEnv(repo),
		stdio: repo.ctx.stdio === "inherit" ? "inherit" : "pipe",
	});
	if (repo.ctx.stdio === "capture") {
		repo.ctx.out(result.stdout);
		repo.ctx.err(result.stderr);
	}
	return result.status;
}

async function dispatch(ctx: SgContext, args: string[]): Promise<number> {
	let repoName: string | undefined;
	let rest = args;
	if (rest[0] === "--repo") {
		repoName = rest[1];
		if (!repoName) throw precondition("--repo needs a name");
		rest = rest.slice(2);
	} else if (rest[0]?.startsWith("--repo=")) {
		repoName = rest[0].slice("--repo=".length);
		rest = rest.slice(1);
	}
	const [command, ...tail] = rest;
	if (command === undefined || command === "help" || command === "--help" || command === "-h") {
		(command === undefined ? ctx.err : ctx.out)(HELP);
		return command === undefined ? 2 : 0;
	}
	checkGitVersion(ctx);

	switch (command) {
		case "init":
			await initRepo(ctx, parseInit(tail));
			ctx.out(`registered ${ctx.cwd} as ${tail[0]}\n`);
			return 0;
		case "list":
			takeFlags(tail, []);
			for (const entry of readRegistry(ctx)) ctx.out(`${entry.path}\t${entry.name}\n`);
			return 0;
		case "sbx":
			throw precondition("xpi sg sbx is not available yet");
		default:
	}
	const blocked = gitCommandWord(rest);
	if (blocked !== undefined && BLOCKED.has(blocked))
		throw precondition(`xpi sg ${blocked} is not available: the shadow repo is local and never pushed`);

	const repo = resolveRepo(ctx, repoName);
	switch (command) {
		case "import":
			if (takeFlags(tail, ["--abort"]).has("--abort")) await abortImport(repo);
			else await importHost(repo);
			return 0;
		case "export":
			await exportMain(repo, takeFlags(tail, ["--apply"]).has("--apply"));
			return 0;
		case "status":
			takeFlags(tail, []);
			status(repo);
			return 0;
		case "env":
			takeFlags(tail, []);
			ctx.out(`export GIT_DIR=${shellQuote(repo.gitDir)} GIT_WORK_TREE=${shellQuote(repo.workspace)}\n`);
			return 0;
		case "merge":
			if (tail.length === 1 && (tail[0] === "--continue" || tail[0] === "--abort")) {
				const flag = tail[0];
				return asWriter(repo, `merge ${flag}`, () => passThrough(repo, ["merge", flag]));
			}
			if (tail.length !== 1 || tail[0].startsWith("-"))
				throw precondition("usage: xpi sg merge <branch> (or --continue, --abort)");
			await mergeBranch(repo, tail[0]);
			return 0;
		default:
			return passThrough(repo, rest);
	}
}

/**
 * Run `xpi sg <args>`. Returns the exit code: 0 success, 1 a git or adapter failure, 2 a failed precondition.
 * The caller supplies the working directory and the environment.
 */
export async function runSg(args: string[], options: SgOptions): Promise<number> {
	const ctx = createContext(options);
	try {
		return await dispatch(ctx, args);
	} catch (error) {
		if (!(error instanceof SgError)) throw error;
		ctx.err(`xpi sg: ${error.message}\n`);
		return error.code;
	}
}
