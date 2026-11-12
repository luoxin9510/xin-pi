// What the user types on a subagent screen: steer it while it runs, or continue it once it is finished.

import { discoverAgents } from "./discovery.ts";
import { exchange, getHost, recordSteer } from "./exchange.ts";
import { FORK_DEFINITION, FORK_TYPE, resolveAgent } from "./fork.ts";
import { registry, type SubagentRecord } from "./registry.ts";
import type { ParentContext } from "./resolve.ts";
import { teams } from "./team.ts";
import { memoryRoot } from "./worktree.ts";

export type Delivery = "steered" | "queued" | "started";

// Steer a running subagent (rpc `steer`). A finished one is continued from its session with its stored type, model and
// thinking level; if it is busy with someone else's exchange (main's resume), the message waits its turn. Resolves
// with how the message was taken; the returned `done` settles when the exchange it started has ended.
export function talkTo(parent: ParentContext, id: string, text: string): { delivery: Delivery; done: Promise<void> } {
	const r = registry.get(id)!;
	if (registry.handle(id)?.send({ type: "steer", message: text })) {
		recordSteer(id, text);
		return { delivery: "steered", done: Promise.resolve() };
	}
	const queued = registry.busy(id);
	return { delivery: queued ? "queued" : "started", done: continueAgent(parent, r, text, text) };
}

// Continue a finished subagent from its session with `prompt` (a function: read when the child starts, so an exchange
// that waits for a slot can take later messages too). `said` is the user's text, noted back to main afterwards. A teammate
// of the current team keeps its team's tools, environment and frozen prompt section.
export async function continueAgent(
	parent: ParentContext,
	r: SubagentRecord,
	prompt: string | (() => string),
	said?: string,
): Promise<void> {
	const def = r.type === FORK_TYPE ? FORK_DEFINITION : discoverAgents(parent.cwd).agents.get(r.type);
	if (!def) throw new Error(`cannot continue ${r.id}: agent "${r.type}" no longer exists`);
	const launch = r.teammate && r.name !== undefined ? teams.launch(r.name, r.teamPrompt) : undefined;
	const spec = resolveAgent(
		def,
		{
			description: r.description,
			prompt: typeof prompt === "string" ? prompt : "",
			resume: r.id,
			model: r.model || undefined,
			effort: r.thinking || undefined,
		},
		getHost().config(),
		parent,
		{
			worktree: r.worktree && { ...r.worktree },
			memoryRoot: await memoryRoot(def.memory, def.name, parent.cwd), // an isolated subagent continues in its worktree
			...(launch ? { team: launch } : {}),
		},
	);
	if (typeof prompt === "function") Object.defineProperty(spec, "prompt", { get: prompt, enumerable: true });
	await exchange(
		parent,
		spec,
		{
			type: r.type,
			description: r.description,
			color: def.color,
			...(said !== undefined ? { said } : {}),
			...(launch && r.name !== undefined
				? {
						teammate: {
							name: r.name,
							team: launch.team,
							...(spec.teamPrompt !== undefined ? { teamPrompt: spec.teamPrompt } : {}),
						},
					}
				: {}),
		},
		undefined,
		() => {},
	);
}
