import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import { stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import type { AssistantMessage, Model } from "../src/types.ts";
import { classifyErrorText, classifyProviderError, parseRetryAfterMs } from "../src/utils/error-kind.ts";
import { isContextOverflow } from "../src/utils/overflow.ts";
import { isRetryableAssistantError, type RetryPolicy, retryAssistantCall } from "../src/utils/retry.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

describe("classifyProviderError", () => {
	it("classifies connection failures on the cause chain as transient", () => {
		const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), { code: "ECONNREFUSED" });
		const error = new TypeError("fetch failed", { cause });
		expect(classifyProviderError(error)).toEqual({ kind: "transient" });
	});

	it("classifies SDK connection error classes as transient", () => {
		class APIConnectionError extends Error {}
		expect(classifyProviderError(new APIConnectionError("Connection error.")).kind).toBe("transient");
	});

	it("maps statuses", () => {
		const kind = (status: number, message = "x") =>
			classifyProviderError(Object.assign(new Error(message), { status })).kind;
		expect(kind(401)).toBe("auth");
		expect(kind(403)).toBe("auth");
		expect(kind(402)).toBe("usage_limit");
		expect(kind(408)).toBe("transient");
		expect(kind(429)).toBe("rate_limit");
		expect(kind(500)).toBe("transient");
		expect(kind(529)).toBe("transient");
		expect(kind(413)).toBe("context_overflow");
		expect(kind(404)).toBe("invalid_request");
		expect(kind(400, "bad field")).toBe("invalid_request");
		expect(kind(400, "prompt is too long: 213462 tokens > 200000 maximum")).toBe("context_overflow");
	});

	it("lets overflow and quota text outrank the status", () => {
		const kind = (status: number, message: string) =>
			classifyProviderError(Object.assign(new Error(message), { status })).kind;
		expect(kind(500, "This model's maximum context length is 8192 tokens")).toBe("context_overflow");
		expect(kind(429, "This model's maximum context length is 8192 tokens")).toBe("context_overflow");
		expect(kind(503, "You exceeded your current quota, check your plan and billing")).toBe("usage_limit");
		expect(kind(429, "Too many requests")).toBe("rate_limit");
		expect(kind(429, "Rate limit reached: too many tokens per minute")).toBe("rate_limit");
	});

	it("reads quota codes and text on a 429", () => {
		const quota = Object.assign(new Error("429 quota"), { status: 429, code: "insufficient_quota" });
		expect(classifyProviderError(quota).kind).toBe("usage_limit");
		const zhipu = Object.assign(new Error('429 {"code":"1308","message":"limit"}'), { status: 429 });
		expect(classifyProviderError(zhipu).kind).toBe("usage_limit");
	});

	it("reads the provider code on a parsed body without a status", () => {
		const error = Object.assign(new Error("stream error"), {
			error: { type: "error", error: { type: "overloaded_error" } },
		});
		expect(classifyProviderError(error).kind).toBe("transient");
	});

	it("reads provider codes quoted in streamed error text", () => {
		expect(classifyProviderError(new Error('{"type":"error","error":{"type":"rate_limit_error"}}')).kind).toBe(
			"rate_limit",
		);
		expect(classifyProviderError(new Error("rate_limit_exceeded: slow down")).kind).toBe("rate_limit");
		expect(classifyProviderError(new Error("Error Code context_length_exceeded: too long")).kind).toBe(
			"context_overflow",
		);
	});

	it("falls back to text when nothing else is known", () => {
		expect(classifyProviderError(new Error("Anthropic stream ended before message_stop")).kind).toBe("transient");
		expect(classifyProviderError(new Error("something odd")).kind).toBe("unknown");
		expect(classifyErrorText("429 Too many requests")).toBe("rate_limit");
	});

	it("parses retry-after headers", () => {
		expect(parseRetryAfterMs(new Headers({ "retry-after-ms": "1500" }))).toBe(1500);
		expect(parseRetryAfterMs(new Headers({ "retry-after": "7" }))).toBe(7000);
		expect(parseRetryAfterMs({ "Retry-After": "2" })).toBe(2000);
		expect(parseRetryAfterMs(new Headers())).toBeUndefined();
	});
});

function failed(overrides: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "m",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		timestamp: 0,
		...overrides,
	};
}

