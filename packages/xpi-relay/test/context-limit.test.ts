import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Api, Model } from "xpi-ai";
import {
	contextLimitOf,
	createRelay,
	HANDBACK_ENTRY,
	HANDOVER_ENTRY,
	initialView,
	LIMIT_ENTRY,
	limitSummaries,
	type NoticeLevel,
	RELAY_MODEL,
	RELAY_PROVIDER,
	type RelayCall,
	type RelayEntry,
	type RelayHost,
	type RelayRouteRequest,
	type RelayState,
	readPhase,
	readRelayConfig,
	roundContext,
	transition,
	VIRTUAL_MODEL_STATE_ENTRY,
} from "../src/index.ts";

const tier = (inputTokensAbove: number) => ({ inputTokensAbove, input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6 });
const priced = (id: string, tiers?: ReturnType<typeof tier>[]) =>
	({ id, cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25, ...(tiers ? { tiers } : {}) } }) as Model<Api>;

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** `createRelay` against a fake host with a small and a large model; the small one has a first tier at 100,000. */
function make(settings: Record<string, unknown> = {}, keep = 20_000) {
	const entries: RelayEntry[] = [];
	const notices: { text: string; level: NoticeLevel }[] = [];
	const sent: { content: string; deliverAs?: string }[] = [];
	let counter = 0;
	const cwd = mkdtempSync(join(tmpdir(), "xpi-relay-limit-"));
	dirs.push(cwd);
	const push = (entry: Record<string, unknown>) => {
		entries.push({ id: `e${counter++}`, timestamp: new Date().toISOString(), ...entry } as RelayEntry);
	};
	const host: RelayHost = {
		appendEntry: (customType, data) => push({ type: "custom", customType, data }),
		settings: () => ({ lead: "faux/large", worker: "faux/small", ...settings }),
		keepRecentTokens: () => keep,
		sendMessage: (message, options) => {
			sent.push({ content: message.content, deliverAs: options.deliverAs });
		},
		activeTools: () => ["read"],
		setActiveTools: () => {},
		registerTools: () => {},
	};
	const models = new Map<string, Model<Api>>([
		["faux/large", priced("large", [tier(200_000)])],
		["faux/small", priced("small", [tier(100_000)])],
	]);
	const call: RelayCall = {
		entries,
		model: { provider: RELAY_PROVIDER, id: RELAY_MODEL },
		cwd,
		signal: undefined,
		findModel: (ref) => models.get(ref),
		notify: (text, level = "info") => notices.push({ text, level }),
		isIdle: () => true,
	};
	return {
		relay: createRelay(host),
		call,
		entries,
		notices,
		sent,
		models,
		handover: (round: number) =>
			push({ type: "custom", customType: HANDOVER_ENTRY, data: { round, plan: "p", acceptance: [] } }),
		summary: (contextLimit?: number, details?: unknown) =>
			push({
				type: "compaction",
				summary: "s",
				...(contextLimit ? { contextLimit } : {}),
				...(details ? { details } : {}),
			}),
		record: (round: number) => push({ type: "compaction", summary: "record", details: { relay: true, round } }),
		message: (message: Record<string, unknown>) => push({ type: "message", message }),
		custom: (customType: string, data?: unknown) => push({ type: "custom", customType, data }),
		state: (state: RelayState) =>
			push({
				type: "custom",
				customType: VIRTUAL_MODEL_STATE_ENTRY,
				data: { provider: RELAY_PROVIDER, modelId: RELAY_MODEL, state },
			}),
	};
}

const request = (state: RelayState | undefined): RelayRouteRequest => ({ reason: "continuation", state, messages: [] });

