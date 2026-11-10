// The `SendMessage` tool (spec 03): main reaches a subagent it started, by id or name. A running one is steered (the
// message is taken after its current step) and the call returns at once; a finished one is continued from its session,
// exactly as `Agent({ resume, prompt })` does.

import { type Static, Type } from "typebox";
import type { JsonValue } from "xpi-ai";
import type { ExtensionContext } from "../../core/extensions/types.ts";
import { type AgentInput, type AgentResult, outputSchema as agentOutput, type agentTool } from "./agent-tool.ts";
import { registry } from "./registry.ts";

const parameters = Type.Object({
	to: Type.String({ description: "The agent: its name, or the agentId from a result" }),
	message: Type.String({ description: "What to tell it. It has its own session's context, nothing of yours." }),
	summary: Type.Optional(Type.String({ description: "Accepted and unused" })),
});
type SendInput = Static<typeof parameters>;

// An Agent result, or for a steer only `status: "running"`, `agentId` and `delivered`.
const outputSchema = Type.Object({
	...Type.Partial(agentOutput).properties,
	status: agentOutput.properties.status,
	agentId: Type.String(),
	delivered: Type.Optional(Type.String({ description: '"steer" when the agent was running and got the message' })),
});

export const SEND_MESSAGE_DESCRIPTION = [
	"Send a message to a subagent this session started, by name (the `name` of its Agent call) or agentId.",
	'A running agent gets it as a steer, taken after its current step: the call returns at once with status "running"',
	'and `delivered: "steer"`; its answer is part of the result its Agent call (or its end message) gives.',
	"A finished agent (completed, partial, failed or stopped) is continued from its session with the message, exactly",
	"like Agent({ resume, prompt: message }): the call returns that Agent result, under the same background rules.",
].join("\n");

export function sendMessageTool(agent: ReturnType<typeof agentTool>) {
	return {
		name: "SendMessage",
		label: "SendMessage",
		exposure: "codemode" as const,
		description: SEND_MESSAGE_DESCRIPTION,
		parameters,
		outputSchema,
		async execute(
			toolCallId: string,
			params: SendInput,
			signal: AbortSignal | undefined,
			onUpdate: Parameters<ReturnType<typeof agentTool>["execute"]>[3],
			ctx: ExtensionContext,
		) {
			const sessionId = ctx.sessionManager.getSessionId();
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
