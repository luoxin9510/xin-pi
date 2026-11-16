// T18: every slash command xpi has (its own and those its built-in extensions register) has a row in builtin:roost's
// table, with how the hub's peek runs it in a background session; a new command without one fails here.
import { describe, expect, it } from "vitest";
import { extensionCommandNames, FOREGROUND_ONLY_COMMANDS as FOREGROUND_ONLY } from "../scripts/check-generated.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import { builtinCommands, EXTENSION_COMMANDS, unclassifiedCore } from "../src/extensions/roost/commands.ts";

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

	it("spec 02 decision 8: /schedule is the hub's, never a command of an ordinary xpi session", () => {
		const found = extensionCommandNames();
		for (const name of ["schedule", "schedules"]) {
			expect(found).not.toContain(name);
			expect(BUILTIN_SLASH_COMMANDS.map((c) => c.name)).not.toContain(name);
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
		expect(hub).toEqual(["compact", "model", "name", "restart", "thinking"]);
		expect(builtinCommands().find((r) => r.name === "quit")!.how).toBe("confirm");
	});
});