describe("the context limit settings", () => {
	it("defaults to the tier for the worker and no limit for the lead", () => {
		const cfg = readRelayConfig({});
		expect(cfg.workerContext).toEqual({ limit: "tier", tierFraction: 0.95, maxCompactions: 4, whenStuck: "lift" });
		expect(cfg.leadContext).toEqual({ limit: "off", tierFraction: 0.95, maxCompactions: 4 });
	});

	it("reads every form of a limit", () => {
		expect(readRelayConfig({ workerContext: { limit: 60000 } }).workerContext.limit).toBe(60000);
		expect(readRelayConfig({ workerContext: { limit: "off", whenStuck: "handback" } }).workerContext).toMatchObject({
			limit: "off",
			whenStuck: "handback",
		});
		expect(
			readRelayConfig({ leadContext: { limit: "tier", tierFraction: 0.5, maxCompactions: 0 } }).leadContext,
		).toEqual({
			limit: "tier",
			tierFraction: 0.5,
			maxCompactions: 0,
		});
	});

	it.each([
		[{ workerContext: "x" }, "relay.workerContext"],
		[{ workerContext: { limit: "max" } }, "relay.workerContext.limit"],
		[{ workerContext: { limit: 1.5 } }, "relay.workerContext.limit"],
		[{ workerContext: { limit: 0 } }, "relay.workerContext.limit"],
		[{ workerContext: { tierFraction: 0 } }, "relay.workerContext.tierFraction"],
		[{ workerContext: { tierFraction: 1.2 } }, "relay.workerContext.tierFraction"],
		[{ workerContext: { maxCompactions: -1 } }, "relay.workerContext.maxCompactions"],
		[{ workerContext: { whenStuck: "stop" } }, "relay.workerContext.whenStuck"],
		[{ leadContext: { limit: true } }, "relay.leadContext.limit"],
		[{ leadContext: { tierFraction: "a" } }, "relay.leadContext.tierFraction"],
		[{ leadContext: { maxCompactions: 1.5 } }, "relay.leadContext.maxCompactions"],
	])("rejects %j naming its key", (raw, key) => {
		expect(() => readRelayConfig(raw)).toThrow(key);
	});
});

describe("contextLimitOf", () => {
	const cfg = readRelayConfig({}).workerContext;
	it("takes the fraction of the lowest tier, whatever the order of the list", () => {
		expect(
			contextLimitOf(cfg, "workerContext", priced("m", [tier(300_000), tier(100_000), tier(200_000)]), 20_000),
		).toBe(95_000);
		expect(contextLimitOf({ ...cfg, tierFraction: 0.5 }, "workerContext", priced("m", [tier(100_000)]), 20_000)).toBe(
			50_000,
		);
	});
	it("has no limit without tiers, outside the catalog, or when off", () => {
		expect(contextLimitOf(cfg, "workerContext", priced("m"), 20_000)).toBeUndefined();
		expect(contextLimitOf(cfg, "workerContext", undefined, 20_000)).toBeUndefined();
		expect(
			contextLimitOf({ ...cfg, limit: "off" }, "workerContext", priced("m", [tier(100_000)]), 20_000),
		).toBeUndefined();
	});
	it("takes a number as it is", () => {
		expect(contextLimitOf({ ...cfg, limit: 70_000 }, "workerContext", priced("m"), 20_000)).toBe(70_000);
	});
	it("refuses a limit below keepRecentTokens + 20000, naming its key, also from a small tierFraction", () => {
		expect(() => contextLimitOf({ ...cfg, limit: 39_999 }, "workerContext", undefined, 20_000)).toThrow(
			"relay.workerContext.limit",
		);
		expect(contextLimitOf({ ...cfg, limit: 40_000 }, "workerContext", undefined, 20_000)).toBe(40_000);
		expect(() =>
			contextLimitOf({ ...cfg, tierFraction: 0.3 }, "workerContext", priced("m", [tier(100_000)]), 20_000),
		).toThrow("relay.workerContext.tierFraction");
		expect(() => contextLimitOf({ ...cfg, limit: 50_000 }, "leadContext", undefined, 40_000)).toThrow(
			"relay.leadContext.limit",
		);
	});
});

