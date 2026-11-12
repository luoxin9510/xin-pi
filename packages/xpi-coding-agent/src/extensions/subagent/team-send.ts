// Agent teams: `SendMessage` between members. The write side shared by the lead's tool (send-message-tool.ts) and the
// teammate's (registered in a child process), and the child's tool itself. A message counts as sent once its entry is
// written to the recipient's mailbox; the lead's deliverer (team.ts) takes it from there.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Static, Type } from "typebox";
import { type JsonValue, StringEnum } from "xpi-ai";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { appendEntry, type EntryKind, inboxFile, newEntryId } from "./team-files.ts";
import { taskTools } from "./team-task-tools.ts";
import type { TaskEnv } from "./team-tasks.ts";
import { LEAD, teamLabel } from "./team-text.ts";

export const teamParameters = Type.Object({
	to: Type.String({ description: 'A member of the team: its name, or "lead" (a teammate\'s only way to the lead)' }),
	message: Type.Optional(
		Type.String({ description: "What to tell it. Required unless `kind` is shutdown_response." }),
	),
	summary: Type.Optional(Type.String({ description: "A few words, shown next to the message" })),
	kind: Type.Optional(
		StringEnum(["shutdown_request", "shutdown_response"] as const, {
			description:
				"shutdown_request (lead only): ask a teammate to stop. shutdown_response (teammate, to the lead): answer it with `approve`.",
		}),
	),
	approve: Type.Optional(Type.Boolean({ description: "With shutdown_response: true to stop, false to keep working" })),
});
export type TeamSendInput = Static<typeof teamParameters>;

export const teamOutputSchema = Type.Object(
	{
		status: Type.Literal("sent"),
		to: Type.String(),
		id: Type.String({ description: "The message's id" }),
	},
	{ description: "The message is written to the recipient's mailbox; it is delivered from there" },
);

// What a sender knows of the team: its directory and who is in it (the lead reads its memory, a teammate config.json).
export interface RosterView {
	team: string;
	dir: string;
	members: { name: string; status: string; shutdownRequested?: number }[];
}

// A member that can own a task: it is running, queued or idle.
export const LIVE = ["running", "queued", "idle"];

const roster = (view: RosterView): string => view.members.map((m) => `${m.name} (${m.status})`).join(", ");

// Write `params` as an entry from `from` to its recipient. Throws, saying why, when it cannot be sent.
export async function sendToMember(
	view: RosterView,
	from: string,
	params: TeamSendInput,
): Promise<{ status: "sent"; to: string; id: string; kind: EntryKind }> {
	const to = params.to;
	if (!view.members.some((m) => m.name === from))
		throw new Error(`${from} is not a member of team ${teamLabel(view.team)}`);
	if (to === from) throw new Error("you cannot send a message to yourself");
	const target = view.members.find((m) => m.name === to);
	if (!target) throw new Error(`no member "${to}" in team ${teamLabel(view.team)}. Members: ${roster(view)}`);
	if (target.status === "stopped") throw new Error(`stopped: ${to} has stopped and cannot get messages`);
	const kind = (params.kind ?? "message") as EntryKind;
	if (kind === "shutdown_request") {
		if (from !== LEAD) throw new Error("only the lead can send a shutdown_request");
		if (target.status === "stopping") throw new Error(`${to} is already shutting down`);
	}
	if (kind === "shutdown_response") {
		if (from === LEAD || to !== LEAD) throw new Error('a shutdown_response is a teammate\'s answer, sent to "lead"');
		if (params.approve === undefined)
			throw new Error("a shutdown_response needs `approve`: true to stop, false to keep working");
		const me = view.members.find((m) => m.name === from);
		if (me?.shutdownRequested === undefined) throw new Error("no shutdown request is pending for you");
	}
	const text = params.message ?? (kind === "shutdown_request" ? "Please wrap up and shut down." : "");
	if (params.message === undefined && kind === "message") throw new Error("`message` is required");
	const id = newEntryId();
	await appendEntry(inboxFile(view.dir, to), {
		id,
		from,
		to,
		text: kind === "shutdown_response" && text === "" ? (params.approve ? "approved" : "rejected") : text,
		...(params.summary !== undefined ? { summary: params.summary } : {}),
		kind,
		at: Date.now(),
		...(kind === "shutdown_response" ? { approve: params.approve } : {}),
	});
	return { status: "sent", to, id, kind };
}

// --- the teammate's tool

export const TEAM_SEND_DESCRIPTION = [
	'Send a message to a member of your team by name; "lead" is the session that started you. The call returns once the message is written.',
	"There is no broadcast: one message per recipient. A message to a running member is read after its current step; an idle one wakes up.",
	'To answer a shutdown request from the lead: `kind: "shutdown_response"`, `to: "lead"`, `approve: true` to stop or `false` (with `message`) to keep working.',
].join("\n");

// config.json as a teammate reads it.
function readRoster(dir: string): RosterView {
	let config: { team?: string; members?: RosterView["members"] };
	try {
		config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
	} catch {
		throw new Error("the team has ended: its config.json is gone");
	}
	return { team: config.team ?? "", dir, members: config.members ?? [] };
}

// In a teammate's process (XPI_TEAM_DIR set): `SendMessage` to the team, and the four task-list tools. `exposure` follows what the lead found when it
// started this process (XPI_TEAM_TOOLS): codemode when the child has codemode, else a direct tool.
export function registerTeamTools(pi: ExtensionAPI, env: NodeJS.ProcessEnv = process.env): void {
	const dir = env.XPI_TEAM_DIR;
	const me = env.XPI_TEAM_MEMBER;
	if (!dir || !me) return;
	const exposure = env.XPI_TEAM_TOOLS === "codemode" ? ("codemode" as const) : ("direct" as const);
	// The task list is next to the team's directory: <agent dir>/tasks/<team>.
	const team = env.XPI_TEAM;
	const tasksDir = join(dirname(dirname(dir)), "tasks", team ?? "");
	const taskEnv: TaskEnv = {
		dir: tasksDir,
		team: team ?? "",
		me,
		lead: false,
		live: (name) => readRoster(dir).members.some((m) => m.name === name && LIVE.includes(m.status)),
		hooks: { bus: pi.events, warn: (m) => process.stderr.write(`agent-teams: ${m}\n`) },
	};
	// Without the team's name there is no task directory: the task tools are not registered.
	if (team) for (const tool of taskTools({ exposure, env: () => taskEnv })) pi.registerTool(tool as never);
	pi.registerTool({
		name: "SendMessage",
		label: "SendMessage",
		effect: "write",
		exposure,
		description: TEAM_SEND_DESCRIPTION,
		parameters: teamParameters,
		outputSchema: teamOutputSchema,
		async execute(
			_toolCallId: string,
			params: TeamSendInput,
			_signal: unknown,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		) {
			const sent = await sendToMember(readRoster(dir), me, params);
			// An approved shutdown ends this exchange after the current tool call: the response is written, so the lead will
			// find it.
			if (sent.kind === "shutdown_response" && params.approve === true) ctx.abort();
			const result = { status: sent.status, to: sent.to, id: sent.id };
			return {
				content: [{ type: "text" as const, text: `Sent to ${sent.to} (${sent.id}).` }],
				details: result as never,
				structuredContent: result as unknown as JsonValue,
				isError: false,
			};
		},
	});
}