describe("kind-aware retry and overflow checks", () => {
	it("trusts errorKind over text", () => {
		expect(isRetryableAssistantError(failed({ errorMessage: "overloaded", errorKind: "auth" }))).toBe(false);
		expect(isRetryableAssistantError(failed({ errorMessage: "weird", errorKind: "rate_limit" }))).toBe(true);
		expect(isRetryableAssistantError(failed({ errorMessage: "weird", errorKind: "transient" }))).toBe(true);
		expect(isRetryableAssistantError(failed({ errorMessage: "rate limit", errorKind: "usage_limit" }))).toBe(false);
		expect(isContextOverflow(failed({ errorMessage: "weird", errorKind: "context_overflow" }))).toBe(true);
		expect(isContextOverflow(failed({ errorMessage: "prompt is too long", errorKind: "invalid_request" }))).toBe(
			false,
		);
	});

	it("keeps the text rules for messages without a kind", () => {
		expect(isRetryableAssistantError(failed({ errorMessage: "overloaded" }))).toBe(true);
		expect(isContextOverflow(failed({ errorMessage: "prompt is too long" }))).toBe(true);
	});

	const policy: RetryPolicy = { enabled: true, maxRetries: 2, baseDelayMs: 1, maxAgentDelayMs: 1000 };

	it("waits retryAfterMs instead of the computed backoff", async () => {
		const responses = [
			failed({ errorMessage: "slow down", errorKind: "rate_limit", retryAfterMs: 20 }),
			failed({ stopReason: "stop" }),
		];
		const delays: number[] = [];
		const result = await retryAssistantCall(async () => responses.shift()!, policy, undefined, {
			onRetryScheduled: (_attempt, _max, delayMs) => {
				delays.push(delayMs);
			},
		});
		expect(result.stopReason).toBe("stop");
		expect(delays).toEqual([20]);
	});

	it("stops at once when the requested wait exceeds maxAgentDelayMs", async () => {
		let calls = 0;
		const result = await retryAssistantCall(
			async () => {
				calls++;
				return failed({ errorMessage: "slow down", errorKind: "rate_limit", retryAfterMs: 5000 });
			},
			{ ...policy, maxAgentDelayMs: 1000 },
			undefined,
		);
		expect(calls).toBe(1);
		expect(result.errorMessage).toContain("slow down");
		expect(result.errorMessage).toContain("wait 5s");
		expect(result.errorMessage).toContain("1s");
	});

	it("does not retry usage_limit", async () => {
		let calls = 0;
		await retryAssistantCall(
			async () => {
				calls++;
				return failed({ errorMessage: "overloaded", errorKind: "usage_limit" });
			},
			policy,
			undefined,
		);
		expect(calls).toBe(1);
	});
});

// Real SDK error objects: the providers talk to a local server that answers with each failure shape.
type Reply = (req: IncomingMessage, res: ServerResponse) => void;
let server: Server;
let baseUrl: string;
let reply: Reply = () => {};

beforeAll(async () => {
	server = createServer((req, res) => reply(req, res));
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

function json(status: number, body: unknown, headers: Record<string, string> = {}): Reply {
	return (_req, res) => {
		res.writeHead(status, { "content-type": "application/json", ...headers });
		res.end(JSON.stringify(body));
	};
}

function sse(events: Array<{ event?: string; data: unknown }>): Reply {
	return (_req, res) => {
		res.writeHead(200, { "content-type": "text/event-stream" });
		for (const { event, data } of events) {
			res.write(`${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`);
		}
		res.end();
	};
}

const context = normalizeContext({
	systemPrompt: "",
	messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 }],
	tools: [],
});