describe("route() and the limit", () => {
	it("returns the worker's limit in the worker phase and none in the lead phase", () => {
		const { relay, call } = make();
		expect(relay.route(request({ phase: "worker", round: 1 }), call)).toMatchObject({ contextLimit: 95_000 });
		expect(relay.route(request({ phase: "lead", round: 0 }), call).contextLimit).toBeUndefined();
	});

	it("limits the lead only when asked to", () => {
		const { relay, call } = make({ leadContext: { limit: "tier" } });
		expect(relay.route(request({ phase: "lead", round: 0 }), call).contextLimit).toBe(190_000);
		const fixed = make({ leadContext: { limit: 50_000 } });
		expect(fixed.relay.route(request({ phase: "lead", round: 0 }), fixed.call).contextLimit).toBe(50_000);
	});

	it("returns no limit when it is off, or the model has no tiers", () => {
		const off = make({ workerContext: { limit: "off" } });
		expect(off.relay.route(request({ phase: "worker", round: 1 }), off.call).contextLimit).toBeUndefined();
		const flat = make();
		flat.models.set("faux/small", priced("small"));
		expect(flat.relay.route(request({ phase: "worker", round: 1 }), flat.call).contextLimit).toBeUndefined();
	});

	it("ends the request with an error naming the key for a wrong value or a limit too small to compact under", () => {
		const bad = make({ workerContext: { limit: "x" } });
		expect(() => bad.relay.route(request({ phase: "worker", round: 1 }), bad.call)).toThrow(
			"relay.workerContext.limit",
		);
		const small = make({ workerContext: { limit: 30_000 } });
		expect(() => small.relay.route(request({ phase: "worker", round: 1 }), small.call)).toThrow(
			"relay.workerContext.limit",
		);
		// The host supplies keepRecentTokens: a larger value raises the minimum.
		const keep = make({ workerContext: { limit: 50_000 } }, 40_000);
		expect(() => keep.relay.route(request({ phase: "worker", round: 1 }), keep.call)).toThrow(
			"relay.workerContext.limit",
		);
	});

	it("reports a worker limit that is too small in the lead phase too, before any handover", () => {
		const small = make({ workerContext: { limit: 30_000 } });
		expect(() => small.relay.route(request({ phase: "lead", round: 0 }), small.call)).toThrow(
			"relay.workerContext.limit",
		);
		// The default tier limit (95,000 with the faux worker's tier) under a large keepRecentTokens.
		const keep = make({}, 80_000);
		expect(() => keep.relay.route(request({ phase: "lead", round: 0 }), keep.call)).toThrow(
			"relay.workerContext.tierFraction",
		);
		// Off: nothing to report.
		const off = make({ workerContext: { limit: "off" } }, 80_000);
		expect(() => off.relay.route(request({ phase: "lead", round: 0 }), off.call)).not.toThrow();
	});

	it("reads the settings at each request", () => {
		const f = make();
		let settings: Record<string, unknown> = { workerContext: { limit: 60_000 } };
		const relay = createRelay({
			appendEntry: () => {},
			settings: () => ({ lead: "faux/large", worker: "faux/small", ...settings }),
			keepRecentTokens: () => 20_000,
			sendMessage: () => {},
			activeTools: () => [],
			setActiveTools: () => {},
			registerTools: () => {},
		});
		const state = { phase: "worker", round: 1 } as const;
		expect(relay.route(request(state), f.call).contextLimit).toBe(60_000);
		settings = { workerContext: { limit: 80_000 } };
		expect(relay.route(request(state), f.call).contextLimit).toBe(80_000);
	});

	it("passes the direct request through without a limit", () => {
		const { relay, call } = make();
		expect(relay.route({ reason: "direct", messages: [] }, call).contextLimit).toBeUndefined();
	});
});

