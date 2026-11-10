import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentTool } from "xpi-agent-core";
import { type Context, type FauxResponseStep, fauxAssistantMessage, fauxToolCall, type Message } from "xpi-ai";
import type { Settings } from "../../src/core/settings-manager.ts";
import { readRelayConfig } from "../../src/extensions/relay/config.ts";
import { leadFacts, objectiveFact, priceFact, roundTimeFact } from "../../src/extensions/relay/facts.ts";
import relayExtension, { RELAY_MODEL, RELAY_PROVIDER } from "../../src/extensions/relay/index.ts";
import { renderConversation } from "../../src/extensions/relay/record.ts";
import { nextState, RECORD_MARKER, USER_HANDOVER_MARKER } from "../../src/extensions/relay/router.ts";
import { createHarness, type Harness } from "./harness.ts";

const echoTool: AgentTool = {
	name: "echo",
	label: "Echo",
	description: "Echo text back",
	parameters: Type.Object({ text: Type.String() }),
	execute: async (_id, params) => ({
		content: [{ type: "text", text: `echoed ${(params as { text: string }).text}` }],
		details: {},
	}),
};

function textOf(context: Context): string {
	return context.messages
		.map((message) => {
			if (message.role === "assistant") {
				return message.content
					.map((block) =>
						block.type === "text" ? block.text : block.type === "toolCall" ? JSON.stringify(block.arguments) : "",
					)
					.join("\n");
			}
			if (typeof message.content === "string") return message.content;
			return message.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
		})
		.join("\n");
}

