// Stop everything of a session: every background script (its agents stop with it), then every other running subagent.
// Both the panel's shift+x and `/subagents stop` come here; each goes through the existing registry stop paths.

import { scripts } from "./background.ts";
import { registry } from "./registry.ts";

export async function stopEverything(sessionId: string): Promise<{ agents: number; scripts: number }> {
  const agents = registry.list(sessionId).filter((r) => r.status === "running").map((r) => r.id);
  const running = scripts.list(sessionId).filter((s) => s.state === "foreground" || s.state === "background").length;
  await scripts.stopAll(sessionId);
  registry.abortQueuedOf(sessionId);
  await registry.stopAll(agents);
  return { agents: agents.length, scripts: running };
}
