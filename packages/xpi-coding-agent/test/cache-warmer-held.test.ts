import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	evaluateHeldPrefix,
	type Model,
	type ModelsSimpleStreamOptions,
	type Tool,
	type Usage,
} from "xpi-ai";
import { getBuiltinModel } from "xpi-ai/providers/all";
import {
	CacheWarmer,
	type CacheWarmingAction,
	type CacheWarmingDecisionEvent,
	formatHeldPrefixStatus,
	HELD_PREFIX_NOTE,
} from "../src/core/cache-warmer.ts";
import { type SessionEntry, SessionManager, type UsageEntry } from "../src/core/session-manager.ts";
import type { CacheWarmingMode } from "../src/core/settings-manager.ts";

const model: Model<Api> = {
	...getBuiltinModel("anthropic", "claude-opus-4-6"),
	promptCache: { short: 300, long: 3600 },
};
const unpriced: Model<Api> = { ...model, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };

const usage: Usage = {
	input: 0,
	output: 1,
	cacheRead: 100,
	cacheWrite: 0,
	totalTokens: 101,
	cost: { input: 0, output: 0, cacheRead: 0.01, cacheWrite: 0, total: 0.01 },
};

function response(m: Model<Api>, stopReason: AssistantMessage["stopReason"] = "length"): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: m.api,
		provider: m.provider,
		model: m.id,
		usage,
		stopReason,
		timestamp: 0,
	};
}

/** A prefix of `chars` characters in the tool descriptions. */
function tools(chars: number): Tool[] {
	return [{ name: "t", description: "d".repeat(chars), parameters: { type: "object", properties: {} } }];
}

const branch: SessionEntry[] = [
	{
		type: "message",
		id: "a",
		parentId: null,
		timestamp: new Date(0).toISOString(),
		message: { ...response(model), usage: { ...usage, cacheRead: 100_000, totalTokens: 100_010 } },
	},
];

function setup(
	options: {
		mode?: CacheWarmingMode;
		decide?: (event: CacheWarmingDecisionEvent) => CacheWarmingAction;
		result?: (m: Model<Api>) => Promise<AssistantMessage>;
	} = {},
) {
	const calls: Array<{ model: Model<Api>; context: Context; options: ModelsSimpleStreamOptions | undefined }> = [];
	const events: CacheWarmingDecisionEvent[] = [];
	const warmed: UsageEntry[] = [];
	const manager = SessionManager.inMemory();
	const appendUsage = vi.fn(manager.appendUsage.bind(manager));
	const state = { mode: options.mode ?? "streaming", current: true };
	const warmer = new CacheWarmer(
		{
			streamSimple: (m, context, streamOptions) => {
				calls.push({ model: m, context, options: streamOptions });
				return {
					result: () => (options.result ?? (async (x: Model<Api>) => response(x)))(m),
				} as unknown as AssistantMessageEventStream;
			},
		},
		{ appendUsage, getBranch: () => branch },
		() => state.mode,
		async (event) => {
			events.push(event);
			return options.decide?.(event) ?? event.action;
		},
	);
	warmer.onWarmed = (entry) => warmed.push(entry);
	const send = (
		label: { key: string; holdPrefix?: string } | undefined,
		over: { model?: Model<Api>; chars?: number; options?: ModelsSimpleStreamOptions } = {},
	) => {
		warmer.setRouteCache(label);
		warmer.start(
			{
				model: over.model ?? model,
				context: {
					systemPrompt: "system",
					tools: tools(over.chars ?? 80_000),
					messages: [{ role: "user", content: "hello", timestamp: 0 }],
				},
				options: over.options ?? { sessionId: "s" },
			},
			() => false, // the ordinary entry is never current under a virtual model
			() => state.current,
		);
	};
	return { warmer, calls, events, warmed, appendUsage, state, send };
}

const LEAD = { key: "lead" };
const WORKER = { key: "worker", holdPrefix: "lead" };

afterEach(() => vi.useRealTimers());

