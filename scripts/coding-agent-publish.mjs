// The published xpi-coding-agent package. In the repository its library entry is the unbundled dist/index.js, which
// imports the xpi-* workspace packages; those are devDependencies and are not on npm. The published package is made
// self-contained instead:
// - "." (and main) point at dist/bundle/index.js, which inlines the workspace packages;
// - the declaration files of the workspace packages it refers to are copied into dist/vendor/<package>/, and every
//   "xpi-*" specifier in the package's .d.ts files is rewritten to a relative path, so types resolve without them.
// The repository's own package.json is never changed: workspace consumers (xpi-evals, tests) keep the unbundled entry.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { execNpmSync } from "./npm-command.mjs";

export const codingAgentPackageName = "xpi-coding-agent";
const bundleEntry = "./dist/bundle/index.js";
const vendorDir = join("dist", "vendor");
// "xpi-ai", "xpi-ai/utils/retry", in `from "…"`, `import("…")`, `import "…"` and `declare module "…"` (a module
// augmentation, such as the custom message roles added to xpi-agent-core's AgentMessage).
const specifierPattern =
	/(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bdeclare\s+module\s+)(["'])(xpi-[a-z0-9-]+)(\/[^"']*)?\2/g;
// Any workspace specifier left in a staged declaration after the rewrite (other than the package itself).
const leftoverPattern = /["']xpi-(?!coding-agent["'/])[a-z0-9-]+(\/[^"']*)?["']/;

function walk(directory, predicate, out = []) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) walk(path, predicate, out);
		else if (predicate(path)) out.push(path);
	}
	return out;
}

const isDeclaration = (path) => path.endsWith(".d.ts");

/** The declaration file a package exports for a subpath ("." or "./x"), relative to the package root. */
function typesTarget(manifest, subpath) {
	const exportsMap = manifest.exports;
	if (exportsMap && typeof exportsMap === "object") {
		const typesOf = (value) => (typeof value === "string" ? value : value?.types);
		if (exportsMap[subpath] !== undefined) {
			const target = typesOf(exportsMap[subpath]);
			if (target) return target.endsWith(".d.ts") ? target : target.replace(/\.js$/, ".d.ts");
		}
		for (const [key, value] of Object.entries(exportsMap)) {
			if (!key.includes("*")) continue;
			const [prefix, suffix] = key.split("*");
			if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
			const target = typesOf(value);
			if (target) return target.replace("*", subpath.slice(prefix.length, subpath.length - suffix.length));
		}
		return undefined;
	}
	if (subpath === ".") return manifest.types ?? manifest.typings;
	return undefined;
}

/**
 * Copy the declarations of the workspace packages the staged package refers to (and those they refer to) into
 * dist/vendor/, and rewrite every xpi-* specifier in the staged .d.ts files to a relative path.
 */
