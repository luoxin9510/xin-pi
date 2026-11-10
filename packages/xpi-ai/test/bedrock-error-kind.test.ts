import { beforeEach, describe, expect, it, vi } from "vitest";

type SendResult = { kind: "reject"; error: unknown } | { kind: "resolve"; response: unknown };

const bedrockMock = vi.hoisted(() => ({
	send: undefined as SendResult | undefined,
	ServiceException: undefined as unknown as new (message?: string) => Error,
}));

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
	class BedrockRuntimeServiceException extends Error {}
	bedrockMock.ServiceException = BedrockRuntimeServiceException;

	class BedrockRuntimeClient {
		middlewareStack = { add: () => {} };

		send(): Promise<unknown> {
			const outcome = bedrockMock.send;
			if (!outcome) return Promise.reject(new Error("test did not configure a send outcome"));
			return outcome.kind === "reject" ? Promise.reject(outcome.error) : Promise.resolve(outcome.response);
		}
	}

	class ConverseStreamCommand {
		readonly input: unknown;
		constructor(input: unknown) {
			this.input = input;
		}
	}

	return {
		BedrockRuntimeClient,
		BedrockRuntimeServiceException,
		ConverseStreamCommand,
		StopReason: {
			END_TURN: "end_turn",
			STOP_SEQUENCE: "stop_sequence",
			MAX_TOKENS: "max_tokens",
			MODEL_CONTEXT_WINDOW_EXCEEDED: "model_context_window_exceeded",
			TOOL_USE: "tool_use",
		},
		CachePointType: { DEFAULT: "default" },
		CacheTTL: { ONE_HOUR: "ONE_HOUR" },
		ConversationRole: { ASSISTANT: "assistant", USER: "user" },
		ImageFormat: { JPEG: "jpeg", PNG: "png", GIF: "gif", WEBP: "webp" },
		ToolResultStatus: { ERROR: "error", SUCCESS: "success" },
	};
});

import { stream as streamBedrock } from "../src/api/bedrock-converse-stream.ts";
import { getModel, normalizeContext } from "../src/compat.ts";
import type { AssistantMessage } from "../src/types.ts";
import { isContextOverflow } from "../src/utils/overflow.ts";
import { isRetryableAssistantError } from "../src/utils/retry.ts";

const context = normalizeContext({
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
});

/** What the SDK throws for a non-2xx response or a modeled stream exception: `name` is the AWS error code. */
function exception(name: string, message: string, status?: number): Error {
	const error = new bedrockMock.ServiceException(message) as Error & Record<string, unknown>;
	error.name = name;
	if (status !== undefined) error.$metadata = { httpStatusCode: status };
	return error;
}

async function fail(error: unknown): Promise<AssistantMessage> {
	bedrockMock.send = { kind: "reject", error };
	return streamBedrock(getModel("amazon-bedrock", "us.anthropic.claude-opus-4-8"), context, {
		cacheRetention: "none",
	}).result();
}

async function failMidStream(error: unknown): Promise<AssistantMessage> {
	bedrockMock.send = {
		kind: "resolve",
		response: {
			$metadata: { httpStatusCode: 200 },
			stream: (async function* () {
				yield { messageStart: { role: "assistant" } };
				throw error;
			})(),
		},
	};
	return streamBedrock(getModel("amazon-bedrock", "us.anthropic.claude-opus-4-8"), context, {
		cacheRetention: "none",
	}).result();
}

beforeEach(() => {
	bedrockMock.send = undefined;
});

describe("bedrock fills error fields by exception name", () => {
	it("classifies Bedrock throttling 'Too many tokens' as rate_limit, never overflow", async () => {
		const result = await fail(
			exception("ThrottlingException", "Too many tokens, please wait before trying again.", 429),
		);
		expect(result).toMatchObject({ errorKind: "rate_limit", errorStatus: 429 });
		expect(result.errorMessage).toBe("ThrottlingException: Too many tokens, please wait before trying again.");
		expect(isContextOverflow(result)).toBe(false);
		expect(isRetryableAssistantError(result)).toBe(true);
	});

	it("classifies the same throttling exception raised inside the stream", async () => {
		const result = await failMidStream(exception("ThrottlingException", "Too many tokens, please wait."));
		expect(result).toMatchObject({ errorKind: "rate_limit" });
		expect(isContextOverflow(result)).toBe(false);
	});

	it.each([
		["InternalServerException", "transient"],
		["ServiceUnavailableException", "transient"],
		["ModelNotReadyException", "transient"],
		["ModelTimeoutException", "transient"],
		["ModelStreamErrorException", "transient"],
		["ServiceQuotaExceededException", "usage_limit"],
		["AccessDeniedException", "auth"],
		["UnrecognizedClientException", "auth"],
	])("maps %s to %s", async (name, kind) => {
		expect(await failMidStream(exception(name, "something happened"))).toMatchObject({ errorKind: kind });
	});

	it("classifies a ValidationException with overflow text as context_overflow", async () => {
		const result = await fail(exception("ValidationException", "Input is too long for requested model.", 400));
		expect(result).toMatchObject({ errorKind: "context_overflow", errorStatus: 400 });
		expect(isContextOverflow(result)).toBe(true);
	});

	it("classifies any other ValidationException as invalid_request, with or without a status", async () => {
		expect(
			await fail(exception("ValidationException", "The provided model identifier is invalid.", 400)),
		).toMatchObject({
			errorKind: "invalid_request",
			errorStatus: 400,
		});
		expect(await failMidStream(exception("ValidationException", "bad field"))).toMatchObject({
			errorKind: "invalid_request",
		});
	});

	it("classifies a connection failure as transient", async () => {
		const cause = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
		expect(await fail(new Error("socket error", { cause }))).toMatchObject({ errorKind: "transient" });
	});

	it("keeps the failure diagnostic", async () => {
		const result = await fail(exception("ThrottlingException", "slow", 429));
		expect(result.diagnostics?.some((d) => d.type === "bedrock_response_failure")).toBe(true);
	});
});
