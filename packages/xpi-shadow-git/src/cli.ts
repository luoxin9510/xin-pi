import { createContext, type SgContext, type SgOptions } from "./context.ts";
import { precondition, SgError } from "./errors.ts";
import { checkGitVersion, repoEnv } from "./git.ts";
import { initRepo } from "./init.ts";
import { run } from "./proc.ts";
import { type Repo, readRegistry, resolveRepo } from "./registry.ts";
import { createSandbox, listText, removeSandbox, runInSandbox, type Sandbox, sandboxFromEnv } from "./sandbox.ts";
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
  sbx create <id> [--from <branch>] [--profile <file>]   Create a sandbox: a worktree on sbx/<id> plus a path policy
  sbx run <id> -- <command...>                           Run a command in a sandbox
  sbx ls                                                 List the sandboxes
  sbx rm <id> [--force]                                  Remove a sandbox (its branch stays)
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

function passThrough(repo: Repo, args: string[], inside?: Sandbox): number {
	const env = inside
		? { ...repoEnv(repo), GIT_DIR: inside.gitDir, GIT_WORK_TREE: sandboxWorkTree(repo.ctx, inside) }
		: repoEnv(repo);
	const result = run(repo.ctx.git, args, {
		cwd: repo.ctx.cwd,
		env,
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

	// Inside a sandbox the repo is the sandbox's own: no other repo, and no new registration.
	const sandboxRef = ctx.env.XPI_SG_SANDBOX;
	if (sandboxRef) {
		if (command === "init") throw precondition("xpi sg init is not available inside a sandbox");
		if (repoName !== undefined && repoName !== sandboxRef.split("/")[0]) {
			throw precondition(`--repo ${repoName} is not available inside a sandbox of ${sandboxRef.split("/")[0]}`);
		}
	}

	switch (command) {
		case "init":
			await initRepo(ctx, parseInit(tail));
			ctx.out(`registered ${ctx.cwd} as ${tail[0]}\n`);
			return 0;
		case "list":
			takeFlags(tail, []);
			for (const entry of readRegistry(ctx)) ctx.out(`${entry.path}\t${entry.name}\n`);
			return 0;
		default:
	}
	const blocked = gitCommandWord(rest);
	if (blocked !== undefined && BLOCKED.has(blocked))
		throw precondition(`xpi sg ${blocked} is not available: the shadow repo is local and never pushed`);

	const inside = sandboxFromEnv(ctx);
	const repo = inside ? inside.repo : resolveRepo(ctx, repoName);
	// Inside a sandbox the primary workspace is read-only: only the sandbox's own repository state may change.
	if (inside && WRITES_PRIMARY.has(command) && !(command === "export" && !tail.includes("--apply"))) {
		throw precondition(`xpi sg ${command} is not available inside a sandbox (${inside.repo.name}/${inside.id})`);
	}
	switch (command) {
		case "sbx":
			return await sbx(repo, tail);
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
			ctx.out(
				`export GIT_DIR=${shellQuote(inside ? inside.gitDir : repo.gitDir)} GIT_WORK_TREE=${shellQuote(inside ? sandboxWorkTree(ctx, inside) : repo.workspace)}\n`,
			);
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
			return passThrough(repo, rest, inside);
	}
}

// What changes the primary workspace or the registry of sandboxes
const WRITES_PRIMARY = new Set(["import", "export", "merge"]);

/** The work tree git sees inside a sandbox: the workspace's own path under `namespace`, else the tree. */
const sandboxWorkTree = (ctx: SgContext, sbx: Sandbox): string =>
	ctx.env.XPI_SG_BACKEND === "namespace" ? sbx.workspace : sbx.tree;

async function sbx(repo: Repo, args: string[]): Promise<number> {
	const [sub, ...rest] = args;
	const ctx = repo.ctx;
	const flags = (
		spec: Record<string, boolean>,
		list: string[],
	): { values: Record<string, string>; positional: string[] } => {
		const values: Record<string, string> = {};
		const positional: string[] = [];
		for (let at = 0; at < list.length; at++) {
			const arg = list[at];
			if (!arg.startsWith("--")) positional.push(arg);
			else if (!(arg in spec)) throw precondition(`unknown argument ${arg}`);
			else if (spec[arg]) {
				const value = list[++at];
				if (value === undefined) throw precondition(`${arg} needs a value`);
				values[arg] = value;
			} else values[arg] = "";
		}
		return { values, positional };
	};
	const inSandbox = ctx.env.XPI_SG_SANDBOX;
	switch (sub) {
		case "create": {
			if (inSandbox)
				throw precondition("sandboxes do not nest: xpi sg sbx create is not available inside a sandbox");
			const { values, positional } = flags({ "--from": true, "--profile": true }, rest);
			if (positional.length !== 1)
				throw precondition("usage: xpi sg sbx create <id> [--from <branch>] [--profile <file>]");
			const sandbox = createSandbox(repo, positional[0], { from: values["--from"], profile: values["--profile"] });
			ctx.out(`created sandbox ${repo.name}/${sandbox.id} on ${sandbox.branch}: ${sandbox.tree}\n`);
			return 0;
		}
		case "run": {
			const split = rest.indexOf("--");
			if (split !== 1 || rest.length < 3) throw precondition("usage: xpi sg sbx run <id> -- <command> [args]");
			return await runInSandbox(repo, rest[0], rest.slice(2));
		}
		case "ls":
			flags({}, rest);
			for (const line of listText(repo)) ctx.out(`${line}\n`);
			return 0;
		case "rm": {
			if (inSandbox) throw precondition("xpi sg sbx rm is not available inside a sandbox");
			const { values, positional } = flags({ "--force": false }, rest);
			if (positional.length !== 1) throw precondition("usage: xpi sg sbx rm <id> [--force]");
			removeSandbox(repo, positional[0], "--force" in values);
			ctx.out(`removed sandbox ${repo.name}/${positional[0]}; branch sbx/${positional[0]} is kept\n`);
			return 0;
		}
		default:
			throw precondition("usage: xpi sg sbx create|run|ls|rm ... (xpi sg help)");
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
