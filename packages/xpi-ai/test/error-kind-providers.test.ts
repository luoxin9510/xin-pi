import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { stream as streamGoogle } from "../src/api/google-generative-ai.ts";
import { stream as streamMistral } from "../src/api/mistral-conversations.ts";
import { stream as streamCodex } from "../src/api/openai-codex-responses.ts";
import { stream as streamPiMessages } from "../src/api/pi-messages.ts";
import type { AssistantMessage, FetchFunction, Model } from "../src/types.ts";
import { isContextOverflow } from "../src/utils/overflow.ts";
import { isRetryableAssistantError } from "../src/utils/retry.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

// Real error shapes of the remaining providers: Google through the real @google/genai SDK against a local server,
// Mistral, Codex and pi-messages through their own fetch.

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

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

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

function serverJson(status: number, body: unknown): Reply {
	return (_req, res) => {
		res.writeHead(status, { "content-type": "application/json" });
		res.end(JSON.stringify(body));
	};
}

describe("google-generative-ai fills error fields", () => {
	const call = (): Promise<AssistantMessage> => {
		const model: Model<"google-generative-ai"> = {
			...baseModel,
			id: "gemini-test",
			api: "google-generative-ai",
			provider: "google",
			baseUrl,
		};
		return streamGoogle(model, context, { apiKey: "test" }).result();
	};

	it("classifies RESOURCE_EXHAUSTED rate limits as rate_limit", async () => {
		reply = serverJson(429, {
			error: { code: 429, message: "Resource has been exhausted", status: "RESOURCE_EXHAUSTED" },
		});
		expect(await call()).toMatchObject({ stopReason: "error", errorKind: "rate_limit", errorStatus: 429 });
	});

	it("classifies a spent quota as usage_limit", async () => {
		reply = serverJson(429, {
			error: {
				code: 429,
				message: "You exceeded your current quota, please check your plan and billing details.",
				status: "RESOURCE_EXHAUSTED",
			},
		});
		expect(await call()).toMatchObject({ errorKind: "usage_limit", errorStatus: 429 });
	});

	it("classifies UNAVAILABLE as transient", async () => {
		reply = serverJson(503, { error: { code: 503, message: "The model is overloaded.", status: "UNAVAILABLE" } });
		const result = await call();
		expect(result).toMatchObject({ errorKind: "transient", errorStatus: 503 });
		expect(isRetryableAssistantError(result)).toBe(true);
	});

	it("classifies an invalid key as auth", async () => {
		reply = serverJson(400, { error: { code: 400, message: "API key not valid.", status: "INVALID_ARGUMENT" } });
		const bad = await call();
		// Google reports a bad key as a 400; only the status decides here, so it is a plain bad request.
		expect(bad).toMatchObject({ errorKind: "invalid_request", errorStatus: 400 });
		reply = serverJson(403, { error: { code: 403, message: "Permission denied", status: "PERMISSION_DENIED" } });
		expect(await call()).toMatchObject({ errorKind: "auth", errorStatus: 403 });
	});

	it("classifies an input-token overflow on a 400 as context_overflow", async () => {
		reply = serverJson(400, {
			error: {
				code: 400,
				message: "The input token count (1196265) exceeds the maximum number of tokens allowed (1048575).",
				status: "INVALID_ARGUMENT",
			},
		});
		const result = await call();
		expect(result).toMatchObject({ errorKind: "context_overflow", errorStatus: 400 });
		expect(isContextOverflow(result)).toBe(true);
	});

	it("classifies a dropped connection as transient", async () => {
		reply = (req) => req.socket.destroy();
		const result = await call();
		expect(result).toMatchObject({ stopReason: "error", errorKind: "transient" });
	});
});

describe("mistral-conversations fills error fields", () => {
	const call = (response: Response): Promise<AssistantMessage> => {
		const model: Model<"mistral-conversations"> = {
			...baseModel,
			id: "mistral-test",
			api: "mistral-conversations",
			provider: "mistral",
			baseUrl: "https://mistral.invalid",
		};
		const fetch: FetchFunction = async () => response;
		return streamMistral(model, context, { apiKey: "test", fetch }).result();
	};

	it("classifies a 429 with retry-after", async () => {
		const result = await call(
			jsonResponse(429, { message: "Rate limit exceeded", type: "rate_limited" }, { "retry-after": "3" }),
		);
		expect(result).toMatchObject({ errorKind: "rate_limit", errorStatus: 429, retryAfterMs: 3000 });
	});

	it("classifies a 5xx as transient and a 401 as auth", async () => {
		expect(await call(jsonResponse(503, { message: "Service unavailable" }))).toMatchObject({
			errorKind: "transient",
			errorStatus: 503,
		});
		expect(await call(jsonResponse(401, { message: "Unauthorized" }))).toMatchObject({ errorKind: "auth" });
	});

	it("classifies Mistral overflow text on a 400 as context_overflow", async () => {
		const result = await call(
			jsonResponse(400, {
				message:
					"Prompt contains 40000 tokens and 0 draft tokens, too large for model with 32768 maximum context length",
			}),
		);
		expect(result).toMatchObject({ errorKind: "context_overflow", errorStatus: 400 });
	});
});