describe("the stuck guard", () => {
	const worker = { phase: "worker", round: 1 } as const;

	it("counts the summaries under a limit after the latest handover, not the ones before or the ordinary ones", () => {
		const f = make();
		f.summary(95_000);
		f.handover(1);
		f.summary(95_000);
		f.summary(); // an ordinary compaction
		f.summary(95_000);
		expect(limitSummaries(f.entries, "worker")).toBe(2);
		f.handover(2);
		expect(limitSummaries(f.entries, "worker")).toBe(0);
	});

	it("lifts the limit at maxCompactions: route() says so in the state and writes nothing; onRequestStart writes the entry and the notice", () => {
		const f = make();
		f.state(worker);
		f.handover(1);
		for (let i = 0; i < 3; i++) f.summary(95_000);
		const before = f.relay.route(request(worker), f.call);
		expect(before.contextLimit).toBe(95_000);
		expect(before.state).toBe(worker);
		f.summary(95_000);
		const length = f.entries.length;
		const route = f.relay.route(request(worker), f.call);
		expect(route.contextLimit).toBeUndefined();
		expect(route.state).toEqual({ phase: "worker", round: 1, limit: "lifted" });
		expect(f.entries).toHaveLength(length);
		expect(f.notices).toHaveLength(0);
		f.relay.onRequestStart({ previousRouterState: worker, routerState: route.state }, f.call);
		expect(f.entries.at(-1)).toMatchObject({
			customType: LIMIT_ENTRY,
			data: { round: 1, phase: "worker", action: "lifted", compactions: 4 },
		});
		expect(f.notices.at(-1)?.text).toBe("relay: worker compacted 4 times in round 1, limit lifted");
		expect(f.sent).toHaveLength(0);
		// The stored state stays lifted: the next request is not limited, and nothing is written again.
		const next = f.relay.route(request(route.state), f.call);
		expect(next.contextLimit).toBeUndefined();
		expect(next.state).toBe(route.state);
		const written = f.entries.length;
		f.relay.onRequestStart({ previousRouterState: route.state, routerState: next.state }, f.call);
		expect(f.entries).toHaveLength(written);
	});

	it("with whenStuck handback asks the worker to hand back and keeps the limit, then lifts it after two more summaries", () => {
		const f = make({ workerContext: { whenStuck: "handback", maxCompactions: 2 } });
		f.state(worker);
		f.handover(1);
		f.summary(95_000);
		f.summary(95_000);
		const asked = f.relay.route(request(worker), f.call);
		expect(asked.contextLimit).toBe(95_000);
		expect(asked.state).toEqual({ phase: "worker", round: 1, limit: "asked" });
		f.relay.onRequestStart({ previousRouterState: worker, routerState: asked.state }, f.call);
		expect(f.entries.at(-1)).toMatchObject({ customType: LIMIT_ENTRY, data: { action: "handback", compactions: 2 } });
		expect(f.notices.at(-1)?.text).toBe("relay: worker compacted 2 times in round 1, asked to hand back");
		expect(f.sent).toHaveLength(1);
		expect(f.sent[0].deliverAs).toBe("steer");
		expect(f.sent[0].content).toContain('status "blocked"');
		// One more summary: still asked, nothing new.
		f.summary(95_000);
		const still = f.relay.route(request(asked.state), f.call);
		expect(still.state).toBe(asked.state);
		expect(still.contextLimit).toBe(95_000);
		f.summary(95_000);
		const lifted = f.relay.route(request(asked.state), f.call);
		expect(lifted.state).toEqual({ phase: "worker", round: 1, limit: "lifted" });
		expect(lifted.contextLimit).toBeUndefined();
		f.relay.onRequestStart({ previousRouterState: asked.state, routerState: lifted.state }, f.call);
		expect(f.entries.at(-1)).toMatchObject({ customType: LIMIT_ENTRY, data: { action: "lifted", compactions: 4 } });
		expect(f.sent).toHaveLength(1);
	});

	it("is off with maxCompactions 0", () => {
		const f = make({ workerContext: { maxCompactions: 0 } });
		f.state(worker);
		f.handover(1);
		for (let i = 0; i < 9; i++) f.summary(95_000);
		const route = f.relay.route(request(worker), f.call);
		expect(route.contextLimit).toBe(95_000);
		expect(route.state).toBe(worker);
	});

	it("does not guard a phase without a limit", () => {
		const f = make({ workerContext: { limit: "off" } });
		f.state(worker);
		f.handover(1);
		for (let i = 0; i < 9; i++) f.summary(95_000);
		expect(f.relay.route(request(worker), f.call).state).toBe(worker);
	});

	it("reads a state without the field as limited, and a new handover starts without it", () => {
		const f = make();
		f.state(worker);
		f.handover(1);
		for (let i = 0; i < 4; i++) f.summary(95_000);
		const lifted = f.relay.route(request(worker), f.call).state as RelayState;
		expect(lifted.limit).toBe("lifted");
		// The lead hands back and hands over again: the new round's state has no limit and the count is zero.
		f.handover(2);
		const messages = [
			{ role: "assistant", content: [{ type: "toolCall", id: "c", name: "codemode", arguments: {} }] },
			{
				role: "toolResult",
				toolCallId: "c",
				toolName: "handover",
				isError: false,
				content: [{ type: "text", text: "ok" }],
				signal: { type: "relay.handover", data: { round: 2 } },
			},
		];
		const lead = { phase: "lead", round: 1 } as const;
		const route = f.relay.route({ reason: "continuation", state: lead, messages: messages as never }, f.call);
		expect(route.state).toEqual({ phase: "worker", round: 2 });
		expect(route.contextLimit).toBe(95_000);
	});

	it("guards the lead from the start of the branch before the first handover, and always lifts", () => {
		const f = make({ leadContext: { limit: 50_000, maxCompactions: 2 }, workerContext: { whenStuck: "handback" } });
		const lead = { phase: "lead", round: 0 } as const;
		f.state(lead);
		f.summary(50_000);
		expect(f.relay.route(request(lead), f.call).contextLimit).toBe(50_000);
		f.summary(50_000);
		const route = f.relay.route(request(lead), f.call);
		expect(route.state).toEqual({ phase: "lead", round: 0, limit: "lifted" });
		expect(route.contextLimit).toBeUndefined();
		f.relay.onRequestStart({ previousRouterState: lead, routerState: route.state }, f.call);
		expect(f.entries.at(-1)).toMatchObject({
			customType: LIMIT_ENTRY,
			data: { action: "lifted", phase: "lead", compactions: 2 },
		});
		expect(f.notices.at(-1)?.text).toBe("relay: lead compacted 2 times in round 0, limit lifted");
		expect(f.sent).toHaveLength(0);
	});

	it("counts the lead's summaries from the latest hand back, not the worker's", () => {
		const f = make({ leadContext: { limit: 50_000, maxCompactions: 2 } });
		f.handover(1);
		f.summary(95_000);
		f.summary(95_000);
		f.record(1);
		f.summary(50_000);
		expect(limitSummaries(f.entries, "lead")).toBe(1);
		const lead = { phase: "lead", round: 1 } as const;
		expect(f.relay.route(request(lead), f.call).contextLimit).toBe(50_000);
	});
});

