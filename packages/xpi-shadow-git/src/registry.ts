import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import type { SgContext } from "./context.ts";
import { precondition } from "./errors.ts";

export interface RegistryEntry {
	/** The workspace root (an absolute, real path). */
	path: string;
	name: string;
}

/** A shadow repo, resolved from the registry. */
export interface Repo {
	ctx: SgContext;
	name: string;
	/** The workspace root. */
	workspace: string;
	/** `<store>/<name>.git`. */
	gitDir: string;
}

const registryFile = (ctx: SgContext): string => join(ctx.store, "registry");

export const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function readRegistry(ctx: SgContext): RegistryEntry[] {
	const file = registryFile(ctx);
	if (!existsSync(file)) return [];
	const entries: RegistryEntry[] = [];
	for (const [index, line] of readFileSync(file, "utf8").split("\n").entries()) {
		if (line === "") continue;
		const [path, name, ...rest] = line.split("\t");
		if (!path?.startsWith("/") || !name || !NAME.test(name) || rest.length > 0) {
			throw precondition(`${file}:${index + 1}: not a registry line (<absolute path><TAB><name>)`);
		}
		entries.push({ path, name });
	}
	return entries;
}

export function appendRegistry(ctx: SgContext, entry: RegistryEntry): void {
	mkdirSync(ctx.store, { recursive: true, mode: 0o700 });
	appendFileSync(registryFile(ctx), `${entry.path}\t${entry.name}\n`);
}

export function removeRegistry(ctx: SgContext, name: string): void {
	const file = registryFile(ctx);
	if (!existsSync(file)) return;
	const kept = readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line !== "" && line.split("\t")[1] !== name);
	writeFileSync(file, kept.length > 0 ? `${kept.join("\n")}\n` : "");
}

export const gitDirOf = (ctx: SgContext, name: string): string => join(ctx.store, `${name}.git`);

export function realPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

const contains = (root: string, path: string): boolean => path === root || path.startsWith(root + sep);

/** The registry entries that contain `path`, or are contained in it. */
export function nestedEntries(ctx: SgContext, path: string): RegistryEntry[] {
	return readRegistry(ctx).filter((entry) => contains(entry.path, path) || contains(path, entry.path));
}

/** The repo for `repoName`, else the one with the longest registered path that contains the cwd. */
export function resolveRepo(ctx: SgContext, repoName: string | undefined): Repo {
	const entries = readRegistry(ctx);
	let found: RegistryEntry | undefined;
	if (repoName !== undefined) {
		found = entries.find((entry) => entry.name === repoName);
		if (!found) throw precondition(`no repo named ${repoName} (xpi sg list shows the registry)`);
	} else {
		const cwd = realPath(ctx.cwd);
		for (const entry of entries) {
			if (contains(entry.path, cwd) && (!found || entry.path.length > found.path.length)) found = entry;
		}
		if (!found) throw precondition(`${ctx.cwd} is not in a registered workspace (xpi sg init <name> --adapter <a>)`);
	}
	const gitDir = gitDirOf(ctx, found.name);
	if (!existsSync(gitDir)) throw precondition(`${found.name} is registered but ${gitDir} is missing`);
	return { ctx, name: found.name, workspace: found.path, gitDir };
}
