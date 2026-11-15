// Path matching of the protect extension: a tool's `path` is resolved, matched as a gitignore pattern against the
// project-relative form (or, outside the project, the absolute form), and mapped to a protection level.

import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import ignore from "ignore";
import { resolveToCwd } from "../../core/tools/path-utils.ts";

export type ProtectLevel = "secret" | "readOnly";

export interface ProtectRules {
	secret: readonly unknown[];
	readOnly: readonly unknown[];
}

/** The entries of a list that `ignore` can take (strings) and how many were skipped. */
export function validEntries(list: readonly unknown[]): { entries: string[]; skipped: number } {
	const entries = list.filter((entry): entry is string => typeof entry === "string");
	return { entries, skipped: list.length - entries.length };
}

function isCaseInsensitive(platform: NodeJS.Platform): boolean {
	return platform === "darwin" || platform === "win32";
}

/**
 * `path` in the form the patterns see, with `/` separators: relative to `root` inside it, else absolute without its
 * leading `/`. On Windows the drive colon is dropped (`C:\x` becomes `C/x`), UNC paths drop their leading `\\`
 * (`server/share/x`) and a `\\?\` path drops its prefix first, because `ignore` rejects a drive path as not relative.
 * Undefined for the root itself: `ignore` throws on an empty path and the root is never a match.
 */
export function relativeForMatch(path: string, root: string, platform: NodeJS.Platform): string | undefined {
	const win = platform === "win32";
	const normal = (value: string): string => {
		let text = value;
		if (win) {
			text = text.replaceAll("\\", "/");
			if (text.startsWith("//?/UNC/")) text = `//${text.slice("//?/UNC/".length)}`;
			else if (text.startsWith("//?/")) text = text.slice("//?/".length);
			text = text.replace(/^([a-zA-Z]):/, "$1");
			text = text.replace(/^\/\//, "");
		}
		return text.length > 1 ? text.replace(/\/+$/, "") : text;
	};
	const full = normal(path);
	const base = normal(root);
	const fold = (value: string): string => (isCaseInsensitive(platform) ? value.toLowerCase() : value);
	const prefix = base.endsWith("/") ? base : `${base}/`;
	let relative: string;
	if (fold(full) === fold(base)) return undefined;
	if (fold(full).startsWith(fold(prefix))) relative = full.slice(prefix.length);
	else relative = full.replace(/^\/+/, "");
	return relative === "" ? undefined : relative;
}

/** The real path of `path`; for one that does not exist yet, its nearest existing ancestor's real path plus the rest. */
export function realPathOf(path: string): string {
	const rest: string[] = [];
	let current = path;
	for (;;) {
		try {
			return rest.length === 0 ? realpathSync(current) : join(realpathSync(current), ...rest.reverse());
		} catch {
			const parent = dirname(current);
			if (parent === current) return path;
			rest.push(basename(current));
			current = parent;
		}
	}
}

function build(entries: readonly unknown[], platform: NodeJS.Platform) {
	return ignore({ ignorecase: isCaseInsensitive(platform) }).add(validEntries(entries).entries);
}

/**
 * The protection level of the file `rawPath` names (as a tool receives it: `~`, `@`, relative), or undefined. A path
 * matching both lists is a secret. `rawPath` must not carry a scheme; the caller skips those.
 */
export function protectLevel(
	rules: ProtectRules,
	rawPath: string,
	cwd: string,
	platform: NodeJS.Platform = process.platform,
): ProtectLevel | undefined {
	const resolved = resolveToCwd(rawPath, cwd);
	const root = resolve(cwd);
	const real = realPathOf(resolved);
	const realRoot = realPathOf(root);
	const candidates = new Set<string>();
	for (const [path, base] of [
		[resolved, root],
		[real, realRoot],
	] as const) {
		const relative = relativeForMatch(path, base, platform);
		if (relative !== undefined) candidates.add(relative);
	}
	if (candidates.size === 0) return undefined;
	const secret = build(rules.secret, platform);
	const readOnly = build(rules.readOnly, platform);
	// `.git/` does not match `.git` itself (a file in a worktree), so each candidate is also tested as a directory.
	const matches = (matcher: ReturnType<typeof build>): boolean =>
		[...candidates].some((candidate) => matcher.ignores(candidate) || matcher.ignores(`${candidate}/`));
	if (matches(secret)) return "secret";
	if (matches(readOnly)) return "readOnly";
	return undefined;
}