describe("pi-messages fills error fields", () => {
	const call = (response: Response): Promise<AssistantMessage> => {
		const model: Model<"pi-messages"> = {
			...baseModel,
			id: "pi-test",
			api: "pi-messages",
			provider: "pi-gateway",
			baseUrl: "https://gateway.invalid",
		};
		const fetch: FetchFunction = async () => response;
		return streamPiMessages(model, context, { apiKey: "test", fetch }).result();
	};

	it("classifies an HTTP failure by status and retry-after", async () => {
		const result = await call(jsonResponse(429, { error: { message: "slow down" } }, { "retry-after-ms": "400" }));
		expect(result).toMatchObject({ errorKind: "rate_limit", errorStatus: 429, retryAfterMs: 400 });
	});

	it("classifies a relayed error event by its text", async () => {
		const event = {
			type: "error",
			reason: "error",
			usage: {},
			errorMessage: "Anthropic stream ended before message_stop",
		};
		const body = `data: ${JSON.stringify(event)}\n\n`;
		const result = await call(new Response(body, { headers: { "content-type": "text/event-stream" } }));
		expect(result).toMatchObject({ stopReason: "error", errorKind: "transient" });
	});
});

describe("openai-codex-responses fills error fields and retries by kind", () => {
	function mockToken(): string {
		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toString("base64");
		return `aaa.${payload}.bbb`;
	}

	const sseDone = (): Response =>
		new Response(
			`data: ${JSON.stringify({
				type: "response.completed",
				response: {
					status: "completed",
					usage: {
						input_tokens: 1,
						output_tokens: 1,
						total_tokens: 2,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			})}\n\n`,
			{ headers: { "content-type": "text/event-stream" } },
		);

	const run = async (responses: Array<() => Response>, maxRetries = 0) => {
		const model: Model<"openai-codex-responses"> = {
			...baseModel,
			id: "gpt-test",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://codex.invalid/backend-api",
		};
		const fetch = vi.fn(async () => (responses.shift() ?? sseDone)());
		const result = await streamCodex(model, context, {
			apiKey: mockToken(),
			transport: "sse",
			maxRetries,
			fetch: fetch as FetchFunction,
		}).result();
		return { result, calls: fetch.mock.calls.length };
	};

	it("classifies a usage-limit 429 as usage_limit and does not retry it", async () => {
		const body = { error: { type: "usage_limit_reached", message: "limit", plan_type: "plus", resets_at: 1 } };
		const { result, calls } = await run([() => jsonResponse(429, body)], 2);
		expect(result).toMatchObject({ errorKind: "usage_limit", errorStatus: 429 });
		expect(result.errorMessage).toContain("usage limit");
		expect(calls).toBe(1);
	});

	it("retries a plain 429 and honours retry-after-ms", async () => {
		const { result, calls } = await run(
			[() => jsonResponse(429, { error: { message: "slow down" } }, { "retry-after-ms": "1" })],
			1,
		);
		expect(result.stopReason).toBe("stop");
		expect(calls).toBe(2);
	});

	it("does not retry billing text on a 429", async () => {
		const { result, calls } = await run(
			[() => jsonResponse(429, { error: { message: "billing hard limit reached" } })],
			2,
		);
		expect(result).toMatchObject({ errorKind: "usage_limit" });
		expect(calls).toBe(1);
	});

	it("retries a 503 and a network failure", async () => {
		const { result, calls } = await run(
			[
				() => jsonResponse(503, { error: { message: "unavailable" } }, { "retry-after-ms": "1" }),
				() => {
					throw new TypeError("fetch failed", {
						cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }),
					});
				},
			],
			2,
		);
		expect(result.stopReason).toBe("stop");
		expect(calls).toBe(3);
	});

	it("does not retry a 400", async () => {
		const { result, calls } = await run([() => jsonResponse(400, { error: { message: "bad field" } })], 2);
		expect(result).toMatchObject({ errorKind: "invalid_request", errorStatus: 400 });
		expect(calls).toBe(1);
	});

	it("keeps the status and wait when the requested delay is too long", async () => {
		const model: Model<"openai-codex-responses"> = {
			...baseModel,
			id: "gpt-test",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://codex.invalid/backend-api",
		};
		const result = await streamCodex(model, context, {
			apiKey: mockToken(),
			transport: "sse",
			maxRetries: 2,
			maxRetryDelayMs: 1000,
			fetch: (async () =>
				jsonResponse(429, { error: { message: "slow" } }, { "retry-after": "5" })) as FetchFunction,
		}).result();
		expect(result).toMatchObject({ errorKind: "rate_limit", errorStatus: 429, retryAfterMs: 5000 });
		expect(result.errorMessage).toBe("Server requested 5s retry delay (max: 1s)");
	});

	it("classifies a mid-stream error event by its code", async () => {
		const body = `data: ${JSON.stringify({ type: "error", code: "usage_limit_reached", message: "plan spent" })}\n\n`;
		const { result } = await run([() => new Response(body, { headers: { "content-type": "text/event-stream" } })]);
		expect(result).toMatchObject({ stopReason: "error", errorKind: "usage_limit" });
	});
});
