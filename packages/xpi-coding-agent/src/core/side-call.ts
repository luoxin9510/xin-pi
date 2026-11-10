/**
 * Side model calls for extensions: `ctx.complete()`.
 *
 * One call asks a model something outside the session's conversation. The session supplies the pieces
 * (model lookup, request auth, stream function, retry policy, usage journal, cancellation) through
 * {@link SideCallHost}; this module holds the rules: JSON answers checked against a schema, retries by error kind,
 * and typed errors.
 */

import type { StreamFn } from "xpi-agent-core";
import {
	classifyErrorText,
	type ErrorKind,
	normalizeContext,
	type RetryPolicy,
	retryAssistantCall,
	uuidv7,
	validateToolArguments,
} from "xpi-ai";
import type { AssistantMessage, Message, Model, SimpleStreamOptions, Usage } from "xpi-ai/compat";
import { combineUsage } from "./usage-totals.ts";

/** Why a side call failed: a provider error kind, or one of the four kinds the call itself adds. */
export type CompleteErrorKind = ErrorKind | "aborted" | "no_model" | "no_auth" | "schema";

export interface CompleteOptions {
	/**
	 * Which model answers: `"inherit"` (the session's current model), an alias from the `models` setting, or a
	 * model reference such as `provider/id` or a pattern (the `--model` syntax).
	 */
	model: string;
	/** The question, as one user message. Give exactly one of `prompt` and `messages`. */
	prompt?: string;
	/** The conversation to continue, instead of `prompt`. */
	messages?: Message[];
	systemPrompt?: string;
	/**
	 * A JSON Schema (a TypeBox type or a plain object). The model is asked for JSON matching it; the answer is
	 * parsed, validated and returned as `value`.
	 */
	schema?: object;
	maxTokens?: number;
	/** Stops the call, in addition to the session's own abort. */
	signal?: AbortSignal;
	/** What the call is for. The cost is recorded in the session as usage `ext:<purpose>`. */
	purpose: string;
}

export interface CompleteResult<T = unknown> {
	/** The model's text answer (with a schema: the JSON text that passed validation). */
	text: string;
	/** The validated value, when `schema` was given. */
	value?: T;
	/** Tokens and cost of every attempt of this call, failed ones included. */
	usage: Usage;
	/** The model that answered, as `provider/id`. */
	model: string;
}

/** The error `ctx.complete()` throws. `kind` says what to do about it. */
export class CompleteError extends Error {
	readonly kind: CompleteErrorKind;
	/** What the failed attempts already cost, when any of them reported usage. */
	readonly usage: Usage | undefined;

	constructor(kind: CompleteErrorKind, message: string, options: { usage?: Usage; cause?: unknown } = {}) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "CompleteError";
		this.kind = kind;
		this.usage = options.usage;
	}
}

export interface SideCallRequest {
	model: Model<any>;
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
}

/** What the session provides to a side call. */
export interface SideCallHost {
	/** The model for a reference, or undefined when none matches. */
	resolveModel(reference: string): Model<any> | undefined;
	/** The model to call and its credentials. Throws when there are none. */
	getRequest(model: Model<any>, signal: AbortSignal): Promise<SideCallRequest>;
	streamFn: StreamFn;
	retry: RetryPolicy;
	/** Journal the usage of one billed attempt. */
	recordUsage(kind: string, message: AssistantMessage): void;
}

const MAX_SCHEMA_RETRIES = 2;
const ANSWER_TOOL = "answer";

function schemaInstruction(schema: object): string {
	return `Answer with only a JSON value that matches this JSON Schema. No prose, no code fence.\n\n${JSON.stringify(schema)}`;
}

/** Parse the model's answer as JSON; a surrounding ```json fence is tolerated. */
function parseJsonAnswer(text: string): unknown {
	const trimmed = text.trim();
	const fenced = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/.exec(trimmed);
	return JSON.parse(fenced ? fenced[1] : trimmed);
}

function answerText(message: AssistantMessage): string {
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
}

