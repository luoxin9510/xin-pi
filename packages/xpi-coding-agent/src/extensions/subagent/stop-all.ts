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
	// Teammates waiting for a slot (a first start or a wake) stop through the team, so they end stopped; idle ones are left.
	const team = teams.current();
	for (const m of team?.live() ?? []) if (m.status === "queued") team!.stop(m.name);
	registry.abortQueuedOf(sessionId);
	await registry.stopAll(agents);
	return { agents: agents.length, scripts: running };
}
