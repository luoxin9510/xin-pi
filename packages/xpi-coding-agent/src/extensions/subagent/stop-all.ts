// Stop everything of a session: every background script (its agents stop with it), then every other running subagent.
// Both the panel's shift+x and `/subagents stop` come here; each goes through the existing registry stop paths.

import { scriptRunning, scripts } from "./background.ts";
import { registry } from "./registry.ts";
import { teams } from "./team.ts";

export async function stopEverything(sessionId: string): Promise<{ agents: number; scripts: number }> {
	const agents = registry
		.list(sessionId)
		.filter((r) => r.status === "running")
		.map((r) => r.id);
	const running = scripts.list(sessionId).filter(scriptRunning).length;
	await scripts.stopAll(sessionId);
	// Teammates that run or wait for a slot stop through the team: the stop holds even if the child is not up yet or the run
	// ends by itself first, and they end stopped. Idle ones are left.
	const team = teams.current();
	const mates = new Set<string>();
	for (const m of team?.live() ?? [])
		if (m.status === "queued" || m.status === "running") {
			mates.add(m.agentId);
			team!.stop(m.name);
		}
	registry.abortQueuedOf(sessionId);
	await registry.stopAll(agents.filter((id) => !mates.has(id)));
	return { agents: agents.length, scripts: running };
}
