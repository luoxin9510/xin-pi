import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentTool } from "xpi-agent-core";
import { type AssistantMessage, fauxAssistantMessage, fauxToolCall, type Message } from "xpi-ai";
import type { StreamInterruptedEvent } from "../../src/index.ts";
import { createHarness, type Harness } from "./harness.ts";

const LONG_BAD_TEXT = `BAD ${"filler words ".repeat(200)}`;
const INJECT = "Do not say BAD. Answer plainly.";

describe("message_update stream interrupt", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	function createEchoTool(runs: string[]): AgentTool {
		return {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				const text = (params as { text: string }).text;
				runs.push(text);
				return { content: [{ type: "text", text: `echo:${text}` }], details: { text } };
			},
		};
	}

	/**
	 * Interrupts a stream whose partial message contains BAD, or (`at: "toolcall_end"`) any stream at its
	 * toolcall_end event, which is the last event before the stream completes.
	 */
	async function createInterruptHarness(options: { tools?: AgentTool[]; at?: "toolcall_end" } = {}) {
		const harness = await createHarness({
			tools: options.tools,
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("message_update", (event) => {
						if (options.at) {
							return event.assistantMessageEvent.type === options.at
								? { interrupt: { inject: INJECT } }
								: undefined;
						}
						return JSON.stringify(event.message).includes("BAD") ? { interrupt: { inject: INJECT } } : undefined;
					});
				},
			],
		});
		harnesses.push(harness);
		return harness;
	}

	it("aborts the request, hides the attempt, injects the reminder and retries the turn", async () => {
		const harness = await createInterruptHarness();
		const requests: Message[][] = [];
		harness.setResponses([
			(context) => {
				requests.push(context.messages);
				return fauxAssistantMessage(LONG_BAD_TEXT);
			},
			(context) => {
				requests.push(context.messages);
				return fauxAssistantMessage("clean answer");
			},
		]);

		await harness.session.prompt("question");

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("stream_interrupted").map((event) => `${event.count}/${event.limit}`)).toEqual([
			"1/3",
		]);
		expect(harness.session.isStreaming).toBe(false);
		// Not an error retry, and the run was not aborted.
		expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
		expect(harness.session.retryAttempt).toBe(0);
		expect(harness.eventsOfType("agent_end").map((event) => event.willRetry)).toEqual([true, false]);
		expect(harness.eventsOfType("agent_settled").map((event) => event.aborted)).toEqual([false]);

		// The second request has the prompt and the reminder, not the abandoned attempt.
		const second = JSON.stringify(requests[1]);
		expect(second).toContain("question");
		expect(second).toContain(INJECT);
		expect(second).not.toContain("filler words");
		expect(requests[1].map((m) => m.role)).toEqual(["system", "user", "user"]);

		// The abandoned attempt stays in the session file, aborted, followed by the hidden reminder.
		const entries = harness.sessionManager.getEntries();
		expect(
			entries.some(
				(entry) =>
					entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "aborted",
			),
		).toBe(true);
		expect(entries.find((entry) => entry.type === "custom_message")).toMatchObject({
			customType: "stream_interrupt",
			display: false,
			content: INJECT,
		});
		expect(entries.some((entry) => entry.type === "context_edit")).toBe(true);
		// The final context shows the clean answer only.
		expect(harness.session.messages.filter((m) => m.role === "assistant")).toHaveLength(1);
	});

	it("emits stream_interrupted to extensions", async () => {
		const seen: StreamInterruptedEvent[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("message_update", () => ({ interrupt: { inject: INJECT } }));
					pi.on("stream_interrupted", (event) => {
						seen.push(event);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(LONG_BAD_TEXT),
			fauxAssistantMessage(LONG_BAD_TEXT),
			fauxAssistantMessage(LONG_BAD_TEXT),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("question");

		expect(seen.map((event) => [event.count, event.limit, event.inject])).toEqual([
			[1, 3, INJECT],
			[2, 3, INJECT],
			[3, 3, INJECT],
		]);
		expect(seen[0].message.stopReason).toBe("aborted");
	});

	it("never starts a tool call of the abandoned attempt (early interrupt)", async () => {
		const runs: string[] = [];
		const harness = await createInterruptHarness({ tools: [createEchoTool(runs)] });
		const started: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "tool_execution_start") started.push(event.toolName);
		});
		harness.setResponses([
			fauxAssistantMessage([{ type: "text", text: LONG_BAD_TEXT }, fauxToolCall("echo", { text: "bad-call" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("clean answer"),
		]);

		await harness.session.prompt("question");

		expect(runs).toEqual([]);
		expect(started).toEqual([]);
		expect(harness.session.messages.some((m) => m.role === "toolResult")).toBe(false);
	});

	it("never starts a tool call when the interrupt arrives with the last event of the stream", async () => {
		const runs: string[] = [];
		const harness = await createInterruptHarness({ tools: [createEchoTool(runs)], at: "toolcall_end" });
		const requests: Message[][] = [];
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "bad-call" })], { stopReason: "toolUse" }),
			(context) => {
				requests.push(context.messages);
				return fauxAssistantMessage("clean answer");
			},
		]);

		await harness.session.prompt("question");

		expect(runs).toEqual([]);
		expect(harness.faux.state.callCount).toBe(2);
		expect(JSON.stringify(requests[0])).not.toContain("bad-call");
		expect(harness.session.messages.some((m) => m.role === "toolResult")).toBe(false);
	});

	it("allows at most 3 interrupts per user prompt, then the stream finishes", async () => {
		const harness = await createInterruptHarness();
		harness.setResponses([
			fauxAssistantMessage(LONG_BAD_TEXT),
			fauxAssistantMessage(LONG_BAD_TEXT),
			fauxAssistantMessage(LONG_BAD_TEXT),
			fauxAssistantMessage(LONG_BAD_TEXT),
		]);

		await harness.session.prompt("question");

		expect(harness.faux.state.callCount).toBe(4);
		expect(harness.eventsOfType("stream_interrupted")).toHaveLength(3);
		const last = harness.session.messages.findLast((m) => m.role === "assistant") as AssistantMessage;
		expect(last.stopReason).toBe("stop");
		expect(JSON.stringify(last.content)).toContain("filler words");

		// A new user prompt gets a fresh allowance.
		harness.setResponses([fauxAssistantMessage(LONG_BAD_TEXT), fauxAssistantMessage("clean")]);
		await harness.session.prompt("again");
		expect(harness.eventsOfType("stream_interrupted")).toHaveLength(4);
	});

	it("keeps the abandoned attempt in cost totals and does not use an error retry", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("message_update", (event) =>
						JSON.stringify(event.message).includes("BAD") ? { interrupt: { inject: INJECT } } : undefined,
					);
					// Give the aborted attempt a known usage; the provider reports none for it.
					pi.on("message_end", (event) => {
						const message = event.message;
						if (message.role !== "assistant" || message.stopReason !== "aborted") return undefined;
						return {
							message: {
								...message,
								usage: {
									input: 1000,
									output: 500,
									cacheRead: 0,
									cacheWrite: 0,
									totalTokens: 1500,
									cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
								},
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage(LONG_BAD_TEXT), fauxAssistantMessage("clean")]);

		await harness.session.prompt("question");

		const stats = harness.session.getSessionStats();
		expect(stats.assistantMessages).toBe(2);
		expect(stats.tokens.input).toBeGreaterThanOrEqual(1000);
		expect(stats.tokens.output).toBeGreaterThanOrEqual(500);
		expect(stats.cost).toBeCloseTo(0.03, 6);
		expect(harness.session.retryAttempt).toBe(0);
		expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
	});

	it("keeps the error-retry counter independent of interrupts", async () => {
		const harness = await createInterruptHarness();
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage(LONG_BAD_TEXT),
			fauxAssistantMessage("clean"),
		]);

		await harness.session.prompt("question");

		// One error retry, then one interrupt; the interrupt did not start another error retry.
		expect(harness.eventsOfType("auto_retry_start").map((event) => event.attempt)).toEqual([1]);
		expect(harness.eventsOfType("stream_interrupted")).toHaveLength(1);
		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.session.retryAttempt).toBe(0);
	});

	it("a user abort during the retried attempt ends the run", async () => {
		const harness = await createInterruptHarness();
		harness.setResponses([
			fauxAssistantMessage(LONG_BAD_TEXT),
			() => {
				// The user aborts while the retried request is being answered.
				void harness.session.abort();
				return fauxAssistantMessage("second attempt ".repeat(200));
			},
			fauxAssistantMessage("must not be requested"),
		]);

		await harness.session.prompt("question");

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("agent_settled").map((event) => event.aborted)).toEqual([true]);
		expect(harness.session.isStreaming).toBe(false);
	});
});