describe("the record and the prompts", () => {
	it("skips the worker's limit summaries when it picks the lead's earlier summary, and keeps the lead's own", () => {
		const f = make();
		f.summary(); // ordinary, before the handover: the lead's
		f.handover(1);
		f.summary(95_000); // the worker's working memory
		expect(readPhase(f.entries).earlierSummary).toBe("s");
		const g = make();
		g.handover(1);
		g.summary(95_000);
		expect(readPhase(g.entries).earlierSummary).toBeUndefined();
		g.record(1);
		g.custom("relay.round", { round: 1, line: "r" });
		g.summary(50_000); // the lead's own limit, after the hand back
		expect(readPhase(g.entries).earlierSummary).toBe("s");
	});

	it("words the worker's section so that it still points at the handover after a summary", () => {
		const f = make();
		f.state({ phase: "worker", round: 1 });
		f.handover(1);
		const text = f.relay.section(f.call)?.text ?? "";
		expect(text).toContain(
			"the handover (a tool result that contains `Handed over to the worker model (round 1)`, or its mention in a summary of this conversation)",
		);
	});

	it("tells the lead the tier, the limit in force and what happens when stuck", () => {
		const f = make();
		f.state({ phase: "lead", round: 0 });
		const text = f.relay.section(f.call)?.text ?? "";
		expect(text).toContain("first price tier starts above 100,000 prompt tokens");
		expect(text).toContain("its input tokens cost 5 times as much there");
		expect(text).toContain("starts again after a hand back");
		expect(text).toContain("Worker context limit: 95,000 tokens; after 4 compactions in a round it is lifted");
		expect(text).not.toContain("Your own context limit");
		const asked = make({ workerContext: { whenStuck: "handback" }, leadContext: { limit: 60_000 } });
		asked.state({ phase: "lead", round: 0 });
		const other = asked.relay.section(asked.call)?.text ?? "";
		expect(other).toContain("the worker is asked to hand back, and after two more compactions it is lifted");
		expect(other).toContain("Your own context limit: 60,000 tokens");
		const off = make({ workerContext: { limit: "off" } });
		off.state({ phase: "lead", round: 0 });
		expect(off.relay.section(off.call)?.text).toContain("Worker context limit: none");
	});

	it("reports the round's peak, summaries and the lift in the review message and in the record", async () => {
		const f = make({ workerContext: { maxCompactions: 2 } });
		f.state({ phase: "worker", round: 1 });
		f.handover(1);
		const usage = (input: number, cacheRead: number) => ({
			input,
			cacheRead,
			cacheWrite: 0,
			output: 10,
			cost: { total: 0 },
		});
		f.message({
			role: "assistant",
			content: [{ type: "toolCall", id: "c", name: "read", arguments: {} }],
			usage: usage(1_000, 60_000),
			provider: "faux",
			model: "small",
		});
		f.summary(95_000);
		f.message({
			role: "assistant",
			content: [{ type: "text", text: "x" }],
			usage: usage(2_000, 90_000),
			provider: "faux",
			model: "small",
		});
		f.summary(95_000);
		f.custom(LIMIT_ENTRY, { round: 1, phase: "worker", action: "lifted", compactions: 2 });
		f.custom(HANDBACK_ENTRY, { status: "done", report: "all done" });
		f.message({ role: "assistant", content: [{ type: "text", text: "finished" }] });
		expect(roundContext(f.entries)).toEqual({ peak: 92_000, summaries: 2, action: "lifted" });
		const result = await f.relay.beforeSettle({ outcome: "completed", contextMessages: [] }, f.call);
		const line =
			"The worker's context peaked at 92,000 prompt tokens (limit 95,000); 2 summaries were written under the limit; the limit was lifted.";
		const record = result?.entries.find((draft) => draft.type === "compaction");
		expect(record?.type === "compaction" && record.summary).toContain(`## Worker context\n${line}`);
		const review = result?.entries.find(
			(draft) => draft.type === "custom_message" && draft.customType === "relay.review",
		);
		expect(review?.type === "custom_message" && review.content).toContain(line);
	});

	it("leaves the line out when nothing is known about the round's context", async () => {
		const f = make({ workerContext: { limit: "off" } });
		f.state({ phase: "worker", round: 1 });
		f.handover(1);
		f.custom(HANDBACK_ENTRY, { status: "done", report: "r" });
		f.message({ role: "assistant", content: [{ type: "text", text: "finished" }] });
		const result = await f.relay.beforeSettle({ outcome: "completed", contextMessages: [] }, f.call);
		const record = result?.entries.find((draft) => draft.type === "compaction");
		expect(record?.type === "compaction" && record.summary).not.toContain("Worker context");
	});
});

