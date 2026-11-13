/**
 * T18 (decision 4): xpi's slash commands and how the hub's peek runs each in a background session. The table is
 * builtin:roost's because it knows xpi; xpi-roost only knows the classes. `test/roost-commands.test.ts` fails when a
 * command in `BUILTIN_SLASH_COMMANDS` or one a built-in extension registers has no row, so a new command cannot be
 * forgotten.
 *
 * - hub: the hub has its own (model, thinking, name, compact).
 * - screen: runs and shows something; the peek types it into the session and shows its screen.
 * - picker: opens a picker, a dialog or a screen; the peek types it in and attaches.
 * - confirm: ends the session (asked twice).
 * - reply: sent to the session as a reply; its worker runs it like a typed prompt.
 */

import type { BuiltinCommand } from "xpi-roost/hub";
import { BUILTIN_SLASH_COMMANDS } from "../../core/slash-commands.ts";

type How = Pick<BuiltinCommand, "how" | "args" | "argumentHint">;

/** xpi's own commands (BUILTIN_SLASH_COMMANDS), which a session's worker never sees: the editor runs them. */
const CORE: Record<string, How> = {
	settings: { how: "picker" },
	model: { how: "hub", args: "optional" },
	tree: { how: "picker" },
	thinking: { how: "hub", args: "optional" },
	"scoped-models": { how: "picker" },
	export: { how: "screen", args: "optional" },
	import: { how: "picker", args: "required", argumentHint: "<file>" },
	share: { how: "picker" },
	bug: { how: "picker", args: "optional" },
	copy: { how: "screen" },
	name: { how: "hub", args: "optional" },
	session: { how: "screen" },
	changelog: { how: "screen" },
	hotkeys: { how: "screen" },
	fork: { how: "picker" },
	clone: { how: "screen" },
	trust: { how: "picker" },
	login: { how: "picker", args: "optional" },
	logout: { how: "picker" },
	new: { how: "screen" },
	compact: { how: "hub", args: "optional" },
	resume: { how: "picker" },
	reload: { how: "screen" },
	quit: { how: "confirm" },
};

/**
 * The commands xpi's built-in extensions register, by what each does:
 * - /commit asks to confirm the message, /mcp (bare) and /llama open their managers, /workflows and /subagents (bare)
 *   open a list, /tasks opens the agent team's task overlay, /agents opens the hub inside the session: picker.
 * - /relay only says where the work stands (a notice on the session's screen): screen.
 * - /handover, /handback, /subtask, /upstream and the built-in /review workflow start or steer work: reply.
 */
export const EXTENSION_COMMANDS: Record<string, How & { description: string; argumentHint?: string }> = {
	commit: { how: "picker", args: "optional", description: "Draft a commit message and commit after you confirm it" },
	mcp: { how: "picker", args: "optional", description: "Manage MCP servers" },
	llama: { how: "picker", description: "Manage llama.cpp router models" },
	workflows: { how: "picker", description: "Saved workflows and this session's workflow runs" },
	subagents: { how: "picker", args: "optional", description: "This session's subagents" },
	tasks: { how: "picker", description: "The agent team's task list" },
	agents: { how: "picker", description: "The hub, inside the session" },
	relay: { how: "screen", description: "Relay: who has the work, the round and the two models" },
	handover: { how: "reply", args: "optional", description: "Relay: give the work to the worker model now" },
	handback: { how: "reply", description: "Relay: wake the lead now" },
	subtask: { how: "reply", args: "required", argumentHint: "<task>", description: "Start a fork for a side task" },
	upstream: { how: "reply", description: "Compare upstream pi with xin-pi and write a report" },
	review: { how: "reply", args: "optional", description: "Review a diff with parallel reviewers (workflow)" },
};

/** The table the hub gets: xpi's own commands with their descriptions, then the built-in extensions'. */
export function builtinCommands(): BuiltinCommand[] {
	const out: BuiltinCommand[] = [];
	for (const c of BUILTIN_SLASH_COMMANDS) {
		const row = CORE[c.name];
		if (!row) continue; // the test fails first
		out.push({
			name: c.name,
			description: c.description,
			...(c.argumentHint ? { argumentHint: c.argumentHint } : {}),
			...row,
		});
	}
	for (const [name, row] of Object.entries(EXTENSION_COMMANDS)) out.push({ name, ...row });
	return out;
}

/** The names of xpi's own commands with no row (the test asserts none). */
export function unclassifiedCore(): string[] {
	return BUILTIN_SLASH_COMMANDS.map((c) => c.name).filter((n) => !CORE[n]);
}
