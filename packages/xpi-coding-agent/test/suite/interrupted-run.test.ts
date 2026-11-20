/**
 * A model run cut off by the end of the process (.scratch/xpi-durable/01-interrupted-turn.md): run markers, what the
 * branch shows after a crash, the recovery at the next action, and `/continue`.
 */

import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentTool } from "xpi-agent-core";
import { type AssistantMessage, fauxAssistantMessage, fauxToolCall, type Message } from "xpi-ai";
import {
	findInterruptedRun,
	INTERRUPTED_CUSTOM_TYPE,
	INTERRUPTED_NOTE_TEXT,
	RUN_CUSTOM_TYPE,
} from "../../src/core/interrupted-run.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { interruptedAgentLines } from "../../src/extensions/subagent/index.ts";
import type { SubagentRecord } from "../../src/extensions/subagent/registry.ts";
import { createHarness, type Harness } from "./harness.ts";

type Marker = { phase: "start" | "end"; id: string; outcome?: string };

function markers(sm: SessionManager): Marker[] {
	return sm
		.getBranch()
		.filter((e) => e.type === "custom" && e.customType === RUN_CUSTOM_TYPE)
		.map((e) => {
			const d = (e as { data: Marker }).data;
			return { phase: d.phase, id: d.id, ...(d.outcome ? { outcome: d.outcome } : {}) };
		});
}

function user(text: string): Message {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function toolResult(id: string, text: string): Message {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "echo",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	} as Message;
}

/** The session a process left when it died during a run: start marker, the user's message, then `rest`. */
function crashed(rest: (sm: SessionManager) => void): SessionManager {
	const sm = SessionManager.inMemory();
	sm.appendCustomEntry(RUN_CUSTOM_TYPE, { phase: "start", id: "dead", at: 1 });
	sm.appendMessage(user("do the work"));
	rest(sm);
	return sm;
}

const twoCalls = (): AssistantMessage =>
	fauxAssistantMessage(
		[fauxToolCall("echo", { text: "a" }, { id: "t1" }), fauxToolCall("echo", { text: "b" }, { id: "t2" })],
		{
			stopReason: "toolUse",
		},
	);

