import { describe, expect, it } from "vitest";
import type { Api, Model } from "xpi-ai";
import {
	createRelay,
	leadRefreshes,
	RELAY_MODEL,
	RELAY_PROVIDER,
	type RelayCall,
	type RelayEntry,
	type RelayHost,
	readRelayConfig,
} from "../src/index.ts";

const model = (id: string) =>
	({ id, contextWindow: 1_000_000, cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } }) as Model<Api>;

function make(settings: Record<string, unknown> = {}, entries: RelayEntry[] = []) {
	const host: RelayHost = {
		appendEntry: () => {},
		settings: () => ({ lead: "faux/large", worker: "faux/small", ...settings }),
		keepRecentTokens: () => 20_000,
		sendMessage: () => {},
		activeTools: () => [],
		setActiveTools: () => {},
		registerTools: () => {},
	};
	const models = new Map<string, Model<Api>>([
		["faux/large", model("large")],
		["faux/small", model("small")],
	]);
	const call: RelayCall = {
		entries,
		model: { provider: RELAY_PROVIDER, id: RELAY_MODEL },
		cwd: ".",
		signal: undefined,
		findModel: (ref) => models.get(ref),
		notify: () => {},
		isIdle: () => true,
	};
	const route = (phase: "lead" | "worker", reason: "continuation" | "direct" = "continuation") =>
		createRelay(host).route({ reason, state: { phase, round: phase === "lead" ? 0 : 1 }, messages: [] }, call);
	return { relay: createRelay(host), call, route };
}

describe("relay.warmLead", () => {
	it("is on by default", () => {
		expect(readRelayConfig({}).warmLead).toBe(true);
		expect(readRelayConfig({ warmLead: false }).warmLead).toBe(false);
	});

	it("names its key when it is not a boolean", () => {
		for (const bad of ["yes", 1, null, {}]) {
			expect(() => readRelayConfig({ warmLead: bad })).toThrow("relay.warmLead");
		}
	});
});

describe("route() cache labels", () => {
	it("labels the lead phase and holds the lead's prefix in the worker phase", () => {
		const { route } = make();
		expect(route("lead").cache).toEqual({ key: "lead" });
		expect(route("worker").cache).toEqual({ key: "worker", holdPrefix: "lead" });
	});

	it("holds nothing with warmLead off", () => {
		const { route } = make({ warmLead: false });
		expect(route("lead").cache).toEqual({ key: "lead" });
		expect(route("worker").cache).toEqual({ key: "worker" });
	});

	it("gives a direct request no label, and does not change a state by asking", () => {
		const { route } = make();
		expect(route("worker", "direct").cache).toBeUndefined();
		expect(route("lead").state).toEqual({ phase: "lead", round: 0 });
	});

	it("throws for a wrong setting when routing", () => {
		const { route } = make({ warmLead: "yes" });
		expect(() => route("lead")).toThrow("relay.warmLead");
	});
});

describe("leadRefreshes", () => {
	const usage = (note: string | undefined, total: number, kind = "cache_warm"): RelayEntry => ({
		id: "u",
		timestamp: "",
		type: "usage",
		kind,
		...(note ? { note } : {}),
		usage: { cost: { total } },
	});

	it("counts the refreshes of the lead's prefix and what they cost", () => {
		const entries = [
			usage("held prefix: lead", 0.001),
			usage("held prefix: lead", 0.002),
			usage("held prefix: worker", 5),
			usage("extension override", 5),
			usage(undefined, 5),
			usage("held prefix: lead", 5, "other"),
		];
		const { count, cost } = leadRefreshes(entries);
		expect(count).toBe(2);
		expect(cost).toBeCloseTo(0.003);
	});

	it("shows in /relay status", () => {
		const { relay, call } = make({}, [usage("held prefix: lead", 0.0012)]);
		expect(relay.commands.status(call).text).toContain("1 refresh, $0.0012");
		expect(make({ warmLead: false }).relay.commands.status(make().call).text).toContain("not kept warm");
	});
});