describe("the limit_reached row", () => {
	it("asks the worker to hand back, or lifts the limit; the lead is only ever lifted", () => {
		const view = (phase: "lead" | "worker") => initialView({ phase, round: 2 });
		const asked = transition(
			view("worker"),
			{ type: "limit_reached", compactions: 4, to: "asked" },
			{ maxRounds: 3 },
		);
		expect(asked.next.limit).toBe("asked");
		expect(asked.effects.map((effect) => effect.type)).toEqual(["append_entry", "notify", "steer"]);
		const lifted = transition(
			view("worker"),
			{ type: "limit_reached", compactions: 6, to: "lifted" },
			{ maxRounds: 3 },
		);
		expect(lifted.next.limit).toBe("lifted");
		expect(lifted.effects.map((effect) => effect.type)).toEqual(["append_entry", "notify"]);
		const lead = transition(view("lead"), { type: "limit_reached", compactions: 4, to: "asked" }, { maxRounds: 3 });
		expect(lead.next.limit).toBe("lifted");
		expect(lead.effects.some((effect) => effect.type === "steer")).toBe(false);
	});

	it("does not steer when the user already asked for a hand back with /handback", () => {
		const f = make({ workerContext: { whenStuck: "handback", maxCompactions: 1 } });
		const worker = { phase: "worker", round: 1 } as const;
		f.handover(1);
		f.state(worker);
		f.summary(95_000);
		f.relay.commands.handback(f.call);
		const sentBefore = f.sent.length;
		const asked = f.relay.route(request(worker), f.call);
		f.relay.onRequestStart({ previousRouterState: worker, routerState: asked.state }, f.call);
		expect(f.entries.at(-1)).toMatchObject({ customType: LIMIT_ENTRY, data: { action: "handback" } });
		expect(f.sent).toHaveLength(sentBefore);
	});
});