describe("runs cut off by the end of the process", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	function echoTool(runs: string[]): AgentTool {
		return {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_id, params) => {
				const text = (params as { text: string }).text;
				runs.push(text);
				return { content: [{ type: "text", text: `echo:${text}` }], details: { text } };
			},
		};
	}

	async function harnessFor(sessionManager?: SessionManager, options: Parameters<typeof createHarness>[0] = {}) {
		const harness = await createHarness({ ...options, ...(sessionManager ? { sessionManager } : {}) });
		harnesses.push(harness);
		return harness;
	}

	describe("markers", () => {
		it("writes one start and one completed end around a run with tool calls", async () => {
			const runs: string[] = [];
			const harness = await harnessFor(undefined, { tools: [echoTool(runs)] });
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("echo", { text: "x" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("go");
			const m = markers(harness.sessionManager);
			expect(m.map((x) => `${x.phase}:${x.outcome ?? ""}`)).toEqual(["start:", "end:completed"]);
			expect(m[0].id).toBe(m[1].id);
			expect(harness.session.interruptedRun()).toBeUndefined();
		});

		it("ends a run with a provider error as error, and an aborted one as aborted", async () => {
			const harness = await harnessFor(undefined, { settings: { retry: { enabled: false } } });
			harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom" })]);
			await harness.session.prompt("go");
			expect(markers(harness.sessionManager).at(-1)?.outcome).toBe("error");

			const blocking: AgentTool = {
				name: "wait",
				label: "Wait",
				description: "Wait until aborted",
				parameters: Type.Object({}),
				execute: (_id, _p, signal) =>
					new Promise((_resolve, reject) => {
						signal?.addEventListener("abort", () => reject(new Error("aborted")));
					}),
			};
			const second = await harnessFor(undefined, { tools: [blocking] });
			second.setResponses([fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" })]);
			const run = second.session.prompt("go");
			await new Promise((r) => setTimeout(r, 20));
			await second.session.abort();
			await run;
			expect(markers(second.sessionManager).at(-1)?.outcome).toBe("aborted");
		});

		it("never reports a session without markers as cut off", async () => {
			const sm = SessionManager.inMemory();
			sm.appendMessage(user("old"));
			sm.appendMessage(twoCalls());
			const harness = await harnessFor(sm);
			expect(harness.session.interruptedRun()).toBeUndefined();
		});

		it("gives a run started from an agent_settled handler its own pair", async () => {
			let sent = false;
			const harness = await harnessFor(undefined, {
				extensionFactories: [
					(pi) => {
						pi.on("agent_settled", () => {
							if (sent) return;
							sent = true;
							pi.sendMessage({ customType: "next", content: "go on", display: false }, { triggerTurn: true });
						});
					},
				],
			});
			harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
			await harness.session.prompt("start");
			await harness.session.waitForIdle();
			const m = markers(harness.sessionManager);
			expect(m.map((x) => `${x.phase}:${x.outcome ?? ""}`)).toEqual([
				"start:",
				"end:completed",
				"start:",
				"end:completed",
			]);
			expect(m[0].id).not.toBe(m[2].id);
		});
	});

	describe("what the branch shows", () => {
		it("lists the calls with no result, in call order, whatever order results came in", () => {
			const sm = crashed((s) => {
				s.appendMessage(twoCalls());
				s.appendMessage(toolResult("t2", "b done"));
			});
			const run = findInterruptedRun(sm.getBranch());
			expect(run?.danglingToolCalls.map((c) => c.id)).toEqual(["t1"]);
			expect(run?.replyComplete).toBe(false);
		});

		it("sees a cut-off stream (user tail) and a complete reply, which lost nothing", async () => {
			expect(findInterruptedRun(crashed(() => {}).getBranch())?.danglingToolCalls).toEqual([]);
			const complete = crashed((s) => s.appendMessage(fauxAssistantMessage("all done")));
			expect(findInterruptedRun(complete.getBranch())?.replyComplete).toBe(true);
			const harness = await harnessFor(complete);
			expect(harness.session.interruptedRun()).toBeUndefined();
		});

		it("counts only the current branch", () => {
			const sm = SessionManager.inMemory();
			const first = sm.appendMessage(user("first"));
			sm.appendCustomEntry(RUN_CUSTOM_TYPE, { phase: "start", id: "dead", at: 1 });
			sm.appendMessage(user("second"));
			expect(findInterruptedRun(sm.getBranch())).toBeDefined();
			sm.branch(first);
			expect(findInterruptedRun(sm.getBranch())).toBeUndefined();
		});

		it("does not count a finished run whose end is on another branch (/tree to a point inside it)", () => {
			const sm = SessionManager.inMemory();
			sm.appendCustomEntry(RUN_CUSTOM_TYPE, { phase: "start", id: "r", at: 1 });
			const asked = sm.appendMessage(user("question"));
			sm.appendMessage(fauxAssistantMessage("answer"));
			sm.appendCustomEntry(RUN_CUSTOM_TYPE, { phase: "end", id: "r", at: 2, outcome: "completed" });
			sm.branch(asked);
			expect(findInterruptedRun(sm.getBranch(), sm.getEntries())).toBeUndefined();
			expect(findInterruptedRun(sm.getBranch())).toBeDefined(); // the branch alone would say otherwise
		});

		it("closes a run left open by a fork's path, so the new session is not cut off", () => {
			const sm = SessionManager.inMemory();
			sm.appendMessage(user("first"));
			sm.appendCustomEntry(RUN_CUSTOM_TYPE, { phase: "start", id: "r", at: 1 });
			const inside = sm.appendMessage(user("second"));
			sm.appendMessage(fauxAssistantMessage("answer"));
			sm.appendCustomEntry(RUN_CUSTOM_TYPE, { phase: "end", id: "r", at: 2, outcome: "completed" });
			sm.createBranchedSession(inside);
			expect(findInterruptedRun(sm.getBranch(), sm.getEntries())).toBeUndefined();
			expect(markers(sm)).toEqual([
				{ phase: "start", id: "r" },
				{ phase: "end", id: "r", outcome: "aborted" },
			]);
		});
	});

	describe("recovery at the next action", () => {
		it("writes interrupted results and the note before the user's message, and runs no tool", async () => {
			const runs: string[] = [];
			const sm = crashed((s) => {
				s.appendMessage(twoCalls());
				s.appendMessage(toolResult("t2", "b done"));
			});
			const harness = await harnessFor(sm, { tools: [echoTool(runs)] });
			expect(harness.session.interruptedRun()?.danglingToolCalls.map((c) => c.id)).toEqual(["t1"]);
			const requests: Message[][] = [];
			harness.setResponses([
				(context) => {
					requests.push(context.messages);
					return fauxAssistantMessage("ok");
				},
			]);
			await harness.session.prompt("go on");

			expect(runs).toEqual([]);
			const roles = requests[0].filter((m) => m.role !== "system").map((m) => m.role);
			expect(roles).toEqual(["user", "assistant", "toolResult", "toolResult", "user", "user"]);
			const t1 = requests[0].find((m) => m.role === "toolResult" && m.toolCallId === "t1");
			expect(JSON.stringify(t1)).toContain("[xpi] Interrupted");
			expect(t1).toMatchObject({ isError: true });
			const sent = requests[0].filter((m) => m.role !== "system");
			expect(JSON.stringify(sent.at(-2))).toContain(INTERRUPTED_NOTE_TEXT);
			expect(JSON.stringify(sent.at(-1))).toContain("go on");

			// The cut-off run is closed as recovered, then the new run has its own pair.
			expect(
				markers(harness.sessionManager).map(
					(x) => `${x.id === "dead" ? "dead" : "new"}:${x.phase}:${x.outcome ?? ""}`,
				),
			).toEqual(["dead:start:", "dead:end:recovered", "new:start:", "new:end:completed"]);
			expect(harness.session.interruptedRun()).toBeUndefined();
		});

		it("lets a tool_result handler add to an interrupted result", async () => {
			const sm = crashed((s) => s.appendMessage(twoCalls()));
			const harness = await harnessFor(sm, {
				tools: [echoTool([])],
				extensionFactories: [
					(pi) => {
						pi.on("tool_result", (event) =>
							(event.details as { interrupted?: boolean } | undefined)?.interrupted
								? { content: [...event.content, { type: "text", text: `extra for ${event.toolCallId}` }] }
								: undefined,
						);
					},
				],
			});
			harness.setResponses([fauxAssistantMessage("ok")]);
			await harness.session.prompt("go on");
			const results = harness.sessionManager
				.getBranch()
				.flatMap((e) => (e.type === "message" && e.message.role === "toolResult" ? [e.message] : []));
			expect(results.map((r) => JSON.stringify(r.content))).toEqual([
				expect.stringContaining("extra for t1"),
				expect.stringContaining("extra for t2"),
			]);
		});

		it("does not write the note twice when an earlier recovery was itself cut off", async () => {
			const sm = crashed((s) => {
				s.appendMessage(twoCalls());
				s.appendMessage(toolResult("t1", "a"));
				s.appendMessage(toolResult("t2", "b"));
				s.appendCustomMessageEntry(INTERRUPTED_CUSTOM_TYPE, INTERRUPTED_NOTE_TEXT, true);
			});
			const harness = await harnessFor(sm);
			harness.setResponses([fauxAssistantMessage("ok")]);
			await harness.session.prompt("go on");
			const notes = harness.sessionManager
				.getBranch()
				.filter((e) => e.type === "custom_message" && e.customType === INTERRUPTED_CUSTOM_TYPE);
			expect(notes).toHaveLength(1);
		});

		it("skips an attempt a retry left out of the context, so no result answers its calls", async () => {
			// A stream interrupt (or overflow) retry omitted the attempt with a context_edit; the process died before the retry.
			const sm = crashed((s) => {
				const attempt = s.appendMessage(twoCalls());
				s.appendContextEdit(attempt, null);
			});
			const run = findInterruptedRun(sm.getBranch(), sm.getEntries());
			expect(run?.danglingToolCalls).toEqual([]);
			expect(run?.replyComplete).toBe(false);
			const harness = await harnessFor(sm, { tools: [echoTool([])] });
			const requests: Message[][] = [];
			harness.setResponses([
				(context) => {
					requests.push(context.messages);
					return fauxAssistantMessage("ok");
				},
			]);
			expect(await harness.session.continueRun()).toEqual({ ran: true });
			expect(requests[0].some((m) => m.role === "toolResult")).toBe(false);
		});

		it("treats a failed reply at the tail as cut off, not complete", async () => {
			const sm = crashed((s) =>
				s.appendMessage(
					fauxAssistantMessage([fauxToolCall("echo", { text: "a" }, { id: "t9" })], {
						stopReason: "error",
						errorMessage: "overloaded",
					}),
				),
			);
			const run = findInterruptedRun(sm.getBranch(), sm.getEntries());
			expect(run).toMatchObject({ replyComplete: false, danglingToolCalls: [] });
			const harness = await harnessFor(sm);
			expect(harness.session.interruptedRun()).toBeDefined();
			harness.setResponses([fauxAssistantMessage("answer")]);
			expect(await harness.session.continueRun()).toEqual({ ran: true });
			expect(harness.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
		});

		it("closes a run that ended after a complete reply with no note", async () => {
			const harness = await harnessFor(crashed((s) => s.appendMessage(fauxAssistantMessage("all done"))));
			harness.setResponses([fauxAssistantMessage("ok")]);
			await harness.session.prompt("next");
			expect(harness.sessionManager.getBranch().some((e) => e.type === "custom_message")).toBe(false);
			expect(markers(harness.sessionManager)[1]).toMatchObject({ id: "dead", phase: "end", outcome: "recovered" });
		});
	});

	describe("/continue", () => {
		it("repairs a cut-off run and continues with no new message", async () => {
			const harness = await harnessFor(
				crashed((s) => s.appendMessage(twoCalls())),
				{ tools: [echoTool([])] },
			);
			const requests: Message[][] = [];
			harness.setResponses([
				(context) => {
					requests.push(context.messages);
					return fauxAssistantMessage("continued");
				},
			]);
			await harness.session.prompt("/continue");
			expect(requests).toHaveLength(1);
			expect(requests[0].filter((m) => m.role === "user").map((m) => JSON.stringify(m.content))).toEqual([
				expect.stringContaining("do the work"),
				expect.stringContaining(INTERRUPTED_NOTE_TEXT),
			]);
		});

		it("gives before_agent_start a continue trigger with no prompt and no message", async () => {
			const seen: unknown[] = [];
			const harness = await harnessFor(
				crashed(() => {}),
				{
					extensionFactories: [
						(pi) => {
							pi.on("before_agent_start", (event) => {
								seen.push({
									messageType: event.messageType,
									prompt: (event as { prompt?: string }).prompt,
									message: (event as { message?: unknown }).message,
								});
							});
						},
					],
				},
			);
			harness.setResponses([fauxAssistantMessage("ok")]);
			expect(await harness.session.continueRun()).toEqual({ ran: true });
			expect(seen).toEqual([{ messageType: "continue", prompt: undefined, message: undefined }]);
		});

		it("says why when there is nothing to continue, and runs nothing", async () => {
			const fresh = await harnessFor();
			expect(await fresh.session.continueRun()).toEqual({ ran: false, reason: "none" });

			fresh.setResponses([fauxAssistantMessage("hi")]);
			await fresh.session.prompt("hello");
			expect(await fresh.session.continueRun()).toEqual({ ran: false, reason: "finished" });

			const complete = await harnessFor(crashed((s) => s.appendMessage(fauxAssistantMessage("all done"))));
			expect(await complete.session.continueRun()).toEqual({ ran: false, reason: "finished" });
			expect(markers(complete.sessionManager).at(-1)).toMatchObject({ outcome: "recovered" });

			const stopped = SessionManager.inMemory();
			stopped.appendCustomEntry(RUN_CUSTOM_TYPE, { phase: "start", id: "r", at: 1 });
			stopped.appendMessage(user("x"));
			stopped.appendCustomEntry(RUN_CUSTOM_TYPE, { phase: "end", id: "r", at: 2, outcome: "aborted" });
			expect(await (await harnessFor(stopped)).session.continueRun()).toEqual({ ran: false, reason: "stopped" });

			expect(fresh.faux.state.callCount).toBe(1);
		});

		it("asks the model again after a provider error, without the error in context (D1)", async () => {
			const harness = await harnessFor(undefined, { settings: { retry: { enabled: false } } });
			harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded" })]);
			await harness.session.prompt("question");
			const requests: Message[][] = [];
			harness.setResponses([
				(context) => {
					requests.push(context.messages);
					return fauxAssistantMessage("answer");
				},
			]);
			expect(await harness.session.continueRun()).toEqual({ ran: true });
			expect(requests[0].filter((m) => m.role !== "system").map((m) => m.role)).toEqual(["user"]);
			expect(harness.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
		});

		it("does not retry after a run that failed to start, whose context ends with a complete reply", async () => {
			const sm = SessionManager.inMemory();
			sm.appendCustomEntry(RUN_CUSTOM_TYPE, { phase: "start", id: "ok", at: 1 });
			sm.appendMessage(user("q"));
			sm.appendMessage(fauxAssistantMessage("a"));
			sm.appendCustomEntry(RUN_CUSTOM_TYPE, { phase: "end", id: "ok", at: 2, outcome: "completed" });
			sm.appendCustomEntry(RUN_CUSTOM_TYPE, { phase: "start", id: "bad", at: 3 });
			sm.appendCustomEntry(RUN_CUSTOM_TYPE, { phase: "end", id: "bad", at: 4, outcome: "error" });
			const harness = await harnessFor(sm);
			expect(await harness.session.continueRun()).toEqual({ ran: false, reason: "finished" });
			expect(harness.faux.state.callCount).toBe(0);
		});

		it("asks again after a provider error in a session reopened from disk (D1)", async () => {
			const first = await harnessFor(undefined, { settings: { retry: { enabled: false } } });
			const file = SessionManager.create(first.tempDir, join(first.tempDir, "sessions"));
			const writer = await harnessFor(file, { settings: { retry: { enabled: false } } });
			writer.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded" })]);
			await writer.session.prompt("question");
			const path = writer.sessionManager.getSessionFile();
			expect(path).toBeDefined();
			const reopened = await harnessFor(SessionManager.open(path!), { settings: { retry: { enabled: false } } });
			const requests: Message[][] = [];
			reopened.setResponses([
				(context) => {
					requests.push(context.messages);
					return fauxAssistantMessage("answer");
				},
			]);
			expect(await reopened.session.continueRun()).toEqual({ ran: true });
			expect(requests[0].filter((m) => m.role !== "system").map((m) => m.role)).toEqual(["user"]);
		});

		it("is refused while a run is in progress, and never queued", async () => {
			let release: () => void = () => {};
			const gate: AgentTool = {
				name: "gate",
				label: "Gate",
				description: "Wait",
				parameters: Type.Object({}),
				execute: () =>
					new Promise((resolve) => {
						release = () => resolve({ content: [{ type: "text", text: "ok" }], details: {} });
					}),
			};
			const harness = await harnessFor(undefined, { tools: [gate] });
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("gate", {})], { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			const run = harness.session.prompt("go");
			await new Promise((r) => setTimeout(r, 20));
			expect(await harness.session.continueRun()).toEqual({ ran: false, reason: "busy" });
			await harness.session.prompt("/continue", { streamingBehavior: "steer" });
			expect(harness.session.pendingMessageCount).toBe(0);
			release();
			await run;
			expect(harness.faux.state.callCount).toBe(2);
		});

		it("refuses arguments without running", async () => {
			const harness = await harnessFor(crashed(() => {}));
			await harness.session.prompt("/continue now");
			expect(harness.faux.state.callCount).toBe(0);
			expect(harness.session.interruptedRun()).toBeDefined();
		});
	});
});

describe("subagent lines for an interrupted call", () => {
	const record = (id: string, callId: string | undefined): SubagentRecord =>
		({ id, type: "general-purpose", description: "look around", callId }) as SubagentRecord;

	it("names the agents started by the call itself or by its script", () => {
		const lines = interruptedAgentLines(
			[record("a1", "call_1"), record("a2", "call_1/Agent/3"), record("a3", "call_2"), record("a4", undefined)],
			"call_1",
		);
		expect(lines).toEqual([
			'Agent general-purpose (look around) agentId a1 was running. Pass resume: "a1" to continue it.',
			'Agent general-purpose (look around) agentId a2 was running. Pass resume: "a2" to continue it.',
		]);
	});
});
