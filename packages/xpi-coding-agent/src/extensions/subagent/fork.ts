// Fork (spec .scratch/xin-pi-workflows/04-fork.md): a subagent that starts as a copy of main's conversation, with
// main's model and thinking level, and returns only its result. `Agent({ subagent_type: "fork" })` or `/subtask`.
//
// The copy is a session file seeded in the subagents dir under the fork's id, so the child starts like a resume. The
// system prompt and tool declarations are stored in the session and travel with it: the fork's first request reads
// main's prompt cache. It runs as a normal child (no Agent, SendMessage or Workflow), so it cannot start a subagent.

import { join } from "node:path";
import { SessionManager } from "../../core/session-manager.ts";
import type { Config } from "./config.ts";
import type { AgentDefinition } from "./definition.ts";
import { childInvocation } from "./invocation.ts";
import { type CallInput, type ChildSpec, type ParentContext, type ResolveOptions, resolveChild } from "./resolve.ts";
import { subagentSessionDir } from "./sessions.ts";

export const FORK_TYPE = "fork";
const FORK_SOURCE = "builtin:fork";

export const FORK_DESCRIPTION =
	"A copy of you, with this whole conversation and your model, for a side task that needs what was said here. It returns only its result. It cannot start subagents; `model`, `effort` and `schema` are not accepted.";

// The reserved definition: no file, no system prompt of its own.
export const FORK_DEFINITION: AgentDefinition = {
	name: FORK_TYPE,
	description: FORK_DESCRIPTION,
	prompt: "",
	source: FORK_SOURCE,
	inert: [],
	warnings: [],
};

export const isFork = (def: AgentDefinition) => def.source === FORK_SOURCE;

// What a fork gets as the result of each tool call main had not finished when the copy was taken (the script that
// called Agent, and its siblings).
export const FORK_RESULT =
	"You are a fork of this conversation: a copy made at this point to do one side task. This tool call was not run for you and will not be. Do the task in the next message and reply with its result; do not continue the earlier work.";

// What a fork call may not carry, and where it cannot run. Throws with the reason.
export function checkForkCall(input: CallInput, config: Config, parent: ParentContext): void {
	if (!config.fork) throw new Error('subagent_type "fork" is turned off (subagent.fork is false)');
	for (const field of ["model", "effort", "schema"] as const) {
		if (input[field] !== undefined) {
			throw new Error(`"${field}" is not accepted on a fork: it runs as a copy of this conversation`);
		}
	}
	if (!parent.sessionFile) {
		throw new Error("a fork needs a saved session to copy: this session is in memory (--no-session)");
	}
	if (!parent.model) throw new Error("the parent session has no model for the fork to use");
}

// Copy main's session into the subagents dir as the session of `agentId`, and answer every tool call of its last
// assistant message that has no result yet. `cwd` is where the fork will run (a worktree when isolated).
export function seedForkSession(parent: ParentContext, agentId: string, cwd: string): void {
	const session = SessionManager.forkFrom(parent.sessionFile!, cwd, subagentSessionDir(parent), { id: agentId });
	const branch = session.getBranch();
	let last = -1;
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i]!;
		if (entry.type === "message" && entry.message.role === "assistant") {
			last = i;
			break;
		}
	}
	if (last === -1) return;
	const assistant = branch[last]!;
	if (assistant.type !== "message" || assistant.message.role !== "assistant") return;
	const answered = new Set<string>();
	for (const entry of branch.slice(last + 1)) {
		if (entry.type === "message" && entry.message.role === "toolResult") answered.add(entry.message.toolCallId);
	}
	for (const part of assistant.message.content) {
		if (part.type !== "toolCall" || answered.has(part.id)) continue;
		session.appendMessage({
			role: "toolResult",
			toolCallId: part.id,
			toolName: part.name,
			content: [{ type: "text", text: FORK_RESULT }],
			isError: false,
			timestamp: Date.now(),
		});
	}
}

// The child of a fork: main's model and thinking level, the default tools plus codemode, no system prompt flags (the
// session holds main's), and the seeded (or, on a resume, its own) session.
export function resolveFork(
	input: CallInput,
	config: Config,
	parent: ParentContext,
	options: ResolveOptions = {},
): ChildSpec {
	const agentId = input.resume ?? options.agentId;
	if (!agentId) throw new Error("a fork needs its agent id before it is resolved");
	const model = input.model ?? parent.model;
	if (!model) throw new Error("the parent session has no model for the fork to use");
	const thinking = input.effort ?? parent.thinking;
	const cwd = options.worktree ? join(options.worktree.path, options.worktree.subdir ?? "") : parent.cwd;
	const invocation = childInvocation(config.piCommand);
	return {
		command: invocation.command,
		args: [
			...invocation.args,
			"--mode",
			"rpc",
			"--model",
			model,
			"--thinking",
			thinking,
			"--tools",
			"+codemode",
			parent.trusted ? "--approve" : "--no-approve",
			"--session-dir",
			subagentSessionDir(parent),
			"--session-id",
			agentId,
		],
		env: { ...(process.env as Record<string, string>), XPI_SUBAGENT_DEPTH: "1" },
		cwd,
		prefixKey: `fork\0${agentId}`, // its prefix is main's conversation: nothing a sibling could wait for
		prompt: input.prompt,
		model,
		thinking,
		agentId,
		warnings: [],
		shutdownGraceMs: config.shutdownGraceMs,
		...(options.worktree ? { worktree: options.worktree } : {}),
	};
}

// The spec of any agent's child: a fork's, or an agent definition's.
export function resolveAgent(
	def: AgentDefinition,
	input: CallInput,
	config: Config,
	parent: ParentContext,
	options: ResolveOptions = {},
): ChildSpec {
	return isFork(def) ? resolveFork(input, config, parent, options) : resolveChild(def, input, config, parent, options);
}
