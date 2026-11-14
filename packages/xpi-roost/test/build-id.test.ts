// Spec 03: the build id a process runs against the one on disk.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildOnDisk, isStale, readBuildId } from "../src/lib/version.ts";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "roost-buildid-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("buildOnDisk", () => {
	it("finds build-id in a parent directory (the chunks directory of a bundle)", () => {
		const chunks = join(root, "dist", "bundle", "chunks");
		mkdirSync(chunks, { recursive: true });
		writeFileSync(join(root, "dist", "bundle", "build-id"), "0123456789abcdef\n");
		expect(buildOnDisk(chunks)).toBe("0123456789abcdef");
		expect(buildOnDisk(join(root, "dist", "bundle"))).toBe("0123456789abcdef");
	});

	it("reads the file again each time", () => {
		writeFileSync(join(root, "build-id"), "aaaaaaaaaaaaaaaa\n");
		expect(buildOnDisk(root)).toBe("aaaaaaaaaaaaaaaa");
		writeFileSync(join(root, "build-id"), "bbbbbbbbbbbbbbbb\n");
		expect(buildOnDisk(root)).toBe("bbbbbbbbbbbbbbbb");
	});

	it("is undefined without the file", () => {
		expect(buildOnDisk(root)).toBeUndefined();
		writeFileSync(join(root, "build-id"), "\n");
		expect(buildOnDisk(root)).toBeUndefined();
	});

	it("stops at the first package.json: a build-id above it is not this package's", () => {
		const pkg = join(root, "packages", "xpi-roost");
		mkdirSync(join(pkg, "dist"), { recursive: true });
		writeFileSync(join(root, "build-id"), "ffffffffffffffff\n");
		writeFileSync(join(pkg, "package.json"), "{}");
		expect(buildOnDisk(join(pkg, "dist"))).toBeUndefined();
		expect(readBuildId(join(pkg, "dist"))).toBeUndefined();
	});
});

describe("isStale", () => {
	it("is true only when both ids are known and differ", () => {
		expect(isStale("a", "b")).toBe(true);
		expect(isStale("a", "a")).toBe(false);
		expect(isStale(undefined, "b")).toBe(false);
		expect(isStale("a", undefined)).toBe(false);
		expect(isStale(null, "b")).toBe(false);
		expect(isStale(undefined, undefined)).toBe(false);
	});
});
