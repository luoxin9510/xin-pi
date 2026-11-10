import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { type AssistantMessage, fauxAssistantMessage, type Message } from "xpi-ai";
import { CompleteError, type CompleteOptions, type CompleteResult, type ExtensionContext } from "../../src/index.ts";
import { createHarness, type Harness, type HarnessOptions } from "./harness.ts";

const RETRY = { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } };

function errorMessage(text: string, errorKind?: AssistantMessage["errorKind"]): AssistantMessage {
	return {
		...fauxAssistantMessage("", { stopReason: "error", errorMessage: text }),
		...(errorKind ? { errorKind } : {}),
	};
}

const AnswerSchema = Type.Object({ verdict: Type.Union([Type.Literal("yes"), Type.Literal("no")]) });

describe("ctx.complete", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	/** A harness whose extension runs `job` with the context of the /side command. */
	async function setup(options: HarnessOptions = {}) {
		const jobs: Array<(ctx: ExtensionContext) => Promise<unknown>> = [];
		const harness = await createHarness({
			settings: RETRY,
			...options,
			extensionFactories: [
				(pi) => {
					pi.registerCommand("side", {
						description: "Run the test job",
						handler: async (_args, ctx) => {
							await jobs.shift()?.(ctx);
						},
					});
				},
			],
		});
		harnesses.push(harness);
		/** Run `fn` in a command handler (no run is active) and return what it returns or throws. */
		const inCommand = async <T>(fn: (ctx: ExtensionContext) => Promise<T>): Promise<T> => {
			let outcome: { ok: true; value: T } | { ok: false; error: unknown } | undefined;
			jobs.push(async (ctx) => {
				try {
					outcome = { ok: true, value: await fn(ctx) };
				} catch (error) {
					outcome = { ok: false, error };
				}
			});
			await harness.session.prompt("/side");
			if (!outcome) throw new Error("the command did not run");
			if (!outcome.ok) throw outcome.error;
			return outcome.value;
		};
		const complete = <T = unknown>(options: Partial<CompleteOptions> = {}): Promise<CompleteResult<T>> =>
			inCommand((ctx) => ctx.complete<T>({ model: "inherit", prompt: "question", purpose: "test", ...options }));
		return { harness, inCommand, complete };
	}

	async function failure(promise: Promise<unknown>): Promise<CompleteError> {
		const error = await promise.then(
			() => undefined,
			(e: unknown) => e,
		);
		expect(error).toBeInstanceOf(CompleteError);
		return error as CompleteError;
	}

	function usageEntries(harness: Harness) {
		return harness.sessionManager.getEntries().flatMap((entry) => (entry.type === "usage" ? [entry] : []));
	}

	it("returns the text answer from a command handler with no run active", async () => {
		const { harness, complete } = await setup();
		let requests: Message[] = [];
		harness.setResponses([
			(context) => {
				requests = context.messages;
				return fauxAssistantMessage("hello there");
			},
		]);

		const result = await complete({ systemPrompt: "Be brief." });

		expect(result.text).toBe("hello there");
		expect(result.value).toBeUndefined();
		expect(result.model).toBe("faux/faux-1");
		expect(result.usage.totalTokens).toBeGreaterThan(0);
		expect(requests.map((m) => m.role)).toEqual(["system", "user"]);
		// The call is not part of the conversation.
		expect(harness.session.messages).toEqual([]);
	});

	it("is available in event handlers", async () => {
		let answer: string | undefined;
		const harness = await createHarness({
			settings: RETRY,
			extensionFactories: [
				(pi) => {
					pi.on("agent_end", async (_event, ctx) => {
						answer = (await ctx.complete({ model: "inherit", prompt: "judge", purpose: "judge" })).text;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("main reply"), fauxAssistantMessage("side verdict")]);

		await harness.session.prompt("hi");

		expect(answer).toBe("side verdict");
	});

	it("accepts messages instead of prompt, and rejects both or neither", async () => {
		const { harness, complete } = await setup();
		let seen: string[] = [];
		harness.setResponses([
			(context) => {
				seen = context.messages.map((m) => m.role);
				return fauxAssistantMessage("ok");
			},
		]);
		const messages: Message[] = [
			{ role: "user", content: "one", timestamp: 1 },
			{ role: "assistant", content: [{ type: "text", text: "two" }], ...baseAssistant() },
			{ role: "user", content: "three", timestamp: 3 },
		];
		await complete({ prompt: undefined, messages });
		expect(seen).toEqual(["user", "assistant", "user"]);

		await expect(complete({ messages })).rejects.toThrow("exactly one of prompt and messages");
		await expect(complete({ prompt: undefined })).rejects.toThrow("exactly one of prompt and messages");
	});

	it("returns a schema value that is valid on the first try, and asks for JSON in the system prompt", async () => {
		const { harness, complete } = await setup();
		let system = "";
		harness.setResponses([
			(context) => {
				const first = context.messages[0];
				system = first.role === "system" ? JSON.stringify(first.content) : "";
				return fauxAssistantMessage('{"verdict":"yes"}');
			},
		]);

		const result = await complete<{ verdict: string }>({ schema: AnswerSchema });

		expect(result.value).toEqual({ verdict: "yes" });
		expect(result.text).toBe('{"verdict":"yes"}');
		expect(system).toContain("only a JSON value");
		expect(system).toContain("verdict");
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("tolerates a json fence", async () => {
		const { harness, complete } = await setup();
		harness.setResponses([fauxAssistantMessage('```json\n{"verdict":"no"}\n```')]);
		const result = await complete<{ verdict: string }>({ schema: AnswerSchema });
		expect(result.value).toEqual({ verdict: "no" });
	});

	it("retries when the first answer is invalid, quoting the problem, and sums the usage of both attempts", async () => {
		const { harness, complete } = await setup();
		let second: Message[] = [];
		harness.setResponses([
			fauxAssistantMessage('{"verdict":"maybe"}'),
			(context) => {
				second = context.messages;
				return fauxAssistantMessage('{"verdict":"yes"}');
			},
		]);

		const result = await complete<{ verdict: string }>({ schema: AnswerSchema });

		expect(result.value).toEqual({ verdict: "yes" });
		expect(second.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
		expect(JSON.stringify(second.at(-1))).toContain("rejected");
		expect(usageEntries(harness)).toHaveLength(2);
		const recorded = usageEntries(harness).reduce((sum, entry) => sum + entry.usage.totalTokens, 0);
		expect(result.usage.totalTokens).toBe(recorded);
	});

	it("throws kind schema after two retries, with every attempt's usage recorded", async () => {
		const { harness, complete } = await setup();
		harness.setResponses([
			fauxAssistantMessage("not json"),
			fauxAssistantMessage('{"verdict":"maybe"}'),
			fauxAssistantMessage("still no"),
			fauxAssistantMessage('{"verdict":"yes"}'),
		]);

		const error = await failure(complete({ schema: AnswerSchema }));

		expect(error.kind).toBe("schema");
		expect(harness.faux.state.callCount).toBe(3);
		expect(usageEntries(harness)).toHaveLength(3);
		expect(error.usage?.totalTokens).toBeGreaterThan(0);
	});

	it("retries a transient error and then succeeds, recording each billed attempt", async () => {
		const { harness, complete } = await setup();
		harness.setResponses([errorMessage("503 overloaded", "transient"), fauxAssistantMessage("fine")]);

		const result = await complete();

		expect(result.text).toBe("fine");
		expect(harness.faux.state.callCount).toBe(2);
		expect(usageEntries(harness)).toHaveLength(2);
	});

	it("retries a rate limit", async () => {
		const { harness, complete } = await setup();
		harness.setResponses([errorMessage("429 too many requests", "rate_limit"), fauxAssistantMessage("fine")]);
		expect((await complete()).text).toBe("fine");
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("gives up on a transient error when the retry budget is spent", async () => {
		const { harness, complete } = await setup({
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
		});
		harness.setResponses([errorMessage("overloaded", "transient"), errorMessage("overloaded", "transient")]);

		const error = await failure(complete());

		expect(error.kind).toBe("transient");
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("does not retry an auth error and reports kind auth", async () => {
		const { harness, complete } = await setup();
		harness.setResponses([errorMessage("invalid api key", "auth"), fauxAssistantMessage("never")]);

		const error = await failure(complete());

		expect(error.kind).toBe("auth");
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("classifies an error without a kind from its text", async () => {
		const { harness, complete } = await setup();
		harness.setResponses([errorMessage("maximum context length exceeded: prompt is too long")]);
		expect((await failure(complete())).kind).toBe("context_overflow");
	});

	it("throws kind no_auth when the model has no credentials", async () => {
		const { complete } = await setup({ withConfiguredAuth: false });
		const error = await failure(complete());
		expect(error.kind).toBe("no_auth");
	});

	it("throws kind no_model for an unknown model, without calling a provider", async () => {
		const { harness, complete } = await setup();
		harness.setResponses([fauxAssistantMessage("never")]);

		expect((await failure(complete({ model: "no-such-model-anywhere" }))).kind).toBe("no_model");
		expect(harness.faux.state.callCount).toBe(0);
	});

	it("resolves inherit, an alias from the models setting, and a provider/id reference", async () => {
		const { harness, complete } = await setup({
			models: [{ id: "big" }, { id: "small" }],
			settings: { ...RETRY, models: { cheap: "faux/small", mine: "inherit" } },
		});
		harness.setResponses([
			fauxAssistantMessage("a"),
			fauxAssistantMessage("b"),
			fauxAssistantMessage("c"),
			fauxAssistantMessage("d"),
		]);
		const sessionModel = harness.session.model?.id;

		expect((await complete({ model: "inherit" })).model).toBe(`faux/${sessionModel}`);
		expect((await complete({ model: "cheap" })).model).toBe("faux/small");
		expect((await complete({ model: "faux/big" })).model).toBe("faux/big");
		expect((await complete({ model: "mine" })).model).toBe(`faux/${sessionModel}`);
	});

	it("records usage entries ext:<purpose> that count in the session totals", async () => {
		const { harness, complete } = await setup();
		harness.setResponses([fauxAssistantMessage("some answer text")]);
		const before = harness.session.getSessionStats().tokens.total;

		const result = await complete({ purpose: "advisor" });

		const entries = usageEntries(harness);
		expect(entries).toHaveLength(1);
		expect(entries[0].kind).toBe("ext:advisor");
		expect(entries[0].provider).toBe("faux");
		expect(entries[0].usage.totalTokens).toBe(result.usage.totalTokens);
		expect(harness.session.getSessionStats().tokens.total - before).toBe(result.usage.totalTokens);
	});

	it("uses no prompt cache and a fresh session id per call", async () => {
		const { harness, complete } = await setup();
		const ids: Array<string | undefined> = [];
		const retention: Array<string | undefined> = [];
		const step = (_context: unknown, options?: { sessionId?: string; cacheRetention?: string }) => {
			ids.push(options?.sessionId);
			retention.push(options?.cacheRetention);
			return fauxAssistantMessage("ok");
		};
		harness.setResponses([step, step]);

		await complete();
		await complete();

		expect(retention).toEqual(["none", "none"]);
		expect(ids[0]).toBeTruthy();
		expect(ids[0]).not.toBe(ids[1]);
	});

	it("throws kind aborted when the caller signal aborts during the request", async () => {
		const { harness, complete } = await setup();
		const controller = new AbortController();
		harness.setResponses([
			() => {
				controller.abort();
				return fauxAssistantMessage("late");
			},
		]);

		const error = await failure(complete({ signal: controller.signal }));

		expect(error.kind).toBe("aborted");
	});

	it("throws kind aborted without calling the model when the signal is already aborted", async () => {
		const { harness, complete } = await setup();
		harness.setResponses([fauxAssistantMessage("never")]);
		const error = await failure(complete({ signal: AbortSignal.abort() }));
		expect(error.kind).toBe("aborted");
		expect(harness.faux.state.callCount).toBe(0);
	});

	it("stops when the session is aborted", async () => {
		const { harness, complete } = await setup();
		harness.setResponses([
			async () => {
				await harness.session.abort();
				return fauxAssistantMessage("late");
			},
		]);
		expect((await failure(complete())).kind).toBe("aborted");
	});
});

function baseAssistant() {
	return {
		api: "faux",
		provider: "faux",
		model: "faux-1",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: 2,
	};
}
