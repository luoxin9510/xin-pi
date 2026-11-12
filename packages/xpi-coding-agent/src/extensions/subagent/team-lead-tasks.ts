// Agent teams: the lead's side of the task list. The session's own task list, `lead` as the caller, the roster from memory
// (the team may not exist yet: the lead can write tasks before it starts a teammate).

import { join } from "node:path";
import type { EventBus } from "../../core/event-bus.ts";
import type { ExtensionContext } from "../../core/extensions/types.ts";
import { teams } from "./team.ts";
import { sendToMember, type TeamSendInput } from "./team-send.ts";
import { assignmentText, type TaskEnv, tasksRoot } from "./team-tasks.ts";
import { LEAD } from "./team-text.ts";

export function leadTaskEnv(ctx: ExtensionContext, bus: EventBus): TaskEnv {
	const team = `session-${ctx.sessionManager.getSessionId()}`;
	const status = (name: string) => (name === LEAD ? "running" : teams.current()?.members.get(name)?.status);
	return {
		dir: join(tasksRoot(), team),
		team,
		me: LEAD,
		lead: true,
		live: (name) => ["running", "queued", "idle"].includes(status(name) ?? ""),
		async assign(task, owner) {
			const current = teams.current();
			if (!current) throw new Error(`no member "${owner}": the team has no teammates yet`);
			await sendToMember({ team: current.name, dir: current.dir, members: [...current.members.values()] }, LEAD, {
				to: owner,
				message: assignmentText(task),
				summary: `task #${task.id} assigned`,
			} as TeamSendInput);
			current.kick();
		},
		hooks: {
			bus,
			warn: (message) => {
				if (ctx.hasUI) ctx.ui.notify(`agent-teams: ${message}`, "warning");
				else process.stderr.write(`agent-teams: ${message}\n`);
			},
		},
	};
}
