// The `SendMessage` tool (spec 03): main reaches a subagent it started, by id or name. A running one is steered (the
// message is taken after its current step) and the call returns at once; a finished one is continued from its session,
// exactly as `Agent({ resume, prompt })` does.

import { type Static, Type } from "typebox";
import type { JsonValue } from "xpi-ai";
import type { ExtensionContext } from "../../core/extensions/types.ts";
import { type AgentInput, type AgentResult, outputSchema as agentOutput, type agentTool } from "./agent-tool.ts";
import { registry } from "./registry.ts";
import { teams } from "./team.ts";
import { sendToMember, type TeamSendInput, teamParameters } from "./team-send.ts";
import { LEAD } from "./team-text.ts";

const parameters = Type.Object({
	to: Type.String({ description: "The agent: its name, or the agentId from a result" }),
	message: Type.String({ description: "What to tell it. It has its own session's context, nothing of yours." }),
	summary: Type.Optional(Type.String({ description: "Accepted and unused" })),
});
type SendInput = Static<typeof parameters>;

// What the codemode declaration shows of the result: an Agent result (see Agent's declaration), or for a steer only
// `status: "running"`, `agentId` and `delivered`. The declaration is in every prompt, so it does not repeat Agent's.
const outputSchema = Type.Object(
	{
		status: agentOutput.properties.status,
		agentId: Type.String(),
		delivered: Type.Optional(Type.String({ description: '"steer": the agent was running and got the message' })),
		output: Type.Optional(Type.String()),
	},
	{ description: "For a finished agent, every field of an Agent result" },
);

export const SEND_MESSAGE_DESCRIPTION = [
	"Send a message to a subagent this session started, by name (the `name` of its Agent call) or agentId.",
	'A running agent takes it as a steer after its current step: the call returns status "running" and `delivered: "steer"`.',
	"A finished agent is continued from its session, like Agent({ resume, prompt: message }): the call returns that result.",
].join("\n");

// With agent teams on: the tool also reaches the team's members and answers shutdown requests (team-send.ts).
export const TEAM_SEND_MESSAGE_DESCRIPTION = [
	SEND_MESSAGE_DESCRIPTION,
	'Agent teams are on: a teammate (an Agent call with `name`) is a member of the team. A message to a member is written to its mailbox and the call returns `{ status: "sent", to, id }`; a running member reads it after its current step, an idle one wakes up. A name of an earlier teammate (after a resume or reload) continues it as a member.',
	'Ask a member to stop with `kind: "shutdown_request"` (`message` is optional): it approves or refuses with a reason.',
].join("\n");

const teamOutputSchema = Type.Object(
	{
		status: Type.Union([
			agentOutput.properties.status,
			Type.Literal("sent"),
			Type.Literal("started"),
			Type.Literal("queued"),
		]),
		agentId: Type.Optional(Type.String()),
		to: Type.Optional(Type.String()),
		id: Type.Optional(Type.String({ description: "A member's message id" })),
		delivered: Type.Optional(Type.String({ description: '"steer": the agent was running and got the message' })),
		output: Type.Optional(Type.String()),
	},
	{ description: "To a member: sent. To a finished subagent: every field of an Agent result" },
);

export function sendMessageTool(agent: ReturnType<typeof agentTool>, withTeams = false) {
	const params = withTeams ? (teamParameters as unknown as typeof parameters) : parameters;
	return {
		name: "SendMessage",
		label: "SendMessage",
		effect: "write" as const,
		exposure: "codemode" as const,
		description: withTeams ? TEAM_SEND_MESSAGE_DESCRIPTION : SEND_MESSAGE_DESCRIPTION,
		parameters: params,
		outputSchema: withTeams ? (teamOutputSchema as unknown as typeof outputSchema) : outputSchema,
		async execute(
			toolCallId: string,
			params: SendInput | TeamSendInput,
			signal: AbortSignal | undefined,
			onUpdate: Parameters<ReturnType<typeof agentTool>["execute"]>[3],
			ctx: ExtensionContext,
		) {
			const sessionId = ctx.sessionManager.getSessionId();
			if (teams.on) {
				const team = teams.current();
				const member = team?.member(params.to);
				const kind = "kind" in params ? params.kind : undefined;
				if (params.to === LEAD) throw new Error("you are the lead");
				if (team && member) {
					if (kind === "shutdown_response") throw new Error("only a teammate answers a shutdown request");
					// The teammate's answer needs the mark, so it is set before the request can arrive; a request that could
					// not be sent leaves what was there before.
					const before = kind === "shutdown_request" ? team.markShutdownRequested(member.name) : undefined;
					let sent: Awaited<ReturnType<typeof sendToMember>>;
					try {
						sent = await sendToMember(
							{ team: team.name, dir: team.dir, members: [...team.members.values()] },
							LEAD,
							params as TeamSendInput,
						);
					} catch (err) {
						if (kind === "shutdown_request") team.restoreShutdownRequested(member.name, before);
						throw err;
					}
					team.kick();
					const result = { status: sent.status, to: sent.to, id: sent.id };
					return {
						content: [{ type: "text" as const, text: `Sent to ${sent.to} (${sent.id}).` }],
						details: result as unknown as AgentResult | undefined,
						structuredContent: result as unknown as JsonValue,
						isError: false,
					};
				}
				const known = registry.find(sessionId, params.to);
				const record = known === undefined ? undefined : registry.get(known);
				if (record?.teammate && record.name !== undefined) {
					// An earlier teammate (after /resume, /reload or a crash): the message continues it as a member.
					if (kind !== undefined)
						throw new Error(`"${kind}" is for members of the current team; ${record.name} is not one yet`);
					if (params.message === undefined) throw new Error("`message` is required");
					return agent.execute(
						toolCallId,
						{ description: record.description, prompt: params.message, name: record.name } as AgentInput,
						signal,
						onUpdate,
						ctx,
					);
				}
				if ("kind" in params && params.kind !== undefined) {
					throw new Error(`"${params.kind}" is for team members: "${params.to}" is not one`);
				}
			}
			if (params.message === undefined) throw new Error("`message` is required");
			const id = registry.find(sessionId, params.to);
			const record = id === undefined ? undefined : registry.get(id);
			if (!record) {
				const known = registry.list(sessionId).map((r) => (r.name ? `${r.name} (${r.id})` : r.id));
				throw new Error(
					`no agent "${params.to}" in this session. ${known.length > 0 ? `Agents: ${known.join(", ")}` : "It has started none."}`,
				);
			}
			// Main's own steer is not noted back to main (the note is for what the user said on the agent's screen).
			if (registry.handle(record.id)?.send({ type: "steer", message: params.message })) {
				const result = { status: "running" as const, agentId: record.id, delivered: "steer" };
				return {
					content: [
						{
							type: "text" as const,
							text: `Delivered to ${record.name ?? record.id} as a steer; it is running.`,
						},
					],
					details: result as unknown as AgentResult | undefined,
					structuredContent: result as unknown as JsonValue,
					isError: false,
				};
			}
			return agent.execute(
				toolCallId,
				{ description: record.description, prompt: params.message, resume: record.id } as AgentInput,
				signal,
				onUpdate,
				ctx,
			);
		},
	};
}
