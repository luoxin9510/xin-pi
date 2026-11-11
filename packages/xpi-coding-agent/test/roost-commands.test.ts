// T18: every slash command xpi has (its own and those its built-in extensions register) has a row in builtin:roost's
// table, with how the hub's peek runs it in a background session; a new command without one fails here.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import { builtinCommands, EXTENSION_COMMANDS, unclassifiedCore } from "../src/extensions/roost/commands.ts";

const EXTENSIONS = resolve(__dirname, "../src/extensions");

/** Only in a foreground session (the foreground role): never in a session the daemon runs, so a peek never offers them. */
const FOREGROUND_ONLY = ["bg", "background", "bg-fork"];

function files(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? files(path) : [path];
	});
}

/** The command names the built-in extensions register by literal, and the built-in workflows' names. */
function extensionCommandNames(): string[] {
	const names = new Set<string>();
	for (const file of files(EXTENSIONS)) {
		if (!/\.(ts|js)$/.test(file)) continue;
		const text = readFileSync(file, "utf8");
		for (const m of text.matchAll(/registerCommand\(\s*["']([^"']+)["']/g)) names.add(m[1]!);
		if (file.includes(`${join("builtin", "workflows")}`))
			for (const m of text.matchAll(/^\s*name:\s*["']([^"']+)["']/gm)) names.add(m[1]!);
	}
	return [...names].sort();
}

describe("the hub's table of xpi's slash commands", () => {
	it("classifies every command in BUILTIN_SLASH_COMMANDS", () => {
		expect(unclassifiedCore()).toEqual([]);
		const table = builtinCommands();
		for (const c of BUILTIN_SLASH_COMMANDS) {
			const row = table.find((r) => r.name === c.name);
			expect(row, c.name).toBeDefined();
			expect(row!.description).toBe(c.description);
		}
	});

	it("classifies every command a built-in extension registers (the foreground role's aside)", () => {
		const found = extensionCommandNames();
		// the scan finds what it should: one command of each kind
		expect(found).toEqual(expect.arrayContaining(["commit", "agents", "subtask", "review", "bg"]));
		const missing = found.filter((n) => !FOREGROUND_ONLY.includes(n) && !(n in EXTENSION_COMMANDS));
		expect(missing).toEqual([]);
		// and nothing in the table is stale
		const core = new Set(BUILTIN_SLASH_COMMANDS.map((c) => c.name));
		for (const name of Object.keys(EXTENSION_COMMANDS)) {
			expect(found.includes(name) && !core.has(name), name).toBe(true);
		}
	});

	it("each row has a class the hub knows; a required argument has a hint", () => {
		for (const row of builtinCommands()) {
			expect(["hub", "screen", "picker", "confirm", "reply"]).toContain(row.how);
			if (row.args === "required") expect(row.argumentHint, row.name).toBeTruthy();
		}
		// the hub's own: what it does itself instead of typing them in
		const hub = builtinCommands()
			.filter((r) => r.how === "hub")
			.map((r) => r.name)
			.sort();
		expect(hub).toEqual(["compact", "model", "name", "thinking"]);
		expect(builtinCommands().find((r) => r.name === "quit")!.how).toBe("confirm");
	});
});