describe("relay", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	async function createRelayHarness(relay: Record<string, unknown> = {}) {
		const harness = await createHarness({
			models: [
				{ id: "small", contextWindow: 50_000 },
				{ id: "large", contextWindow: 50_000, maxTokens: 4000, reasoning: true },
			],
			tools: [echoTool],
			settings: { relay: { lead: "faux/large", worker: "faux/small", ...relay } } as Partial<Settings>,
			extensionFactories: [relayExtension],
		});
		harnesses.push(harness);
		const runtime = harness.session.modelRuntime;
		harness.session.agent.streamFunction = (model, context, options) => runtime.streamSimple(model, context, options);
		await harness.session.setModel(runtime.getModel(RELAY_PROVIDER, RELAY_MODEL)!);
		/** What each request saw, and which model got it. */
		const seen: { model: string; text: string }[] = [];
		const system: string[] = [];
		const reply =
			(message: ReturnType<typeof fauxAssistantMessage>): FauxResponseStep =>
			(context, _options, _state, model) => {
				seen.push({ model: model.id, text: textOf(context) });
				system.push(
					context.messages.flatMap((m) => ((m.role as string) === "system" ? [JSON.stringify(m)] : [])).join("\n"),
				);
				return message;
			};
		const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
			reply(fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" }));
		const say = (text: string) => reply(fauxAssistantMessage(text));
		return { harness, seen, system, call, say };
	}

	it("puts the two tools in the tool list only while the relay model is selected", async () => {
		const { harness } = await createRelayHarness();
		expect(harness.session.getActiveToolNames()).toEqual(expect.arrayContaining(["handover", "handback"]));
		await harness.session.setModel(harness.getModel("large")!);
		expect(harness.session.getActiveToolNames()).not.toContain("handover");
		expect(harness.session.getActiveToolNames()).not.toContain("handback");
		expect(harness.session.getActiveToolNames()).toContain("echo");
	});

	it("hands over to the worker and gives the lead a record in place of the worker's transcript", async () => {
		const { harness, seen, system, call, say } = await createRelayHarness();
		harness.setResponses([
			say("I looked around. LEAD-EARLIER-REPLY"),
			call("handover", {
				plan: "PLAN-STEP-ONE then PLAN-STEP-TWO",
				acceptance: ["true"],
				criteria: "CRITERIA-TEXT",
				findings: "FINDINGS-TEXT",
			}),
			call("echo", { text: "WORKER-NOISE" }),
			call("handback", { status: "done", report: "WORKER-REPORT-TEXT" }),
			say("The work is fine."),
		]);

		await harness.session.prompt("USER-FIRST-MESSAGE");
		await harness.session.prompt("USER-SECOND-MESSAGE please build it");

		expect(seen.map((request) => request.model)).toEqual(["large", "large", "small", "small", "large"]);
		expect(system[0]).toContain("Relay objective:");
		expect(system[0]).toContain("Relay prices:");
		// The worker reads the whole conversation and the brief.
		expect(seen[2].text).toContain("LEAD-EARLIER-REPLY");
		expect(seen[2].text).toContain("You are the worker");
		// The lead reads the record: its own note and replies, the user's words, the report, the acceptance result.
		const review = seen[4].text;
		expect(review).toContain(RECORD_MARKER);
		for (const kept of [
			"USER-FIRST-MESSAGE",
			"USER-SECOND-MESSAGE",
			"LEAD-EARLIER-REPLY",
			"PLAN-STEP-ONE then PLAN-STEP-TWO",
			"CRITERIA-TEXT",
			"FINDINGS-TEXT",
			"WORKER-REPORT-TEXT",
			"`true`: passed (exit 0)",
			"You are the lead again",
			"Used so far in this session:",
		]) {
			expect(review).toContain(kept);
		}
		expect(review).not.toContain("WORKER-NOISE");
		expect(review).not.toContain("You are the worker");
		// The next user message goes to the lead.
		harness.appendResponses([say("Anything else?")]);
		await harness.session.prompt("thanks");
		expect(seen.at(-1)?.model).toBe("large");
		expect(seen.at(-1)?.text).not.toContain("WORKER-NOISE");
	});

	it("sends failed acceptance output to the worker, and wakes the lead when the rounds are used up", async () => {
		const { harness, seen, call, say } = await createRelayHarness({ maxRounds: 1 });
		harness.setResponses([
			call("handover", { plan: "make it pass", acceptance: ["echo ACCEPT-OUTPUT; exit 3"] }),
			call("handback", { status: "done", report: "FIRST-REPORT" }),
			say("SECOND-TRY-TEXT"),
			say("It still fails; I will look myself."),
		]);

		await harness.session.prompt("build it");

		expect(seen.map((request) => request.model)).toEqual(["large", "small", "small", "large"]);
		expect(seen[2].text).toContain("did not all pass (attempt 1 of 1)");
		expect(seen[2].text).toContain("ACCEPT-OUTPUT");
		const review = seen[3].text;
		// The worker ended without a second handback: its last message is the report.
		expect(review).toContain("SECOND-TRY-TEXT");
		expect(review).not.toContain("FIRST-REPORT");
		expect(review).toContain("failed (exit 3)");
		expect(review).toContain("failed 1 time(s) before this run");
	});

	it("does not run the acceptance commands when the worker is blocked", async () => {
		const { harness, seen, call, say } = await createRelayHarness();
		harness.setResponses([
			call("handover", { plan: "do it", acceptance: ["exit 9"] }),
			call("handback", { status: "blocked", report: "THE-PLAN-DOES-NOT-FIT" }),
			say("I will rethink."),
		]);

		await harness.session.prompt("build it");

		expect(seen.map((request) => request.model)).toEqual(["large", "small", "large"]);
		expect(seen[2].text).toContain("status: blocked");
		expect(seen[2].text).toContain("THE-PLAN-DOES-NOT-FIT");
		expect(seen[2].text).toContain("Not run: the worker handed back before it was done.");
	});

	it("refuses a handback from the lead and a handover from the worker", async () => {
		const { harness, seen, call, say } = await createRelayHarness();
		harness.setResponses([
			call("handback", { status: "done", report: "x" }),
			call("handover", { plan: "do it" }),
			call("handover", { plan: "pass it on" }),
			say("worker done"),
			say("ok"),
		]);

		await harness.session.prompt("go");

		expect(seen.map((request) => request.model)).toEqual(["large", "large", "small", "small", "large"]);
		expect(seen[1].text).toContain("Only the worker hands back");
		expect(seen[3].text).toContain("Only the lead hands over");
		// A second round starts from the record and counts on.
		harness.appendResponses([call("handover", { plan: "ROUND-TWO-PLAN" }), say("worker again"), say("fine")]);
		await harness.session.prompt("one more thing");
		expect(seen.slice(5).map((request) => request.model)).toEqual(["large", "small", "large"]);
		expect(seen.at(-1)?.text).toContain('round="2"');
		expect(seen.at(-1)?.text).toContain("Round 1: do it (done)");
		expect(seen.at(-1)?.text).toContain("ROUND-TWO-PLAN");
	});

	describe("nextState", () => {
		const user = (text: string): Message => ({ role: "user", content: text, timestamp: 0 });
		const answer = fauxAssistantMessage("answer") as Message;
		const handoverResult: Message = {
			role: "toolResult",
			toolCallId: "1",
			toolName: "handover",
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: 0,
		};

		it("starts with the lead and changes phase once per handover and hand back", () => {
			expect(nextState(undefined, [user("hi")])).toEqual({ phase: "lead", round: 0 });
			const lead = { phase: "lead" as const, round: 0 };
			expect(nextState(lead, [user("hi"), answer, handoverResult])).toEqual({ phase: "worker", round: 1 });
			expect(nextState(lead, [user("hi"), answer, { ...handoverResult, isError: true }])).toBe(lead);
			expect(nextState(lead, [user(`${USER_HANDOVER_MARKER} go`)])).toEqual({ phase: "worker", round: 1 });
			const worker = { phase: "worker" as const, round: 1 };
			expect(nextState(worker, [user("hi"), answer, handoverResult])).toBe(worker);
			expect(nextState(worker, [user(`${RECORD_MARKER} round="1">`), user("review")])).toEqual({
				phase: "lead",
				round: 1,
			});
		});

		it("keeps the worker when its first request is retried after an earlier hand back", () => {
			// The failed response is gone, so the previous record is in front of the new handover.
			const worker = { phase: "worker" as const, round: 2 };
			const messages = [user(`${RECORD_MARKER} round="1">`), user(`${USER_HANDOVER_MARKER} again`)];
			expect(nextState(worker, messages)).toBe(worker);
		});
	});

	it("reads the settings block and names the wrong key", () => {
		expect(readRelayConfig(undefined)).toMatchObject({
			lead: "anthropic/claude-opus-5-5",
			worker: "anthropic/claude-haiku-5-5",
			maxRounds: 3,
			leadThinking: { plan: "high", review: "medium" },
		});
		expect(() => readRelayConfig({ lead: "opus" })).toThrow(/relay\.lead must be "provider\/model"/);
		expect(() => readRelayConfig({ maxRounds: -1 })).toThrow(/relay\.maxRounds/);
		expect(() => readRelayConfig({ leadThinking: { plan: "huge" } })).toThrow(/relay\.leadThinking\.plan/);
	});

	it("tells the lead the objective, the prices and what a handover does, and no rule about when", () => {
		type Tier = { inputTokensAbove: number; input: number; output: number; cacheRead: number; cacheWrite: number };
		const price = (input: number, output: number, tiers?: Tier[]) => ({
			cost: { input, output, cacheRead: input / 10, cacheWrite: input * 1.25, ...(tiers ? { tiers } : {}) },
		});
		const opus = price(4, 20);
		const haiku = price(0.1, 0.5, [
			{ inputTokensAbove: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 },
		]);
		const fact = priceFact(opus, haiku);
		expect(fact).toContain("You: input $4, cached input $0.4, cache write $5, output $20.");
		expect(fact).toContain(
			"The worker: input $0.1, cached input $0.01, cache write $0.125, output $0.5; with more than 100,000 prompt tokens: input $0.5,",
		);
		expect(fact).toContain(
			"one of your input tokens costs 40 times a worker input token, one of your output tokens 40 times",
		);
		expect(priceFact(price(3, 15), price(1.2, 5))).toContain("costs 2.5 times");
		expect(priceFact(price(15, 75), price(0, 0))).toBeUndefined();
		expect(priceFact(undefined, price(1, 5))).toBeUndefined();
		const facts = leadFacts(
			readRelayConfig({ workerRecord: "RECORD-TEXT", maxRounds: 2 }),
			price(15, 75),
			price(1, 5),
		).join("\n");
		for (const part of [
			"Whether and when to call handover is your decision",
			"Relay objective: the user wants a correct result for as few of your (lead) tokens as possible",
			"costs 15 times",
			"Time with handover:",
			"at most 2 time(s)",
			"Not kept: the worker's own steps",
			"RECORD-TEXT",
		]) {
			expect(facts).toContain(part);
		}
		expect(leadFacts(readRelayConfig(undefined), undefined, undefined).join("\n")).toContain(
			"Relay prices: not known",
		);
		expect(() => readRelayConfig({ objective: " " })).toThrow(/relay\.objective/);
		// Time enters the objective only as a price the user sets.
		expect(objectiveFact(readRelayConfig(undefined))).not.toContain("minute");
		expect(objectiveFact(readRelayConfig({ minuteCost: 0.5 }))).toContain(
			"one minute of wall-clock time is worth $0.5 of tokens",
		);
		expect(() => readRelayConfig({ minuteCost: -1 })).toThrow(/relay\.minuteCost/);
		expect(roundTimeFact(2, 1000, 40_000, 426_000)).toBe(
			"Round 2 took 7m05s from the handover to this hand back, 40s of it in the acceptance commands.",
		);
	});

	it("drops the oldest lead replies first when the conversation is too long", () => {
		const long = "x".repeat(2900);
		const conversation = [
			{ who: "user" as const, text: "USER-KEPT" },
			...Array.from({ length: 20 }, (_, index) => ({ who: "lead" as const, text: `LEAD-${index} ${long}` })),
		];
		const text = renderConversation(conversation);
		expect(text).toContain("USER-KEPT");
		expect(text).toContain("LEAD-19");
		expect(text).not.toContain("LEAD-0 ");
		expect(text).toMatch(/\[\d+ earlier lead replies removed for length\]/);
	});
});
