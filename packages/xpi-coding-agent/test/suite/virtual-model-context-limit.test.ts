import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "xpi-ai";
import type { SessionBeforeCompactEvent } from "../../src/core/extensions/index.ts";
import type { CompactionEntry } from "../../src/core/session-manager.ts";
import type { ModelRoute } from "../../src/core/virtual-models.ts";
import { createHarness, type Harness } from "./harness.ts";

const BIG = "x".repeat(4000); // about 1000 tokens
const PLACEHOLDER = "Tool output removed to save context";
const NO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("route context limit", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	/** A virtual model that routes to "large" (50k window) and returns `limit` as the route limit. */
	async function setup(
		options: {
			limit?: unknown;
			reserveTokens?: number;
			supplySummary?: boolean;
			prune?: boolean;
			enabled?: boolean;
			minSavings?: number;
			seedUsage?: number;
		} = {},
	) {
		const events: SessionBeforeCompactEvent[] = [];
		const harness = await createHarness({
			models: [{ id: "large", contextWindow: 50_000, maxTokens: 4000 }],
			settings: {
				compaction: {
					enabled: options.enabled ?? true,
					reserveTokens: options.reserveTokens ?? 0,
					keepRecentTokens: 1,
					prune: {
						enabled: options.prune ?? true,
						protectTokens: 1000,
						minSavingsTokens: options.minSavings ?? 500,
					},
				},
			},
			extensionFactories: [
				(pi) => {
					pi.registerVirtualModel({
						provider: "router",
						id: "auto",
						name: "Auto",
						contextWindow: 50_000,
						route(_request, ctx): ModelRoute {
							const model = ctx.modelRegistry.find("faux", "large")!;
							return { model, thinkingLevel: "off", contextLimit: options.limit as number | undefined };
						},
					});
					pi.on("session_before_compact", async (event) => {
						events.push(event);
						if (options.supplySummary === false) return undefined;
						const { firstKeptEntryId, tokensBefore } = event.preparation;
						return { compaction: { summary: "supplied summary", firstKeptEntryId, tokensBefore } };
					});
				},
			],
		});
		harnesses.push(harness);
		const runtime = harness.session.modelRuntime;
		harness.session.agent.streamFunction = (model, context, opts) => runtime.streamSimple(model, context, opts);
		await harness.session.setModel(runtime.getModel("router", "auto")!);
		seed(harness, 6, options.seedUsage);
		return { harness, events };
	}

	/** `turns` user turns, each with a read call whose output is about 1000 tokens, and no usage. */
	function seed(harness: Harness, turns: number, seedUsage?: number): void {
		const model = harness.getModel();
		let now = Date.now() - 10_000;
		for (let n = 1; n <= turns; n++) {
			harness.sessionManager.appendMessage({ role: "user", content: `question ${n}`, timestamp: now++ });
			harness.sessionManager.appendMessage({
				...fauxAssistantMessage(
					[{ type: "toolCall", id: `call-${n}`, name: "read", arguments: { path: `/f-${n}` } }],
					{ stopReason: "toolUse", timestamp: now++ },
				),
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: seedUsage ? { ...NO_USAGE, input: seedUsage, totalTokens: seedUsage } : NO_USAGE,
			});
			harness.sessionManager.appendMessage({
				role: "toolResult",
				toolCallId: `call-${n}`,
				toolName: "read",
				content: [{ type: "text", text: BIG }],
				isError: false,
				timestamp: now++,
			});
		}
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
	}

	const compactions = (harness: Harness) =>
		harness.sessionManager.getEntries().filter((entry): entry is CompactionEntry => entry.type === "compaction");
	const edits = (harness: Harness) => harness.sessionManager.getEntries().filter((e) => e.type === "context_edit");

	async function run(harness: Harness): Promise<void> {
		harness.setResponses([fauxAssistantMessage("ok")]);
		await harness.session.prompt("go");
	}

	it("compacts at the limit and not before, and records the limit on the entry", async () => {
		// About 6000 tokens of history.
		const above = await setup({ limit: 9000, prune: false });
		await run(above.harness);
		expect(compactions(above.harness)).toHaveLength(0);
		expect(above.events).toHaveLength(0);

		const below = await setup({ limit: 3000, prune: false });
		await run(below.harness);
		expect(below.harness.eventsOfType("compaction_start").map((e) => e.reason)).toEqual(["threshold"]);
		expect(compactions(below.harness).map((c) => [c.fromHook, c.contextLimit])).toEqual([[true, 3000]]);
		expect(below.events.map((e) => e.contextLimit)).toEqual([3000]);
	});

	it("writes contextLimit when the default summary generator wrote the summary", async () => {
		const { harness } = await setup({ limit: 3000, prune: false, supplySummary: false });
		await run(harness);
		expect(compactions(harness).map((c) => [c.fromHook, c.contextLimit])).toEqual([[false, 3000]]);
	});

	it("does nothing without a route limit", async () => {
		const { harness, events } = await setup({});
		await run(harness);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
		expect(compactions(harness)).toHaveLength(0);
		expect(edits(harness)).toHaveLength(0);
		expect(events).toHaveLength(0);
	});

	it("lets the smaller of the limit and the model threshold win", async () => {
		// The threshold of 1000 (window 50000, reserve 49000) is below the limit: an ordinary threshold compaction.
		const low = await setup({ limit: 3000, reserveTokens: 49_000, prune: false });
		await run(low.harness);
		// The check after the run compacts once more under this tiny threshold.
		expect(compactions(low.harness).length).toBeGreaterThan(0);
		expect(compactions(low.harness).every((c) => c.contextLimit === undefined)).toBe(true);
		expect(compactions(low.harness)[0].contextLimit).toBeUndefined();
		expect(low.events[0].contextLimit).toBeUndefined();

		// Above both, with the limit the smaller one: the limit is recorded too (checked through prepareRequest, as the check before a prompt does not know the route limit).
		const both = await setup({ limit: 400, reserveTokens: 49_500, prune: false });
		await both.harness.session.agent.prepareRequest?.(
			{ context: { messages: [], tools: [] }, model: both.harness.session.model!, thinkingLevel: "off" } as never,
			undefined as never,
		);
		expect(compactions(both.harness).map((c) => c.contextLimit)).toEqual([400]);

		// A limit above the threshold does not delay it.
		const high = await setup({ limit: 40_000, reserveTokens: 49_000, prune: false });
		await run(high.harness);
		expect(compactions(high.harness).length).toBeGreaterThan(0);
		expect(compactions(high.harness).every((c) => c.contextLimit === undefined)).toBe(true);
	});

	it("writes no summary when pruning gets to 90 percent of the limit", async () => {
		// Pruning leaves about 1100 tokens: under 0.9 * 3000.
		const { harness, events } = await setup({ limit: 3000 });
		await run(harness);
		expect(edits(harness)).toHaveLength(5);
		expect(compactions(harness)).toHaveLength(0);
		expect(events).toHaveLength(0);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
		// The conversation's messages stay; only the old tool output is replaced.
		const text = JSON.stringify(harness.session.agent.state.messages);
		expect(text).toContain("question 1");
		expect(text.split(PLACEHOLDER)).toHaveLength(6);
	});

	it("writes a summary when pruning does not get to 90 percent of the limit", async () => {
		// The pruned context is about 1100 tokens: over 0.9 * 1200 = 1080.
		const { harness, events } = await setup({ limit: 1200 });
		await run(harness);
		expect(edits(harness).length).toBeGreaterThan(0);
		expect(compactions(harness).map((c) => c.contextLimit)).toEqual([1200]);
		expect(events.map((e) => e.contextLimit)).toEqual([1200]);
	});

	it("rejects a limit that is not a positive integer, naming the virtual model and the value", async () => {
		for (const bad of [0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "9000"]) {
			const { harness } = await setup({ limit: bad });
			await run(harness);
			const last = harness.session.messages.at(-1);
			expect(last).toMatchObject({ role: "assistant", stopReason: "error" });
			const message = (last as { errorMessage?: string }).errorMessage ?? "";
			expect(message).toContain("router/auto");
			expect(message).toContain(String(bad));
		}
	});

	it("carries the limit through resolveModel and ignores it for direct requests", async () => {
		const { harness } = await setup({ limit: -1 });
		const { modelRuntime, model } = harness.session;
		const direct = await modelRuntime.resolveModel(model!, [], { reason: "direct", thinkingLevel: "off" });
		expect(direct.contextLimit).toBeUndefined();
		await expect(modelRuntime.resolveModel(model!, [], { reason: "user", thinkingLevel: "off" })).rejects.toThrow(
			/-1/,
		);
		const ok = await setup({ limit: 123 });
		const carried = await ok.harness.session.modelRuntime.resolveModel(ok.harness.session.model!, [], {
			reason: "user",
			thinkingLevel: "off",
		});
		expect(carried.contextLimit).toBe(123);
	});

	it("does not compact again without a response in between, and does after one", async () => {
		const { harness } = await setup({ limit: 3000, prune: false });
		// A compaction that keeps everything is the newest entry: the context stays over the limit.
		harness.sessionManager.appendCompaction("kept all", harness.sessionManager.getBranch()[0].id, 6000);
		const prepare = async () => {
			await harness.session.agent.prepareRequest?.(
				{ context: { messages: [], tools: [] }, model: harness.session.model!, thinkingLevel: "off" } as never,
				undefined as never,
			);
		};
		await prepare();
		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
		expect(compactions(harness)).toHaveLength(1);

		harness.sessionManager.appendMessage({
			...fauxAssistantMessage("answer"),
			api: "faux",
			provider: "faux",
			model: "large",
			usage: NO_USAGE,
		} as never);
		await prepare();
		expect(compactions(harness)).toHaveLength(2);
		expect(compactions(harness)[1].contextLimit).toBe(3000);
	});

	it("decides the prune on the re-estimate when seeded usage is above the limit, and does not repeat", async () => {
		// The provider's count (20000) is above the limit; after the prune the estimate is characters/4 (about 1100).
		const { harness, events } = await setup({ limit: 3000, seedUsage: 20_000 });
		await run(harness);
		expect(edits(harness)).toHaveLength(5);
		expect(compactions(harness)).toHaveLength(0);
		expect(events).toHaveLength(0);

		// The next request follows a response and has no new tool output: nothing to prune or compact.
		await run(harness);
		expect(edits(harness)).toHaveLength(5);
		expect(compactions(harness)).toHaveLength(0);
	});

	it("compacts nothing above the ordinary threshold's reach without a limit, and nothing when compaction is disabled", async () => {
		// Without a limit the ordinary threshold applies as before (1000 tokens here).
		const plain = await setup({ reserveTokens: 49_000, prune: false });
		await run(plain.harness);
		expect(compactions(plain.harness).length).toBeGreaterThan(0);
		expect(compactions(plain.harness).every((c) => c.contextLimit === undefined)).toBe(true);

		const off = await setup({ limit: 3000, enabled: false });
		await run(off.harness);
		expect(compactions(off.harness)).toHaveLength(0);
		expect(edits(off.harness)).toHaveLength(0);
	});

	it("goes on to the summary when the prune saves less than the minimum", async () => {
		const { harness, events } = await setup({ limit: 3000, minSavings: 100_000 });
		await run(harness);
		expect(edits(harness)).toHaveLength(0);
		expect(compactions(harness).map((c) => c.contextLimit)).toEqual([3000]);
		expect(events).toHaveLength(1);
	});

	it("sends the request when the summary fails, and tries again on the next request after a response", async () => {
		const { harness } = await setup({ limit: 3000, prune: false, supplySummary: false });
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom" }),
			fauxAssistantMessage("ok"),
		]);
		await expect(harness.session.prompt("go")).resolves.toBeUndefined();
		expect(compactions(harness)).toHaveLength(0);
		const ends = harness.eventsOfType("compaction_end");
		expect(ends).toHaveLength(1);
		expect(ends[0].errorMessage).toContain("Auto-compaction failed");
		expect(harness.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });

		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom" }),
			fauxAssistantMessage("ok"),
		]);
		await harness.session.prompt("again");
		expect(harness.eventsOfType("compaction_start").length).toBeGreaterThan(1);
	});

	it("rejects null and 0 as limits", async () => {
		for (const bad of [null, 0]) {
			const { harness } = await setup({ limit: bad });
			await run(harness);
			expect(harness.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "error" });
		}
	});
});
