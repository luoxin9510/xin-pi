// Fails when a generated file is stale or a table that must list every command misses one, so `npm run check` catches
// before a PR what the tests `config-schemas`, `relay-docs` and `roost-commands` would catch in CI.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import { EXTENSION_COMMANDS, unclassifiedCore } from "../src/extensions/roost/commands.ts";
import { renderRelayDocs } from "./generate-relay-docs.ts";
import { renderConfigSchemas } from "./generate-schemas.ts";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Commands that exist only in a foreground session, so the hub's table leaves them out. */
export const FOREGROUND_ONLY_COMMANDS = ["bg", "background", "bg-fork"];

function files(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? files(path) : [path];
	});
}

/** The command names the built-in extensions register by literal, and the built-in workflows' names. */
export function extensionCommandNames(extensionsDir = join(packageDirectory, "src", "extensions")): string[] {
	const names = new Set<string>();
	for (const file of files(extensionsDir)) {
		if (!/\.(ts|js)$/.test(file)) continue;
		const text = readFileSync(file, "utf8");
		for (const m of text.matchAll(/registerCommand\(\s*["']([^"']+)["']/g)) names.add(m[1]!);
		if (file.includes(`${join("builtin", "workflows")}`))
			for (const m of text.matchAll(/^\s*name:\s*["']([^"']+)["']/gm)) names.add(m[1]!);
	}
	return [...names].sort();
}

/** What is out of step, one line each; empty when everything is current. */
export function generatedProblems(): string[] {
	const problems: string[] = [];
	for (const [relativePath, expected] of renderConfigSchemas()) {
		if (readFileSync(join(packageDirectory, relativePath), "utf-8") !== expected)
			problems.push(`${relativePath} is stale: run npm run generate:schemas in packages/xpi-coding-agent`);
	}
	const relayDoc = readFileSync(join(packageDirectory, "docs", "relay.md"), "utf-8");
	if (renderRelayDocs(relayDoc) !== relayDoc)
		problems.push("docs/relay.md is stale: run npm run generate:relay-docs in packages/xpi-coding-agent");
	for (const name of unclassifiedCore())
		problems.push(`/${name} has no row in builtinCommands() of src/extensions/roost/commands.ts`);
	const core = new Set(BUILTIN_SLASH_COMMANDS.map((c) => c.name));
	const found = extensionCommandNames();
	for (const name of found) {
		if (!FOREGROUND_ONLY_COMMANDS.includes(name) && !(name in EXTENSION_COMMANDS))
			problems.push(`/${name} has no row in EXTENSION_COMMANDS of src/extensions/roost/commands.ts`);
	}
	for (const name of Object.keys(EXTENSION_COMMANDS)) {
		if (!found.includes(name) || core.has(name))
			problems.push(`EXTENSION_COMMANDS has a row for /${name}, which no built-in extension registers`);
	}
	return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const problems = generatedProblems();
	for (const line of problems) console.error(line);
	if (problems.length > 0) process.exit(1);
	console.log("Generated files and command tables are current.");
}
