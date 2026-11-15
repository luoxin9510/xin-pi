// The claim a held prefix rests on: a refresh sends the provider the same tools and system blocks, with the same cache
// breakpoints, as the request whose prefix it keeps warm. Checked on the Anthropic payload itself, for a model that
// takes system and tool changes in the middle of a conversation and for one that folds them into the head.
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../../xpi-ai/src/api/anthropic-messages.ts";
import { getModel, normalizeContext } from "../../xpi-ai/src/compat.ts";
import type { Context, Message, SystemMessage } from "../../xpi-ai/src/types.ts";
import { heldPrefixContext, prefixSystems } from "../src/core/cache-warmer.ts";

const sseBody = [
	{
		event: "message_start",
		data: { type: "message_start", message: { id: "m", usage: { input_tokens: 1, output_tokens: 0 } } },
	},
	{
		event: "message_delta",
		data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 1, output_tokens: 1 } },
	},
	{ event: "message_stop", data: { type: "message_stop" } },
]
	.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n`)
	.join("\n");

interface Payload {
	system?: unknown[];
	tools?: unknown[];
	messages: unknown[];
}

const tool = (name: string) => ({
	name,
	description: `${name} a file`,
	parameters: { type: "object", properties: {} },
});

const head: SystemMessage = {
	role: "system",
	content: "Preamble text.",
	sections: { relay: "<relay>You are the lead.</relay>", env: "<env>cwd</env>" },
	toolsAdded: [tool("read"), tool("bash")] as never,
	timestamp: 1,
};
// A change during the lead phase: a tool added and a section patched.
const change: SystemMessage = {
	role: "system",
	content: "",
	sections: { env: "<env>cwd, later</env>" },
	toolsAdded: [tool("edit")] as never,
	timestamp: 2,
};
const conversation: Message[] = [
	head,
	{ role: "user", content: "Do the task.", timestamp: 3 },
	change,
	{ role: "user", content: "And this too.", timestamp: 4 },
];

async function capture(modelId: string, context: Context, apiKey: string): Promise<Payload> {
	const model = getModel("anthropic", modelId as never);
	let body: Payload | undefined;
	const fetchMock = async (_url: unknown, init?: RequestInit) => {
		body = JSON.parse(String(init?.body)) as Payload;
		return new Response(sseBody, { status: 200, headers: { "content-type": "text/event-stream" } });
	};
	await streamAnthropic(model, normalizeContext(context as never), {
		apiKey,
		fetch: fetchMock as never,
		maxRetries: 0,
	}).result();
	if (!body) throw new Error("no request captured");
	return body;
}

describe("a refresh of a held prefix on the Anthropic payload", () => {
	for (const [modelId, kind] of [
		["claude-opus-5-5", "takes changes in the middle of a conversation"],
		["claude-opus-4-7", "folds changes into the head"],
	] as const) {
		for (const [key, auth] of [
			["sk-ant-api03-test", "an API key"],
			["sk-ant-oat01-test", "an OAuth token"],
		] as const) {
			it(`sends the request's tools and system blocks: ${modelId} (${kind}), ${auth}`, async () => {
				const request = await capture(modelId, { messages: conversation }, key);
				const refresh = await capture(
					modelId,
					heldPrefixContext({
						systemPrompt: undefined,
						tools: undefined,
						systems: prefixSystems(getModel("anthropic", modelId as never), conversation),
					}),
					key,
				);
				// After the prefix comes the short message and no change of sections or tools: a change sent there would be
				// written to the cache anew at each refresh.
				const after = JSON.stringify(refresh.messages);
				expect(after).not.toContain("edit");
				expect(after).not.toContain("cwd, later");
				expect(request.tools?.length).toBeGreaterThan(0);
				expect(request.system?.length).toBeGreaterThan(0);
				// Equal with their cache_control markers: the lookup at the end of the system prompt hits the same entry.
				expect(refresh.tools).toEqual(request.tools);
				expect(refresh.system).toEqual(request.system);
				expect(JSON.stringify(refresh.system)).toContain("cache_control");
			});
		}
	}

	it("would miss on a folding model with the leading system message alone", async () => {
		const request = await capture("claude-opus-4-7", { messages: conversation }, "sk-ant-api03-test");
		const headOnly = await capture(
			"claude-opus-4-7",
			heldPrefixContext({ systemPrompt: undefined, tools: undefined, systems: [head] }),
			"sk-ant-api03-test",
		);
		expect(headOnly.tools).not.toEqual(request.tools);
	});
});
