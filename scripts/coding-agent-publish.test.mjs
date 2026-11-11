import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { useBundleEntry, vendorWorkspaceTypes } from "./coding-agent-publish.mjs";

function write(path, text) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
}

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "coding-agent-publish-"));
	const packages = join(root, "packages");
	const stage = join(root, "stage");
	write(
		join(stage, "package.json"),
		JSON.stringify({
			name: "xpi-coding-agent",
			main: "./dist/index.js",
			types: "./dist/index.d.ts",
			exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" }, "./rpc-entry": { import: "./dist/bundle/rpc-entry.js" } },
			scripts: { prepublishOnly: "node refuse.mjs", build: "tsc" },
		}),
	);
	write(join(stage, "dist", "bundle", "index.js"), "export {};\n");
	write(
		join(stage, "dist", "index.d.ts"),
		'export type { Model } from "xpi-ai";\nexport { getRetry } from "xpi-ai/utils/retry";\nexport type Tui = import("xpi-tui").Tui;\n',
	);
	write(join(stage, "dist", "core", "deep.d.ts"), 'import type { Model } from "xpi-ai";\nexport declare const m: Model;\n');
	write(
		join(stage, "dist", "core", "messages.d.ts"),
		'declare module "xpi-tui" {\n\tinterface Tui {\n\t\tcustom: true;\n\t}\n}\nexport {};\n',
	);
	write(
		join(packages, "xpi-ai", "package.json"),
		JSON.stringify({
			name: "xpi-ai",
			exports: { ".": { types: "./dist/index.d.ts" }, "./utils/*": { types: "./dist/utils/*.d.ts" } },
		}),
	);
	write(join(packages, "xpi-ai", "dist", "index.d.ts"), 'export type { Schema } from "xpi-schema";\nexport interface Model { id: string }\nexport { data } from "./providers/data.js";\n');
	write(join(packages, "xpi-ai", "dist", "providers", "data.d.ts"), 'import json from "./data/a.json";\nexport declare const data: typeof json;\n');
	write(join(packages, "xpi-ai", "dist", "providers", "data", "a.json"), '{"a":1}\n');
	write(join(packages, "xpi-ai", "dist", "utils", "retry.d.ts"), "export declare function getRetry(): number;\n");
	write(join(packages, "xpi-ai", "dist", "index.js"), "export {};\n");
	write(join(packages, "xpi-schema", "package.json"), JSON.stringify({ name: "xpi-schema", exports: { ".": { types: "./dist/index.d.ts" } } }));
	write(join(packages, "xpi-schema", "dist", "index.d.ts"), "export type Schema = string;\n");
	// No exports map: the root resolves through "types".
	write(join(packages, "xpi-tui", "package.json"), JSON.stringify({ name: "xpi-tui", types: "./dist/index.d.ts" }));
	write(join(packages, "xpi-tui", "dist", "index.d.ts"), "export interface Tui { width: number }\n");
	return { root, packages, stage };
}

test("useBundleEntry points main and the root import at the bundle and drops prepublishOnly", () => {
	const { root, stage } = fixture();
	try {
		useBundleEntry(stage);
		const manifest = JSON.parse(readFileSync(join(stage, "package.json"), "utf8"));
		assert.equal(manifest.main, "./dist/bundle/index.js");
		assert.deepEqual(manifest.exports["."], { types: "./dist/index.d.ts", import: "./dist/bundle/index.js" });
		assert.deepEqual(manifest.exports["./rpc-entry"], { import: "./dist/bundle/rpc-entry.js" });
		assert.deepEqual(manifest.scripts, { build: "tsc" });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("vendorWorkspaceTypes copies the referenced packages' declarations and rewrites specifiers to relative paths", () => {
	const { root, packages, stage } = fixture();
	try {
		assert.deepEqual(vendorWorkspaceTypes(stage, packages), ["xpi-ai", "xpi-schema", "xpi-tui"]);
		assert.equal(
			readFileSync(join(stage, "dist", "index.d.ts"), "utf8"),
			'export type { Model } from "./vendor/xpi-ai/dist/index.js";\nexport { getRetry } from "./vendor/xpi-ai/dist/utils/retry.js";\nexport type Tui = import("./vendor/xpi-tui/dist/index.js").Tui;\n',
		);
		assert.match(readFileSync(join(stage, "dist", "core", "deep.d.ts"), "utf8"), /from "\.\.\/vendor\/xpi-ai\/dist\/index\.js"/);
		// A module augmentation is rewritten too, or a consumer silently loses it.
		assert.match(
			readFileSync(join(stage, "dist", "core", "messages.d.ts"), "utf8"),
			/^declare module "\.\.\/vendor\/xpi-tui\/dist\/index\.js" \{/,
		);
		// Transitive: xpi-ai refers to xpi-schema.
		assert.match(
			readFileSync(join(stage, "dist", "vendor", "xpi-ai", "dist", "index.d.ts"), "utf8"),
			/from "\.\.\/\.\.\/xpi-schema\/dist\/index\.js"/,
		);
		// JSON a vendored declaration imports is copied; JavaScript is not.
		assert.ok(existsSync(join(stage, "dist", "vendor", "xpi-ai", "dist", "providers", "data", "a.json")));
		assert.ok(!existsSync(join(stage, "dist", "vendor", "xpi-ai", "dist", "index.js")));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("vendorWorkspaceTypes refuses a subpath the package does not export", () => {
	const { root, packages, stage } = fixture();
	try {
		write(join(stage, "dist", "bad.d.ts"), 'export type { X } from "xpi-ai/nowhere";\n');
		assert.throws(() => vendorWorkspaceTypes(stage, packages), /unresolved workspace type imports:\n {2}dist\/bad\.d\.ts: xpi-ai\/nowhere/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("vendorWorkspaceTypes refuses a workspace specifier in a form it does not rewrite", () => {
	const { root, packages, stage } = fixture();
	try {
		write(join(stage, "dist", "ref.d.ts"), '/// <reference types="xpi-tui" />\nexport {};\n');
		assert.throws(() => vendorWorkspaceTypes(stage, packages), /workspace specifiers left in declarations:\n {2}dist\/ref\.d\.ts: "xpi-tui"/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
