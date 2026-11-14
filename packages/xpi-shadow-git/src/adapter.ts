import { accessSync, constants, statSync } from "node:fs";
import { join } from "node:path";
import { configGet, localOnlyOf, scopeOf } from "./config.ts";
import type { SgContext } from "./context.ts";
import { failure, precondition } from "./errors.ts";
import { cleanEnv } from "./git.ts";
import { run } from "./proc.ts";
import type { Repo } from "./registry.ts";

export const ADAPTER_NAME = /^[a-z0-9][a-z0-9._-]*$/;

/** The adapter's executable: the first `sg-adapter-<name>` in the adapter directories. */
export function findAdapter(ctx: SgContext, name: string): string {
	if (!ADAPTER_NAME.test(name))
		throw precondition(`${name} is not an adapter name (lowercase letters, digits, . _ -)`);
	for (const dir of ctx.adapterDirs) {
		const file = join(dir, `sg-adapter-${name}`);
		try {
			if (!statSync(file).isFile()) continue;
			accessSync(file, constants.X_OK);
			return file;
		} catch {}
	}
	throw precondition(
		`no executable sg-adapter-${name} in ${ctx.adapterDirs.join(", ")} (XPI_SG_ADAPTER_PATH adds directories)`,
	);
}

export interface AdapterCall {
	/** The adapter's name; default `shadow.adapter`. */
	name?: string;
	args?: string[];
	input?: string;
	scope?: string[];
	localOnly?: string[];
}

/**
 * Call `sg-adapter-<name> <op> [args]` with the workspace root as its cwd. A non-zero exit fails the command (exit 1)
 * and its stderr is shown unchanged. Returns stdout.
 */
export function callAdapter(repo: Repo, op: string, call: AdapterCall = {}): string {
	const name = call.name ?? configGet(repo, "shadow.adapter");
	if (!name) throw precondition(`${repo.name} has no shadow.adapter`);
	const file = findAdapter(repo.ctx, name);
	const result = run(file, [op, ...(call.args ?? [])], {
		cwd: repo.workspace,
		env: {
			...cleanEnv(repo.ctx.env),
			XPI_SG_WORKSPACE: repo.workspace,
			XPI_SG_SCOPE: (call.scope ?? scopeOf(repo)).join(" "),
			XPI_SG_LOCAL_ONLY: (call.localOnly ?? localOnlyOf(repo)).join(" "),
			XPI_SG_GIT_DIR: repo.gitDir,
			XPI_SG_GIT: repo.ctx.git,
		},
		input: call.input,
	});
	if (result.stderr) repo.ctx.err(result.stderr);
	if (result.spawnError) repo.ctx.err(`${file}: ${result.spawnError.message}\n`);
	if (result.status !== 0) throw failure(`sg-adapter-${name} ${op} failed (exit ${result.status})`);
	return result.stdout;
}

/** The adapter's lines of output without blanks. */
export const lines = (text: string): string[] => text.split("\n").filter((line) => line.trim() !== "");