const baseModel = {
	name: "Test",
	reasoning: false,
	input: ["text"] as ("text" | "image")[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

type Call = () => Promise<AssistantMessage>;
const providers: Array<[string, Call]> = [
	[
		"anthropic-messages",
		async () => {
			const model: Model<"anthropic-messages"> = {
				...baseModel,
				id: "claude-test",
				api: "anthropic-messages",
				provider: "anthropic",
				baseUrl,
			};
			return streamAnthropic(model, context, { apiKey: "test", cacheRetention: "none" }).result();
		},
	],
	[
		"openai-completions",
		async () => {
			const model: Model<"openai-completions"> = {
				...baseModel,
				id: "test",
				api: "openai-completions",
				provider: "opencode-go",
				baseUrl: `${baseUrl}/v1`,
			};
			return streamOpenAICompletions(model, context, { apiKey: "test" }).result();
		},
	],
	[
		"openai-responses",
		async () => {
			const model: Model<"openai-responses"> = {
				...baseModel,
				id: "test",
				api: "openai-responses",
				provider: "openai",
				baseUrl: `${baseUrl}/v1`,
			};
			return streamOpenAIResponses(model, context, { apiKey: "test" }).result();
		},
	],
];

describe.each(providers)("%s fills error fields", (_name, call) => {
	it("classifies a 529 overloaded response as transient", async () => {
		reply = json(529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } });
		const result = await call();
		expect(result).toMatchObject({ stopReason: "error", errorKind: "transient", errorStatus: 529 });
	});

	it("classifies a 429 as rate_limit and reads retry-after", async () => {
		reply = json(
			429,
			{
				type: "error",
				error: { type: "rate_limit_error", message: "slow down" },
				...{ code: "rate_limit_exceeded" },
			},
			{ "retry-after": "7" },
		);
		const result = await call();
		expect(result).toMatchObject({ errorKind: "rate_limit", errorStatus: 429, retryAfterMs: 7000 });
	});

	it("classifies retry-after-ms", async () => {
		reply = json(
			429,
			{ error: { message: "slow down", type: "requests", code: "rate_limit_exceeded" } },
			{ "retry-after-ms": "250" },
		);
		const result = await call();
		expect(result).toMatchObject({ errorKind: "rate_limit", retryAfterMs: 250 });
	});

	it("classifies an exhausted quota as usage_limit, not rate_limit", async () => {
		reply = json(429, {
			error: { message: "You exceeded your current quota", type: "insufficient_quota", code: "insufficient_quota" },
		});
		const result = await call();
		expect(result).toMatchObject({ errorKind: "usage_limit", errorStatus: 429 });
	});

	it("classifies a 401 as auth", async () => {
		reply = json(401, { error: { message: "invalid x-api-key", type: "authentication_error" } });
		const result = await call();
		expect(result).toMatchObject({ errorKind: "auth", errorStatus: 401 });
	});

	it("classifies a 400 overflow text as context_overflow", async () => {
		reply = json(400, {
			error: { message: "prompt is too long: 213462 tokens > 200000 maximum", type: "invalid_request_error" },
		});
		const result = await call();
		expect(result).toMatchObject({ errorKind: "context_overflow", errorStatus: 400 });
		expect(isContextOverflow(result)).toBe(true);
	});

	it("classifies another 400 as invalid_request", async () => {
		reply = json(400, { error: { message: "messages: field required", type: "invalid_request_error" } });
		const result = await call();
		expect(result).toMatchObject({ errorKind: "invalid_request", errorStatus: 400 });
		expect(isRetryableAssistantError(result)).toBe(false);
	});

	it("classifies a connection that closes without a response as transient", async () => {
		reply = (req) => req.socket.destroy();
		const result = await call();
		expect(result).toMatchObject({ stopReason: "error", errorKind: "transient" });
		expect(result.errorStatus).toBeUndefined();
	});
});

describe("streamed error events", () => {
	it("anthropic: an SSE error event is classified by its error type", async () => {
		reply = sse([
			{ event: "error", data: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } } },
		]);
		const result = await providers[0][1]();
		expect(result).toMatchObject({ stopReason: "error", errorKind: "transient" });
	});

	it("openai-responses: response.failed carries the error code", async () => {
		reply = sse([
			{
				event: "response.failed",
				data: {
					type: "response.failed",
					sequence_number: 0,
					response: {
						id: "r",
						status: "failed",
						error: { code: "rate_limit_exceeded", message: "Rate limit reached" },
					},
				},
			},
		]);
		const result = await providers[2][1]();
		expect(result).toMatchObject({ stopReason: "error", errorKind: "rate_limit" });
	});

	it("openai-responses: an insufficient_quota code is usage_limit", async () => {
		reply = sse([
			{
				event: "response.failed",
				data: {
					type: "response.failed",
					sequence_number: 0,
					response: {
						id: "r",
						status: "failed",
						error: { code: "insufficient_quota", message: "You exceeded your quota" },
					},
				},
			},
		]);
		const result = await providers[2][1]();
		expect(result).toMatchObject({ errorKind: "usage_limit" });
	});
});
