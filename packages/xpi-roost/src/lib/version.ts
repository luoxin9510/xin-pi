import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function readVersion(): string {
	let dir = dirname(fileURLToPath(import.meta.url));
	for (;;) {
		const file = join(dir, "package.json");
		if (existsSync(file)) {
			return (JSON.parse(readFileSync(file, "utf8")) as { version: string }).version;
		}
		const parent = dirname(dir);
		if (parent === dir) return "0.0.0";
		dir = parent;
	}
}

export const ROOST_VERSION = readVersion();

/**
 * The build id of the code installed from `start` (default: this file's directory): the one line of the bundle's
 * `build-id` file (scripts/build-coding-agent-bundle.mjs), or undefined. The entry files are in `dist/bundle` and the
 * daemon's, the host's and the shared chunks in `dist/bundle/chunks`, so the walk goes up to the first directory that
 * has the file. It stops at the first package.json, as readVersion does: from sources or an unbundled build that is
 * the package's own, and there is no id.
 */
export function readBuildId(start: string = dirname(fileURLToPath(import.meta.url))): string | undefined {
	let dir = start;
	for (;;) {
		const file = join(dir, "build-id");
		if (existsSync(file)) {
			try {
				return readFileSync(file, "utf8").trim() || undefined;
			} catch {
				return undefined;
			}
		}
		if (existsSync(join(dir, "package.json"))) return undefined;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/** The build this process started with (read once). */
export const ROOST_BUILD: string | undefined = readBuildId();

/** The build installed now: read again, so a process that has run for hours sees a rebuild. */
export function buildOnDisk(start?: string): string | undefined {
	return readBuildId(start);
}

/** Stale means both ids are known and they differ; an unknown id is never stale. */
export function isStale(running: string | undefined | null, onDisk: string | undefined | null): boolean {
	return !!running && !!onDisk && running !== onDisk;
}