describe("held prefix", () => {
	it("refreshes the held prefix as a new request while holding requests continue", async () => {
		vi.useFakeTimers();
		const { warmer, calls, events, warmed, appendUsage, send } = setup();
		send(LEAD, { options: { sessionId: "s", reasoning: undefined } });
		send(WORKER, { model: { ...model, id: "other" } });
		expect(warmer.heldStatus).toMatchObject({ key: "lead", state: "scheduled", refreshes: 0 });

		await vi.advanceTimersByTimeAsync(270_000);
		expect(calls).toHaveLength(1);
		const [call] = calls;
		expect(call.model).toBe(model);
		expect(call.context.systemPrompt).toBe("system");
		expect(call.context.tools).toEqual(tools(80_000));
		expect(call.context.messages).toHaveLength(1);
		expect(call.context.messages[0]).toMatchObject({ role: "user", content: "." });
		expect(call.options).toMatchObject({ sessionId: "s", maxTokens: 1, maxRetries: 0, disableContinuation: true });
		expect(events[0]).toMatchObject({ type: "cache_warming_decision", key: "lead", action: "warm" });
		expect(appendUsage).toHaveBeenCalledWith(
			"cache_warm",
			model.provider,
			model.id,
			usage,
			`${HELD_PREFIX_NOTE}lead`,
		);
		expect(warmed).toHaveLength(1);

		// Another worker request keeps the hold and its timer.
		send(WORKER);
		await vi.advanceTimersByTimeAsync(270_000);
		expect(calls).toHaveLength(2);
		expect(warmer.heldStatus?.refreshes).toBe(2);
		warmer.cancel();
	});

	it("times the first refresh from the held request, not from the hold", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const { warmer, calls, send } = setup();
		send(LEAD);
		await vi.advanceTimersByTimeAsync(100_000);
		send(WORKER);
		await vi.advanceTimersByTimeAsync(169_999);
		expect(calls).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(calls).toHaveLength(1);
		warmer.cancel();
	});

	it("ends when a request is sent under the held key, and aborts a refresh in flight", async () => {
		vi.useFakeTimers();
		const { warmer, calls, send } = setup({ result: () => new Promise(() => {}) });
		send(LEAD);
		send(WORKER);
		await vi.advanceTimersByTimeAsync(270_000);
		expect(warmer.heldStatus?.state).toBe("refreshing");
		send(LEAD);
		expect(warmer.heldStatus).toBeUndefined();
		expect(calls[0].options?.signal?.aborted).toBe(true);
		await vi.advanceTimersByTimeAsync(600_000);
		expect(calls).toHaveLength(1);
	});

	it("ends when a labelled request does not hold it", async () => {
		vi.useFakeTimers();
		const { warmer, calls, send } = setup();
		send(LEAD);
		send(WORKER);
		send({ key: "other" });
		expect(warmer.heldStatus).toBeUndefined();
		await vi.advanceTimersByTimeAsync(600_000);
		expect(calls).toHaveLength(0);
	});

	it("ends when the run settles, in every mode", async () => {
		vi.useFakeTimers();
		for (const mode of ["streaming", "idle"] as const) {
			const { warmer, calls, send } = setup({ mode });
			send(LEAD);
			send(WORKER);
			warmer.onAgentSettled();
			expect(warmer.heldStatus).toBeUndefined();
			await vi.advanceTimersByTimeAsync(600_000);
			expect(calls).toHaveLength(0);
		}
	});

	it("ends when the selection or branch is no longer current, when ended by the session, and on cancel", async () => {
		vi.useFakeTimers();
		const stale = setup();
		stale.send(LEAD);
		stale.send(WORKER);
		stale.state.current = false;
		await vi.advanceTimersByTimeAsync(270_000);
		expect(stale.calls).toHaveLength(0);
		expect(stale.warmer.heldStatus).toBeUndefined();

		const changed = setup();
		changed.send(LEAD);
		changed.send(WORKER);
		changed.warmer.endHeld();
		expect(changed.warmer.heldStatus).toBeUndefined();

		const cancelled = setup();
		cancelled.send(LEAD);
		cancelled.send(WORKER);
		cancelled.warmer.cancel();
		await vi.advanceTimersByTimeAsync(600_000);
		expect(cancelled.calls).toHaveLength(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("neither sets nor ends a hold by an unlabelled request", async () => {
		vi.useFakeTimers();
		const { warmer, calls, send } = setup();
		send(LEAD);
		send(WORKER);
		send(undefined);
		expect(warmer.heldStatus?.key).toBe("lead");
		// An unlabelled request cannot hold anything either.
		const other = setup();
		other.send(LEAD);
		other.send(undefined);
		expect(other.warmer.heldStatus).toBeUndefined();
		await vi.advanceTimersByTimeAsync(270_000);
		expect(calls).toHaveLength(1);
		expect(other.calls).toHaveLength(0);
		warmer.cancel();
	});

	it("consumes a label once", () => {
		const { warmer, send } = setup();
		send(LEAD);
		send(WORKER);
		warmer.setRouteCache(undefined);
		expect(warmer.heldStatus?.key).toBe("lead");
		// A label set but not followed by a session request does not leak into the next unlabelled one.
		warmer.setRouteCache({ key: "x" });
		warmer.setRouteCache(undefined);
		warmer.start({ model, context: { messages: [] }, options: {} }, () => false);
		expect(warmer.heldStatus?.key).toBe("lead");
		warmer.cancel();
	});

	it("holds nothing without a remembered request, with warming off, or for an unreplayable request", () => {
		const first = setup();
		first.send(WORKER);
		expect(first.warmer.heldStatus).toBeUndefined();

		const off = setup({ mode: "off" });
		off.send(LEAD);
		off.send(WORKER);
		expect(off.warmer.heldStatus).toBeUndefined();

		const budget: Model<Api> = {
			...getBuiltinModel("anthropic", "claude-sonnet-4-5"),
			promptCache: { short: 300, long: 3600 },
		};
		const budgeted = setup();
		budgeted.send(LEAD, { model: budget, options: { reasoning: "high" } });
		budgeted.send(WORKER);
		expect(budgeted.warmer.heldStatus).toBeUndefined();

		const none = setup();
		none.send(LEAD, { options: { cacheRetention: "none" } });
		none.send(WORKER);
		expect(none.warmer.heldStatus).toBeUndefined();
	});

	it("disables a held prefix when the mode becomes off", async () => {
		vi.useFakeTimers();
		const { warmer, calls, state, send } = setup();
		send(LEAD);
		send(WORKER);
		state.mode = "off";
		warmer.onModeChanged();
		expect(warmer.heldStatus).toBeUndefined();
		await vi.advanceTimersByTimeAsync(600_000);
		expect(calls).toHaveLength(0);
	});

	it("keeps the ordinary entry and the held slot apart", async () => {
		vi.useFakeTimers();
		const { warmer, calls, send } = setup();
		send(LEAD);
		send(WORKER);
		// An ordinary start without a label replaces the ordinary entry only.
		warmer.start({ model, context: { messages: [] }, options: {} }, () => true);
		expect(warmer.status.state).toBe("scheduled");
		expect(warmer.heldStatus?.key).toBe("lead");
		// A labelled request ends the hold without touching the ordinary entry it just started.
		send({ key: "other" });
		expect(warmer.heldStatus).toBeUndefined();

		// Under a virtual model the ordinary entry stops on its own; the hold continues.
		send(LEAD);
		send(WORKER);
		await vi.advanceTimersByTimeAsync(270_000);
		expect(warmer.status).toMatchObject({ state: "inactive", reason: "conversation context changed" });
		expect(warmer.heldStatus?.refreshes).toBe(1);
		expect(calls).toHaveLength(1);
		warmer.cancel();
	});

	it("stops when the refreshes would cost more than writing the prefix again", async () => {
		vi.useFakeTimers();
		// 24,000 characters: about 6,000 tokens; a write adds $0.0345 to a read; each refresh is billed $0.01.
		const { warmer, calls, events, send } = setup();
		send(LEAD, { chars: 24_000 });
		send(WORKER);
		for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(270_000);
		expect(calls).toHaveLength(4);
		expect(events.map((e) => e.action)).toEqual(["warm", "warm", "warm", "warm", "stop"]);
		expect(warmer.heldStatus).toBeUndefined();
	});

	it("stops an hour after the held request, whatever an extension says", async () => {
		vi.useFakeTimers();
		// The extension always warms, so only the one-hour limit can end the hold.
		const { warmer, calls, send } = setup({ decide: () => "warm" });
		send(LEAD);
		send(WORKER);
		// Refreshes every 270 s: 13 of them fit before the hour, the 14th would be due after it.
		for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(270_000);
		expect(calls).toHaveLength(13);
		expect(warmer.heldStatus).toBeUndefined();
	});

	it("sends no refresh when the prices are unknown", async () => {
		vi.useFakeTimers();
		const { warmer, calls, events, send } = setup();
		send(LEAD, { model: unpriced });
		send(WORKER);
		await vi.advanceTimersByTimeAsync(270_000);
		expect(calls).toHaveLength(0);
		expect(events[0]?.action).toBe("stop");
		expect(warmer.heldStatus).toBeUndefined();
		expect(evaluateHeldPrefix(unpriced, 10_000, 0).economicsAvailable).toBe(false);
	});

	it("lets an extension stop a refresh, and passes the key", async () => {
		vi.useFakeTimers();
		const { warmer, calls, events, send } = setup({ decide: () => "stop" });
		send(LEAD);
		send(WORKER);
		await vi.advanceTimersByTimeAsync(270_000);
		expect(events[0]?.key).toBe("lead");
		expect(calls).toHaveLength(0);
		expect(warmer.heldStatus).toBeUndefined();
	});

	it("does not record failed refreshes, and does not refresh after the deadline", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const failed = setup({ result: async (m) => response(m, "error") });
		failed.send(LEAD);
		failed.send(WORKER);
		await vi.advanceTimersByTimeAsync(270_000);
		expect(failed.appendUsage).not.toHaveBeenCalled();
		failed.warmer.cancel();

		vi.setSystemTime(0);
		const late = setup();
		late.send(LEAD);
		late.send(WORKER);
		vi.clearAllTimers();
		vi.setSystemTime(285_001);
		const internal = late.warmer as unknown as { held: object; refreshHeld: (held: object) => Promise<void> };
		await internal.refreshHeld(internal.held);
		expect(late.calls).toHaveLength(0);
		expect(late.warmer.heldStatus).toBeUndefined();
	});

	it("formats the status line", () => {
		expect(
			formatHeldPrefixStatus(
				{ key: "lead", state: "scheduled", nextWarmAt: 222_000, refreshes: 1, cost: 0.0123 },
				0,
			),
		).toBe("lead: Decision in 3m 42s; 1 refresh, $0.012");
	});
});
