import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { AgentTool, AgentToolCall } from "xpi-agent-core";
import type { Usage } from "xpi-ai";
import {
	NESTED_CALL_LIMITS,
	NestedCallRecorder,
	type NestedToolCallHost,
	NestedToolCallRunner,
	type NestedToolExecutionEvent,
} from "../src/core/nested-tool-calls.ts";

function usage(input: number, cost: number): Usage {
	return {
		input,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input,
		cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

function createRunner(tools: AgentTool[], options: { sequential?: boolean } = {}) {
	const events: NestedToolExecutionEvent[] = [];
	const host: NestedToolCallHost = {
		getTools: () => tools,
		isSequential: () => options.sequential ?? false,
		runToolCall: async (toolCall, _parentId, signal, onUpdate) => {
			const tool = tools.find((candidate) => candidate.name === toolCall.name);
			if (!tool) {
				return {
					toolCall,
					result: { content: [{ type: "text", text: `Tool ${toolCall.name} not found` }], details: {} },
					isError: true,
				};
			}
			const result = await tool.execute(
				toolCall.id,
				toolCall.arguments,
				signal,
				(partial) => void onUpdate(partial),
			);
			return { toolCall, result, isError: result.isError === true };
		},
		emit: async (event) => {
			events.push(event);
		},
	};
	return { runner: new NestedToolCallRunner(host), events };
}

describe("NestedToolCallRunner", () => {
	it("assigns ids below the caller, emits events with the parent id, and records the calls", async () => {
		const echo: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo",
			parameters: Type.Object({}),
			async execute(_id, _params, _signal, onUpdate) {
				onUpdate?.({ content: [{ type: "text", text: "partial" }], details: {} });
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		};
		const { runner, events } = createRunner([echo]);
		const updates: unknown[] = [];

		const first = await runner.execute("call", "echo", { a: 1 }, { onUpdate: (partial) => updates.push(partial) });
		const missing = await runner.execute("call", "missing", {});

		expect(first.toolCall.id).toBe("call/1");
		expect(missing).toMatchObject({ toolCall: { id: "call/2" }, isError: true });
		expect(updates).toHaveLength(1);
		expect(events.map((event) => [event.type, event.toolCallId, event.parentToolCallId])).toEqual([
			["tool_execution_start", "call/1", "call"],
			["tool_execution_update", "call/1", "call"],
			["tool_execution_end", "call/1", "call"],
			["tool_execution_start", "call/2", "call"],
			["tool_execution_end", "call/2", "call"],
		]);
		expect(runner.takeRecord("call")?.calls).toEqual({
			calls: [
				{ id: "call/1", name: "echo", arguments: { a: 1 }, status: "ok", durationMs: expect.any(Number) },
				{
					id: "call/2",
					name: "missing",
					arguments: {},
					status: "error",
					durationMs: expect.any(Number),
					error: "Tool missing not found",
				},
			],
			complete: true,
		});
		// The record is taken once.
		expect(runner.takeRecord("call")).toBeUndefined();
		expect(runner.takeRecord("other")).toBeUndefined();
	});

	it("records calls of nested tools on the model-issued call", async () => {
		const leaf: AgentTool = {
			name: "leaf",
			label: "Leaf",
			description: "Leaf",
			parameters: Type.Object({}),
			async execute() {
				return { content: [], details: {} };
			},
		};
		const tools: AgentTool[] = [leaf];
		const { runner } = createRunner(tools);
		tools.push({
			name: "middle",
			label: "Middle",
			description: "Calls leaf",
			parameters: Type.Object({}),
			async execute(toolCallId) {
				await runner.execute(toolCallId, "leaf", {});
				return { content: [], details: {} };
			},
		});

		await runner.execute("call", "middle", {});

		expect(runner.takeRecord("call")?.calls?.calls.map((call) => call.id)).toEqual(["call/1", "call/1/1"]);
	});

	it("sums the usage of nested results at every depth", async () => {
		const leaf: AgentTool = {
			name: "leaf",
			label: "Leaf",
			description: "Leaf",
			parameters: Type.Object({}),
			async execute() {
				return { content: [], details: {}, usage: usage(10, 0.01) };
			},
		};
		const plain: AgentTool = { ...leaf, name: "plain", execute: async () => ({ content: [], details: {} }) };
		const tools: AgentTool[] = [leaf, plain];
		const { runner } = createRunner(tools);
		tools.push({
			name: "middle",
			label: "Middle",
			description: "Calls leaf",
			parameters: Type.Object({}),
			async execute(toolCallId) {
				await runner.execute(toolCallId, "leaf", {});
				// Its own usage only: the leaf's usage is counted once, by the recorder.
				return { content: [], details: {}, usage: usage(5, 0.005) };
			},
		});

		await runner.execute("call", "middle", {});
		await runner.execute("call", "leaf", {});
		await runner.execute("call", "plain", {});
		await runner.execute("free", "plain", {});

		const summary = runner.takeRecord("call");
		expect(summary?.usage?.input).toBe(25);
		expect(summary?.usage?.cost.total).toBeCloseTo(0.025, 10);
		expect(runner.takeRecord("free")).toMatchObject({ calls: { complete: true }, usage: undefined });
	});

	it("serializes concurrent calls to sequential tools", async () => {
		let active = 0;
		let maxActive = { sequential: 0, parallel: 0 };
		const makeTool = (name: "sequential" | "parallel"): AgentTool => ({
			name,
			label: name,
			description: name,
			parameters: Type.Object({}),
			executionMode: name === "sequential" ? "sequential" : undefined,
			async execute() {
				active++;
				maxActive = { ...maxActive, [name]: Math.max(maxActive[name], active) };
				await new Promise((resolve) => setTimeout(resolve, 5));
				active--;
				return { content: [], details: {} };
			},
		});
		const { runner } = createRunner([makeTool("sequential"), makeTool("parallel")]);

		await Promise.all([1, 2, 3].map(() => runner.execute("call", "sequential", {})));
		await Promise.all([1, 2, 3].map(() => runner.execute("call", "parallel", {})));

		expect(maxActive).toEqual({ sequential: 1, parallel: 3 });
	});
});

describe("NestedCallRecorder", () => {
	const call = (id: string, args: AgentToolCall["arguments"]): AgentToolCall => ({
		type: "toolCall",
		id,
		name: "t",
		arguments: args,
	});

	it("omits oversized arguments and drops calls beyond the limit", () => {
		const recorder = new NestedCallRecorder();
		expect(recorder.snapshot()).toBeUndefined();
		const small = recorder.start(call("a", { x: 1 }));
		recorder.finish(small, false, "");
		expect(recorder.snapshot()).toEqual({
			calls: [{ id: "a", name: "t", arguments: { x: 1 }, status: "ok", durationMs: expect.any(Number) }],
			complete: true,
		});

		const big = recorder.start(call("b", { text: "x".repeat(NESTED_CALL_LIMITS.maxArgumentBytesPerCall) }));
		recorder.finish(big, true, "e".repeat(1000));
		const snapshot = recorder.snapshot();
		expect(snapshot?.complete).toBe(false);
		expect(snapshot?.calls[1]).toMatchObject({ id: "b", status: "error" });
		expect(snapshot?.calls[1].arguments).toBeUndefined();
		expect(snapshot?.calls[1].argumentsBytes).toBeGreaterThan(NESTED_CALL_LIMITS.maxArgumentBytesPerCall);
		expect(snapshot?.calls[1].error).toHaveLength(NESTED_CALL_LIMITS.maxErrorChars);

		for (let i = 0; i < NESTED_CALL_LIMITS.maxCalls; i++)
			recorder.finish(recorder.start(call(`c${i}`, {})), false, "");
		expect(recorder.snapshot()?.calls).toHaveLength(NESTED_CALL_LIMITS.maxCalls);
	});

	it("caps the total argument size and marks unfinished calls incomplete", () => {
		const recorder = new NestedCallRecorder();
		const chunk = { text: "x".repeat(7000) };
		const records = Array.from({ length: 6 }, (_, i) => recorder.start(call(`c${i}`, chunk)));
		const snapshot = recorder.snapshot();
		// 32 KiB fits four 7000-byte argument objects.
		expect(snapshot?.calls.filter((entry) => entry.arguments !== undefined)).toHaveLength(4);
		expect(snapshot?.calls.every((entry) => entry.status === "unfinished")).toBe(true);
		expect(snapshot?.complete).toBe(false);
		expect(records).toHaveLength(6);
	});
});

describe("NestedToolCallRunner after an early return (detached scripts)", () => {
	const quick: AgentTool = {
		name: "quick",
		label: "Quick",
		description: "Quick",
		parameters: Type.Object({}),
		async execute() {
			return { content: [], details: {}, usage: usage(5, 0.005) };
		},
	};

	// Facts section 3 of the xin-pi notes: the first two document what happens without detach().
	it("without detach, taking the record resets the ids and drops later usage", async () => {
		const { runner } = createRunner([quick]);
		await runner.execute("call", "quick", {});
		expect(runner.takeRecord("call")?.calls?.calls.map((call) => call.id)).toEqual(["call/1"]);
		const later = await runner.execute("call", "quick", {});
		expect(later.toolCall.id).toBe("call/1"); // duplicate id
		expect(runner.takeRecord("call")?.usage?.cost.total).toBe(0.005); // only the call after the take
	});

	it("without detach, clear() resets the ids", async () => {
		const { runner } = createRunner([quick]);
		await runner.execute("call", "quick", {});
		runner.clear();
		expect((await runner.execute("call", "quick", {})).toolCall.id).toBe("call/1");
	});

	it("detach keeps the ids counting through takeRecord and clear", async () => {
		const { runner } = createRunner([quick]);
		await runner.execute("call", "quick", {});
		runner.detach("call");
		expect(runner.takeRecord("call")?.calls?.calls.map((call) => call.id)).toEqual(["call/1"]);
		runner.clear();
		expect((await runner.execute("call", "quick", {})).toolCall.id).toBe("call/2");
		expect((await runner.execute("call", "quick", {})).toolCall.id).toBe("call/3");
	});

	it("detach keeps recording calls; release returns them all and the usage no result message counted", async () => {
		const { runner } = createRunner([quick]);
		await runner.execute("call", "quick", {});
		runner.detach("call");
		expect(runner.takeRecord("call")?.usage?.cost.total).toBeCloseTo(0.005);
		await runner.execute("call", "quick", {});
		await runner.execute("call", "quick", {});
		const released = runner.release("call");
		expect(released?.calls?.calls.map((call) => call.id)).toEqual(["call/1", "call/2", "call/3"]);
		expect(released?.usage?.cost.total).toBeCloseTo(0.01); // only the two calls after the take
		expect(runner.release("call")).toBeUndefined();
		// a fresh scope, but ids already handed out are never repeated
		expect((await runner.execute("call", "quick", {})).toolCall.id).toBe("call/4");
	});

	it("C2: a release before the result message took the record leaves everything to that take", async () => {
		const { runner } = createRunner([quick]);
		await runner.execute("call", "quick", {});
		runner.detach("call");
		expect(runner.release("call")).toBeUndefined();
		expect(runner.takeRecord("call")?.usage?.cost.total).toBeCloseTo(0.005);
	});

	it("C5: a reused tool call id gets a fresh scope; the old script keeps its own and never repeats ids", async () => {
		const { runner } = createRunner([quick]);
		const oldToken = {};
		const newToken = {};
		await runner.execute("call", "quick", {}, {}, oldToken);
		runner.detach("call", oldToken);
		runner.takeRecord("call");
		// a new model call reuses the id: it has no nested call yet, so the old record must not be taken for it
		expect(runner.takeRecord("call")).toBeUndefined();
		const fresh = await runner.execute("call", "quick", {}, {}, newToken);
		expect(fresh.toolCall.id).toBe("call/2"); // never "call/1" again
		expect((await runner.execute("call", "quick", {}, {}, oldToken)).toolCall.id).toBe("call/3");
		// the old release must not delete the new call's scope
		runner.release("call", oldToken);
		const newRecord = runner.takeRecord("call");
		expect(newRecord?.calls?.calls.map((call) => call.id)).toEqual(["call/2"]);
		expect(newRecord?.usage?.cost.total).toBeCloseTo(0.005);
	});

	it("C4: calls of a detached scope run against the context captured at detach", async () => {
		const seen: unknown[] = [];
		let current = "turn-1";
		const events: NestedToolExecutionEvent[] = [];
		const runner = new NestedToolCallRunner({
			getTools: () => [quick],
			isSequential: () => false,
			captureOrigin: () => current,
			runToolCall: async (toolCall, _parent, _signal, _onUpdate, origin) => {
				seen.push(origin);
				return { toolCall, result: { content: [], details: {} }, isError: false };
			},
			emit: async (event) => void events.push(event),
		});
		await runner.execute("a", "quick", {}); // never detached: no origin
		runner.detach("a");
		current = "turn-2"; // the session moved on
		await runner.execute("a", "quick", {});
		expect(seen).toEqual([undefined, "turn-1"]);
	});

	it("clear() keeps the scopes of nested calls that run below a detached script", async () => {
		const tools: AgentTool[] = [];
		const { runner } = createRunner(tools);
		let inner: string[] = [];
		let proceed!: () => void;
		const gate = new Promise<void>((r) => {
			proceed = r;
		});
		tools.push(quick, {
			name: "middle",
			label: "Middle",
			description: "Middle",
			parameters: Type.Object({}),
			async execute(toolCallId) {
				await gate;
				inner = [(await runner.execute(toolCallId, "quick", {})).toolCall.id];
				inner.push((await runner.execute(toolCallId, "quick", {})).toolCall.id);
				return { content: [], details: {} };
			},
		});
		runner.detach("call");
		const running = runner.execute("call", "middle", {});
		await new Promise((r) => setTimeout(r, 0));
		runner.clear(); // agent_end while the script is still running
		proceed();
		await running;
		expect(inner).toEqual(["call/1/1", "call/1/2"]);
		runner.takeRecord("call"); // the result message of the early return
		expect(runner.release("call")?.calls?.calls.map((call) => call.id)).toEqual(["call/1", "call/1/1", "call/1/2"]);
	});

	it("a detached script's calls do not deadlock behind the exclusive queue of sequential agents", async () => {
		const { runner } = createRunner([quick], { sequential: true });
		runner.detach("call");
		const [a, b] = await Promise.all([runner.execute("call", "quick", {}), runner.execute("call", "quick", {})]);
		expect([a.toolCall.id, b.toolCall.id]).toEqual(["call/1", "call/2"]);
		// ... and another caller's call still runs after them.
		expect((await runner.execute("other", "quick", {})).toolCall.id).toBe("other/1");
	});
});

describe("NestedToolCallRunner exclusive queue (sequential agents)", () => {
	const gates: Array<() => void> = [];
	const slow: AgentTool = {
		name: "slow",
		label: "Slow",
		description: "Waits for the test",
		parameters: Type.Object({}),
		async execute() {
			await new Promise<void>((resolve) => gates.push(resolve));
			return { content: [], details: {} };
		},
	};
	const quick: AgentTool = {
		name: "quick",
		label: "Quick",
		description: "Quick",
		parameters: Type.Object({}),
		async execute() {
			return { content: [], details: {} };
		},
	};
	const tick = () => new Promise((r) => setTimeout(r, 10));

	it("C3: a detached script holding the queue does not block a foreground call, nor the other way round", async () => {
		const { runner } = createRunner([slow, quick], { sequential: true });
		const detachedToken = {};
		runner.detach("bg", detachedToken);
		const background = runner.execute("bg", "slow", {}, {}, detachedToken); // holds its (own) queue
		await tick();
		const done = await Promise.race([
			runner.execute("fg", "quick", {}, {}, {}).then(() => "ran"),
			tick().then(() => "blocked"),
		]);
		expect(done).toBe("ran");
		gates.shift()?.();
		await background;
		// a foreground slow call does not hold up the detached script either
		const fgSlow = runner.execute("fg2", "slow", {}, {}, {});
		await tick();
		const bgQuick = await Promise.race([
			runner.execute("bg", "quick", {}, {}, detachedToken).then(() => "ran"),
			tick().then(() => "blocked"),
		]);
		expect(bgQuick).toBe("ran");
		gates.shift()?.();
		await fgSlow;
	});

	it("C3: a call waiting on the queue gives up when its signal aborts, and the queue keeps its order", async () => {
		const { runner } = createRunner([slow, quick], { sequential: true });
		const holder = runner.execute("a", "slow", {});
		await tick();
		const controller = new AbortController();
		const waiting = runner.execute("a", "quick", {}, { signal: controller.signal });
		await tick();
		controller.abort();
		const outcome = await waiting;
		expect(outcome.isError).toBe(true);
		const next = runner.execute("a", "quick", {});
		const early = await Promise.race([next.then(() => "ran"), tick().then(() => "waiting")]);
		expect(early).toBe("waiting"); // still behind the holder
		gates.shift()?.();
		await holder;
		expect((await next).isError).toBe(false);
	});
});