function errorKindOf(message: AssistantMessage): ErrorKind {
	return message.errorKind ?? classifyErrorText(message.errorMessage ?? "", message.provider);
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export async function runSideCall<T>(
	host: SideCallHost,
	options: CompleteOptions,
	signal: AbortSignal,
): Promise<CompleteResult<T>> {
	if ((options.prompt === undefined) === (options.messages === undefined)) {
		throw new Error("ctx.complete: give exactly one of prompt and messages");
	}
	let usage: Usage | undefined;
	const aborted = () => new CompleteError("aborted", "The side call was aborted", { usage });

	const model = host.resolveModel(options.model);
	if (!model) throw new CompleteError("no_model", `No model matches "${options.model}"`);
	if (signal.aborted) throw aborted();

	let request: SideCallRequest;
	try {
		request = await host.getRequest(model, signal);
	} catch (error) {
		if (signal.aborted) throw aborted();
		throw new CompleteError("no_auth", describeError(error), { cause: error });
	}

	const systemPrompt = [options.systemPrompt, options.schema ? schemaInstruction(options.schema) : undefined]
		.filter((part) => part !== undefined)
		.join("\n\n");
	const messages: Message[] = options.messages
		? [...options.messages]
		: [{ role: "user", content: [{ type: "text", text: options.prompt! }], timestamp: Date.now() }];

	// Like compaction: no prompt caching for a one-off request, and a routing id of its own.
	const requestOptions: SimpleStreamOptions = {
		signal,
		apiKey: request.apiKey,
		headers: request.headers,
		env: request.env,
		sessionId: uuidv7(),
		cacheRetention: "none",
		...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
	};

	// One request, retried on transient errors and rate limits. Every billed attempt is journalled, failed or not.
	const ask = async (): Promise<AssistantMessage> => {
		const context = normalizeContext({ systemPrompt: systemPrompt || undefined, messages });
		let response: AssistantMessage;
		try {
			response = await retryAssistantCall(
				async () => {
					const produced = await (await host.streamFn(request.model, context, requestOptions)).result();
					if (produced.usage.totalTokens > 0 || produced.usage.cost.total > 0) {
						host.recordUsage(`ext:${options.purpose}`, produced);
						usage = usage ? combineUsage(usage, produced.usage) : produced.usage;
					}
					return produced;
				},
				host.retry,
				signal,
			);
		} catch (error) {
			// A stream function that throws instead of returning an error message.
			if (signal.aborted) throw aborted();
			const message = describeError(error);
			throw new CompleteError(classifyErrorText(message, request.model.provider), message, { usage, cause: error });
		}
		if (response.stopReason === "aborted" || signal.aborted) throw aborted();
		if (response.stopReason === "error") {
			throw new CompleteError(errorKindOf(response), response.errorMessage || "The model request failed", { usage });
		}
		return response;
	};
	const finish = (response: AssistantMessage): Pick<CompleteResult, "usage" | "model"> => ({
		usage: usage ?? {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		model: `${response.provider}/${response.model}`,
	});

	for (let schemaRetries = 0; ; schemaRetries++) {
		const response = await ask();
		const text = answerText(response);
		if (!options.schema) return { text, ...finish(response) };

		let problem: string;
		try {
			const value = validateToolArguments(
				{ name: ANSWER_TOOL, description: "", parameters: options.schema },
				{ type: "toolCall", id: ANSWER_TOOL, name: ANSWER_TOOL, arguments: parseJsonAnswer(text) as never },
			) as T;
			return { text, value, ...finish(response) };
		} catch (error) {
			problem = describeError(error);
		}
		if (schemaRetries >= MAX_SCHEMA_RETRIES) {
			throw new CompleteError("schema", `The answer does not match the schema: ${problem}`, { usage });
		}
		messages.push(response, {
			role: "user",
			content: [
				{
					type: "text",
					text: `That answer was rejected: ${problem}\n\nAnswer again with only the JSON value that matches the schema.`,
				},
			],
			timestamp: Date.now(),
		});
	}
}
