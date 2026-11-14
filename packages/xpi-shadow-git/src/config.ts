import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { failure, precondition } from "./errors.ts";
import { git, splitZ } from "./git.ts";
import type { Repo } from "./registry.ts";

/** A config value, or undefined when the key is unset. */
export function configGet(repo: Repo, key: string): string | undefined {
	const result = git(repo, ["config", "--get", key], { allowFail: true });
	return result.status === 0 ? result.stdout.replace(/\n$/, "") : undefined;
}

/** Every value of a multi-valued key. */
export function configAll(repo: Repo, key: string): string[] {
	const result = git(repo, ["config", "--get-all", key], { allowFail: true });
	return result.status === 0 ? result.stdout.split("\n").filter((line) => line !== "") : [];
}

/** `shadow.scope`: the paths the adapter works on. Empty is the whole workspace. */
export const scopeOf = (repo: Repo): string[] => (configGet(repo, "shadow.scope") ?? "").split(/\s+/).filter(Boolean);

/** `shadow.localOnly`: globs tracked in git but never exported. */
export const localOnlyOf = (repo: Repo): string[] => configAll(repo, "shadow.localOnly");

/** A local-only glob as a pathspec glob. A trailing slash means everything below. */
const globBody = (glob: string): string => (glob.endsWith("/") ? `${glob}**` : glob);
const includeSpec = (glob: string): string => `:(glob)${globBody(glob)}`;
const excludeSpec = (glob: string): string => `:(exclude,glob)${globBody(glob)}`;
const scopeSpec = (path: string): string => `:(literal)${path.replace(/\/+$/, "")}`;

/** Pathspecs for the paths git tracks: the scope (the whole workspace when empty) and the local-only paths. */
export function trackSpecs(repo: Repo): string[] {
	const scope = scopeOf(repo);
	return scope.length === 0 ? ["."] : [...scope.map(scopeSpec), ...localOnlyOf(repo).map(includeSpec)];
}

/** Pathspecs for what an import commits: the scope, without the local-only paths. */
export function importSpecs(repo: Repo): string[] {
	const scope = scopeOf(repo);
	return [...(scope.length === 0 ? ["."] : scope.map(scopeSpec)), ...localOnlyOf(repo).map(excludeSpec)];
}

/** Pathspecs for what an export plans: everything but the local-only paths. Paths outside the scope are refused later. */
export const planSpecs = (repo: Repo): string[] => [".", ...localOnlyOf(repo).map(excludeSpec)];

/** Pathspecs that select the local-only paths. Empty when there are none. */
export const localOnlySpecs = (repo: Repo): string[] => localOnlyOf(repo).map(includeSpec);

/** Whether `path` is inside the scope (everything is, when the scope is empty). */
export function inScope(scope: string[], path: string): boolean {
	return (
		scope.length === 0 ||
		scope.some((entry) => path === entry.replace(/\/+$/, "") || path.startsWith(`${entry.replace(/\/+$/, "")}/`))
	);
}

/** The paths with changes or untracked files that are not ignored, within what git tracks. */
export function dirtyPaths(repo: Repo): string[] {
	const out = git(repo, [
		"status",
		"--porcelain",
		"-z",
		"--no-renames",
		"--untracked-files=normal",
		"--",
		...trackSpecs(repo),
	]);
	return splitZ(out.stdout).map((entry) => entry.slice(3));
}

export function currentBranch(repo: Repo): string | undefined {
	const result = git(repo, ["symbolic-ref", "-q", "--short", "HEAD"], { allowFail: true });
	return result.status === 0 ? result.stdout.trim() : undefined;
}

export function revParse(repo: Repo, ref: string): string {
	return git(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).stdout.trim();
}

/** The `SG_IMPORT` record: the old `host` sha and, once the adapter's update has finished, its label. */
export interface ImportRecord {
	old: string;
	label?: string;
}

const recordFile = (repo: Repo): string => join(repo.gitDir, "SG_IMPORT");

export function readImportRecord(repo: Repo): ImportRecord | undefined {
	const file = recordFile(repo);
	if (!existsSync(file)) return undefined;
	const lines = readFileSync(file, "utf8").split("\n");
	const old = lines.find((line) => line.startsWith("old "))?.slice(4);
	if (!old) throw failure(`${file} is not an import record (no old line); remove it or run xpi sg import --abort`);
	const label = lines.find((line) => line.startsWith("label "))?.slice(6);
	return { old, label };
}

export function writeImportRecord(repo: Repo, record: ImportRecord): void {
	writeFileSync(recordFile(repo), `old ${record.old}\n${record.label === undefined ? "" : `label ${record.label}\n`}`);
}

export function removeImportRecord(repo: Repo): void {
	rmSync(recordFile(repo), { force: true });
}

/** Exit 2 while an import is stopped: its record is the guard. */
export function assertNoImport(repo: Repo, what: string): void {
	if (readImportRecord(repo)) {
		throw precondition(
			`${what} is refused: an import is stopped (SG_IMPORT). Run xpi sg import to resume it or xpi sg import --abort`,
		);
	}
}
