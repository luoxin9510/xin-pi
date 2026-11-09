// What the user types on a subagent screen: steer it while it runs, or continue it once it is finished.

import { discoverAgents } from "./discovery.ts";
import { exchange, getHost, recordSteer } from "./exchange.ts";
import { registry } from "./registry.ts";
import { type ParentContext, resolveChild } from "./resolve.ts";
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
	const def = discoverAgents(parent.cwd).agents.get(r.type);
	if (!def) throw new Error(`cannot continue ${id}: agent "${r.type}" no longer exists`);
	const done = (async () => {
		const spec = resolveChild(
			def,
			{
				description: r.description,
				prompt: text,
				resume: id,
				model: r.model || undefined,
				effort: r.thinking || undefined,
			},
			getHost().config(),
			parent,
			{ worktree: r.worktree && { ...r.worktree }, memoryRoot: await memoryRoot(def.memory, def.name, parent.cwd) }, // an isolated subagent continues in its worktree
		);
		await exchange(
			parent,
			spec,
			{ type: r.type, description: r.description, color: def.color, said: text },
			undefined,
			() => {},
		);
	})();
	return { delivery: queued ? "queued" : "started", done };
}