export function vendorWorkspaceTypes(stageDir, packagesDir) {
	const manifests = new Map();
	const manifestOf = (name) => {
		if (!manifests.has(name)) {
			const path = name === codingAgentPackageName ? join(stageDir, "package.json") : join(packagesDir, name, "package.json");
			if (!existsSync(path)) throw new Error(`declarations refer to ${name}, which is not a workspace package`);
			manifests.set(name, JSON.parse(readFileSync(path, "utf8")));
		}
		return manifests.get(name);
	};
	// Where a package's root lives in the staged tree.
	const rootOf = (name) => (name === codingAgentPackageName ? stageDir : join(stageDir, vendorDir, name));

	const vendored = new Set();
	const pending = walk(join(stageDir, "dist"), isDeclaration).filter((path) => !path.startsWith(join(stageDir, vendorDir)));
	const unresolved = [];
	const vendorRoot = join(stageDir, vendorDir);
	while (pending.length > 0) {
		const file = pending.pop();
		const text = readFileSync(file, "utf8");
		// A vendored declaration may import a JSON file next to it (model data): copy the ones it names.
		if (file.startsWith(vendorRoot + sep)) {
			const [name, ...rest] = relative(vendorRoot, file).split(sep);
			const sourceFile = join(packagesDir, name, ...rest);
			for (const match of text.matchAll(/\bfrom\s*["'](\.{1,2}\/[^"']+\.json)["']/g)) {
				const target = join(dirname(file), match[1]);
				if (!existsSync(target)) {
					mkdirSync(dirname(target), { recursive: true });
					copyFileSync(join(dirname(sourceFile), match[1]), target);
				}
			}
		}
		const rewritten = text.replace(specifierPattern, (match, lead, quote, name, rest = "") => {
			if (name !== codingAgentPackageName && !vendored.has(name)) {
				const source = join(packagesDir, name, "dist");
				if (!existsSync(source)) throw new Error(`no built declarations for ${name}: run npm run build first`);
				for (const declaration of walk(source, isDeclaration)) {
					const target = join(rootOf(name), "dist", relative(source, declaration));
					mkdirSync(dirname(target), { recursive: true });
					copyFileSync(declaration, target);
					pending.push(target);
				}
				vendored.add(name);
			}
			const subpath = rest ? `.${rest}` : ".";
			const target = typesTarget(manifestOf(name), subpath);
			if (!target) {
				unresolved.push(`${relative(stageDir, file)}: ${name}${rest}`);
				return match;
			}
			let spec = relative(dirname(file), join(rootOf(name), target)).split(sep).join("/").replace(/\.d\.ts$/, ".js");
			if (!spec.startsWith(".")) spec = `./${spec}`;
			return `${lead}${quote}${spec}${quote}`;
		});
		if (rewritten !== text) writeFileSync(file, rewritten);
	}
	if (unresolved.length > 0) throw new Error(`unresolved workspace type imports:\n  ${unresolved.join("\n  ")}`);
	// A form of reference the pattern does not know would leave a bare specifier no consumer can resolve.
	const leftovers = walk(join(stageDir, "dist"), isDeclaration).flatMap((file) => {
		// Comments do not resolve anything; `/// <reference …/>` directives do, so they stay.
		const code = readFileSync(file, "utf8")
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/^\s*\/\/(?!\/\s*<reference).*$/gm, "");
		const match = leftoverPattern.exec(code);
		return match ? [`${relative(stageDir, file)}: ${match[0]}`] : [];
	});
	if (leftovers.length > 0) throw new Error(`workspace specifiers left in declarations:\n  ${leftovers.join("\n  ")}`);
	return [...vendored].sort();
}

/** Point the library entry of a staged package.json at the bundle. */
export function useBundleEntry(stageDir) {
	const path = join(stageDir, "package.json");
	const manifest = JSON.parse(readFileSync(path, "utf8"));
	if (!existsSync(join(stageDir, bundleEntry))) throw new Error(`${bundleEntry} is missing: build the bundle first`);
	manifest.main = bundleEntry;
	// The repository's prepublishOnly refuses `npm publish` of the workspace folder; the staged package is the one to publish.
	if (manifest.scripts) delete manifest.scripts.prepublishOnly;
	manifest.exports = { ...manifest.exports, ".": { ...manifest.exports["."], import: bundleEntry } };
	writeFileSync(path, `${JSON.stringify(manifest, null, "\t")}\n`);
}

/**
 * `npm pack` the coding agent as it is published: pack the workspace package, unpack it into a temporary stage, make
 * it self-contained, and pack the stage into `destination`. Returns npm pack's JSON entry for the final tarball.
 */
export function packCodingAgent({ packageDir, packagesDir, destination }) {
	const work = mkdtempSync(join(tmpdir(), "xpi-coding-agent-publish-"));
	try {
		const first = JSON.parse(
			execNpmSync(["pack", "--ignore-scripts", "--json", "--pack-destination", work], {
				cwd: packageDir,
				encoding: "utf8",
				stdio: ["inherit", "pipe", "inherit"],
			}),
		)[0];
		const stage = join(work, "stage");
		mkdirSync(stage);
		// Relative paths: a GNU tar on Windows reads "C:\\…" as a remote host.
		execFileSync("tar", ["-xzf", first.filename, "-C", "stage"], { cwd: work });
		const stageDir = join(stage, "package");
		useBundleEntry(stageDir);
		const vendored = vendorWorkspaceTypes(stageDir, packagesDir);
		console.log(`  ${codingAgentPackageName}: library entry ${bundleEntry}; declarations of ${vendored.join(", ")} in ${vendorDir}`);
		mkdirSync(destination, { recursive: true });
		return JSON.parse(
			execNpmSync(["pack", "--ignore-scripts", "--json", "--pack-destination", destination], {
				cwd: stageDir,
				encoding: "utf8",
				stdio: ["inherit", "pipe", "inherit"],
			}),
		)[0];
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}
