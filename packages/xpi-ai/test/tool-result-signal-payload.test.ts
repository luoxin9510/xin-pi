import { describe, expect, it } from "vitest";
import { streamSimple } from "../src/compat.ts";
import type { AssistantMessage, Context, Model } from "../src/types.ts";

class PayloadCaptured extends Error {
	constructor() {
		super("payload captured");
		this.name = "PayloadCaptured";
	}
}

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const anthropicModel: Model<"anthropic-messages"> = {
	id: "claude-test",
	name: "Claude Test",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "http://127.0.0.1:9",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 1024,
};

const completionsModel: Model<"openai-completions"> = {
	id: "gpt-test",
	name: "GPT Test",
	api: "openai-completions",
	provider: "openai",
	baseUrl: "http://127.0.0.1:9",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 1024,
};

function contextFor(model: Model<"anthropic-messages"> | Model<"openai-completions">): Context {
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [{ type: "toolCall", id: "call-1", name: "handover", arguments: {} }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage,
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
	return {
		messages: [
			{ role: "user", content: "go", timestamp: Date.now() },
			assistant,
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "handover",
				content: [{ type: "text", text: "Handed over" }],
				signal: { type: "relay.handover", data: { round: 7 } },
				isError: false,
				timestamp: Date.now(),
			},
		],
	};
}

async function capture(model: Model<"anthropic-messages"> | Model<"openai-completions">): Promise<unknown> {
	let captured: unknown;
	const stream = streamSimple(model, contextFor(model), {
		apiKey: "fake-key",
		cacheRetention: "none",
		onPayload: (payload) => {
			captured = payload;
			throw new PayloadCaptured();
		},
	});
	await stream.result();
	if (captured === undefined) throw new Error("Expected payload capture before request");
	return captured;
}

describe("ToolResultMessage.signal", () => {
	for (const [name, model] of [
		["Anthropic", anthropicModel],
		["OpenAI completions", completionsModel],
	] as const) {
		it(`is not part of the ${name} payload`, async () => {
			const json = JSON.stringify(await capture(model));
			expect(json).toContain("Handed over");
			expect(json).not.toContain("relay.handover");
			expect(json).not.toContain("signal");
		});
	}
});
