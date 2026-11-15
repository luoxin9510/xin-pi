import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentTool } from "xpi-agent-core";
import {
	type Context,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxToolCall,
	type Message,
	type ToolResultSignal,
} from "xpi-ai";
import {
	handoverMarker,
	leadFacts,
	nextState,
	objectiveFact,
	priceFact,
	RECORD_MARKER,
	readRelayConfig,
	renderConversation,
	roundTimeFact,
	USER_HANDOVER_MARKER,
} from "xpi-relay";
import type { Settings } from "../../src/core/settings-manager.ts";
import { createCodemodeExtension } from "../../src/extensions/codemode/index.ts";
import relayExtension, { RELAY_MODEL, RELAY_PROVIDER } from "../../src/extensions/relay/index.ts";
import { createHarness, createTestUiContext, type Harness } from "./harness.ts";

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

	/**
	 * `codemode`: the codemode extension is on, so the hand tools are callable from scripts only; without it they fall
	 * back to direct tools.
	 */
	async function createRelayHarness(options: { codemode?: boolean; relay?: Record<string, unknown> } = {}) {
		const harness = await createHarness({
			models: [
				{ id: "small", contextWindow: 50_000 },
				{ id: "large", contextWindow: 50_000, maxTokens: 4000, reasoning: true },
			],
			tools: [echoTool],
			...(options.codemode ? { initialActiveToolNames: ["echo", "codemode"] } : {}),
			settings: { relay: { lead: "faux/large", worker: "faux/small", ...options.relay } } as Partial<Settings>,
			extensionFactories: options.codemode ? [createCodemodeExtension(), relayExtension] : [relayExtension],
		});
		harnesses.push(harness);
		const runtime = harness.session.modelRuntime;
		harness.session.agent.streamFunction = (model, context, options) => runtime.streamSimple(model, context, options);
		/** What the user was told. */
		const notes: string[] = [];
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({ notify: (message) => notes.push(message) }),
		});
		await harness.session.setModel(runtime.getModel(RELAY_PROVIDER, RELAY_MODEL)!);
		/** What each request saw, and which model got it. */
		const seen: { model: string; text: string }[] = [];
		const system: string[] = [];
		const reply =
			(message: ReturnType<typeof fauxAssistantMessage>): FauxResponseStep =>
			(context, _options, _state, model) => {
				seen.push({ model: model.id, text: textOf(context) });
				system.push(
					context.messages
						.flatMap((m) =>
							m.role === "system"
								? [
										typeof m.content === "string"
											? m.content
											: m.content.map((block) => block.text).join("\n"),
										...Object.values(m.sections ?? {}).flatMap((section) =>
											section === null ? [] : [section],
										),
									]
								: [],
						)
						.join("\n"),
				);
				return message;
			};
		const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
			reply(fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" }));
		/** A codemode script. */
		const script = (code: string) => call("codemode", { code });
		/** Several codemode calls in one response. */
		const parallel = (...codes: string[]) =>
			reply(
				fauxAssistantMessage(
					codes.map((code) => fauxToolCall("codemode", { code })),
					{ stopReason: "toolUse" },
				),
			);
		const say = (text: string) => reply(fauxAssistantMessage(text));
		/** A response that ends the run as an abort, as Esc does. */
		const abort = () => reply(fauxAssistantMessage("(interrupted)", { stopReason: "aborted" }));
		const entries = (customType: string) =>
			harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === customType)
				.map((entry) => (entry as { data?: unknown }).data);
		return { harness, seen, system, notes, call, script, parallel, say, abort, entries };
	}

	const HAND_OVER = `await tools.handover({ plan: "PLAN-STEP-ONE then PLAN-STEP-TWO", acceptance: ["true"], criteria: "CRITERIA-TEXT", findings: "FINDINGS-TEXT" });`;

	it("puts the hand tools in the tool list only in the direct fallback, and only while the relay model is selected", async () => {
		const { harness } = await createRelayHarness();
		// Without codemode the tools are direct tools: declared while the relay model is selected (the first run switches).
		harness.setResponses([fauxAssistantMessage("hi")]);
		await harness.session.prompt("hello");
		expect(harness.session.getActiveToolNames()).toEqual(expect.arrayContaining(["handover", "handback"]));
		await harness.session.setModel(harness.getModel("large")!);
		expect(harness.session.getActiveToolNames()).not.toContain("handover");
		expect(harness.session.getActiveToolNames()).not.toContain("handback");
		expect(harness.session.getActiveToolNames()).toContain("echo");

		// With codemode they are never declared, only callable: from scripts, whatever model is selected.
		const withCodemode = await createRelayHarness({ codemode: true });
		withCodemode.harness.setResponses([fauxAssistantMessage("hi")]);
		await withCodemode.harness.session.prompt("hello");
		expect(withCodemode.harness.session.getActiveToolNames()).not.toContain("handover");
		expect(withCodemode.harness.session.getActiveToolNames()).not.toContain("handback");
		expect(withCodemode.harness.session.getCallableToolNames()).toEqual(
			expect.arrayContaining(["handover", "handback"]),
		);
		const codemodeDescription =
			withCodemode.harness.session.agent.state.tools.find((tool) => tool.name === "codemode")?.description ?? "";
		expect(codemodeDescription).not.toMatch(/handover|handback/);
	});

	it("hands over and back from codemode scripts, and the lead reads a record in place of the worker's transcript", async () => {
		const { harness, seen, system, notes, call, script, say, entries } = await createRelayHarness({ codemode: true });
		harness.setResponses([
			say("I looked around. LEAD-EARLIER-REPLY"),
			script(HAND_OVER),
			call("echo", { text: "WORKER-NOISE" }),
			script(`await tools.handback({ status: "done", report: "WORKER-REPORT-TEXT" });`),
			say("The work is fine."),
		]);

		await harness.session.prompt("USER-FIRST-MESSAGE");
		await harness.session.prompt("USER-SECOND-MESSAGE please build it");

		expect(seen.map((request) => request.model)).toEqual(["large", "large", "small", "small", "large"]);
		// The lead's section: its role, the hand tool it may call and the decision facts. Not the worker's tool.
		expect(system[0]).toContain('<relay role="lead">');
		expect(system[0]).toContain("tools.handover({...}) from codemode");
		expect(system[0]).toContain("Relay objective:");
		expect(system[0]).toContain("Relay prices:");
		expect(system[0]).not.toContain("tools.handback");
		// The worker's section: its role, its tool, the handover it was given. Not the lead's tool, and no facts.
		expect(system[2]).toContain('<relay role="worker">');
		expect(system[2]).toContain("tools.handback({...}) from codemode");
		for (const given of ["PLAN-STEP-ONE then PLAN-STEP-TWO", "CRITERIA-TEXT", "FINDINGS-TEXT", "`true`"]) {
			expect(system[2]).toContain(given);
		}
		expect(system[2]).not.toContain("tools.handover");
		expect(system[2]).not.toContain("Relay prices:");
		// The worker's section names the handover by its result sentence, not by a marker line.
		expect(system[2]).toContain(
			"The assistant messages before the tool result that says `Handed over to the worker model (round 1)` were written by the lead",
		);
		expect(system[2]).not.toContain("<relay-handover round");
		// The worker reads the whole conversation, which holds that result sentence and no marker; nothing tells it its role.
		expect(seen[2].text).toContain("LEAD-EARLIER-REPLY");
		expect(seen[2].text).toContain("Handed over to the worker model (round 1)");
		expect(seen[2].text).not.toContain("<relay-handover round");
		expect(seen[2].text).not.toContain("You are the worker");
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
		expect(system[4]).toContain('<relay role="lead">');
		// Both phase changes are entries on the branch and lines for the user.
		expect(entries("relay.transition")).toMatchObject([
			{ from: "lead", to: "worker", event: "handover", round: 1 },
			{ from: "worker", to: "lead", event: "handback", round: 1 },
		]);
		expect(notes).toContain("relay: lead → worker (round 1)");
		expect(notes).toContain("relay: worker → lead (round 1)");
		// The next user message goes to the lead.
		harness.appendResponses([say("Anything else?")]);
		await harness.session.prompt("thanks");
		expect(seen.at(-1)?.model).toBe("large");
		expect(seen.at(-1)?.text).not.toContain("WORKER-NOISE");
	});

	it("falls back to direct hand tools when codemode is off, says so, and names the tools without tools.", async () => {
		const { harness, seen, system, notes, call, say } = await createRelayHarness();
		harness.setResponses([
			say("I looked around. LEAD-EARLIER-REPLY"),
			call("handover", { plan: "PLAN-ONE", acceptance: ["true"] }),
			call("echo", { text: "WORKER-NOISE" }),
			call("handback", { status: "done", report: "WORKER-REPORT-TEXT" }),
			say("The work is fine."),
			say("Done."),
		]);

		await harness.session.prompt("USER-FIRST-MESSAGE");
		await harness.session.prompt("USER-SECOND-MESSAGE");

		expect(seen.map((request) => request.model)).toEqual(["large", "large", "small", "small", "large"]);
		expect(system[0]).toContain("call handover({...}).");
		expect(system[0]).not.toContain("tools.handover");
		expect(system[2]).toContain("call handback({...}).");
		// Direct calls are what the fallback expects: no repair line, no entry.
		expect(seen[2].text).not.toContain("from codemode next time");
		expect(seen[2].text).toContain("Handed over to the worker model (round 1)");
		expect(seen[4].text).toContain("WORKER-REPORT-TEXT");
		await harness.session.prompt("/relay");
		expect(notes.at(-1)).toContain("codemode is off: the hand tools are direct tools");
	});

	it("sends failed acceptance output to the worker, and wakes the lead when the rounds are used up", async () => {
		const { harness, seen, call, say } = await createRelayHarness({ relay: { maxRounds: 1 } });
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
		const { harness, seen, script, say } = await createRelayHarness({ codemode: true });
		harness.setResponses([
			script(`await tools.handover({ plan: "do it", acceptance: ["exit 9"] });`),
			script(`await tools.handback({ status: "blocked", report: "THE-PLAN-DOES-NOT-FIT" });`),
			say("I will rethink."),
		]);

		await harness.session.prompt("build it");

		expect(seen.map((request) => request.model)).toEqual(["large", "small", "large"]);
		expect(seen[2].text).toContain("status: blocked");
		expect(seen[2].text).toContain("THE-PLAN-DOES-NOT-FIT");
		expect(seen[2].text).toContain("Not run: the worker handed back before it was done.");
	});

	it("corrects a hand tool of the other role; a second mix-up by the worker hands back as blocked", async () => {
		const { harness, seen, notes, entries, script, say, call } = await createRelayHarness({ codemode: true });
		harness.setResponses([
			// The lead calls the worker's tool: an error, then it answers the user.
			script(`await tools.handback({ status: "done", report: "x" });`),
			script(`await tools.handover({ plan: "do it" });`),
			// The worker calls the lead's tool twice.
			script(`await tools.handover({ plan: "pass it on" });`),
			script(`await tools.handover({ plan: "pass it on again" });`),
			say("I will rethink."),
		]);

		await harness.session.prompt("go");

		expect(seen.map((request) => request.model)).toEqual(["large", "large", "small", "small", "large"]);
		// The lead's error names its own tool.
		expect(seen[1].text).toContain("Only the worker hands back. You are the lead");
		expect(seen[1].text).toContain("tools.handover({...})");
		// The worker's first error names its own tool; the second call hands back, blocked, and ends its turn.
		expect(seen[3].text).toContain("Only the lead hands over. You are the worker");
		expect(seen[3].text).toContain("tools.handback({...})");
		expect(seen[4].text).toContain("status: blocked");
		expect(seen[4].text).toContain("The worker mixed up its role twice");
		// What was repaired is on the branch, on screen, and in the record.
		expect(entries("relay.mixup")).toHaveLength(3);
		expect(notes).toContain("relay: lead called handback, corrected (1)");
		expect(notes).toContain("relay: worker called handover, corrected (1 of 2)");
		expect(notes).toContain("relay: roles mixed up twice, handed back as blocked");
		expect(seen[4].text).toContain("## Repairs in this round");
		expect(seen[4].text).toContain("The worker called handover of the other role");
		await harness.session.prompt("/relay");
		const status = notes.at(-1) ?? "";
		expect(status).toContain("relay: lead has the work, round 1");
		expect(status).toContain("lead → worker (round 1, handover)");
		expect(status).toContain("worker → lead (round 1, handback)");
		expect(status).toContain("repair: The worker called handover of the other role; it was corrected.");
		expect(status).toContain("Used so far in this session:");
		// A second round starts from the record and counts on.
		harness.appendResponses([
			script(`await tools.handover({ plan: "ROUND-TWO-PLAN" });`),
			call("echo", { text: "work" }),
			say("worker again"),
			say("fine"),
		]);
		await harness.session.prompt("one more thing");
		expect(seen.slice(5).map((request) => request.model)).toEqual(["large", "small", "small", "large"]);
		expect(seen.at(-1)?.text).toContain('round="2"');
		expect(seen.at(-1)?.text).toContain("Round 1: do it (blocked)");
		expect(seen.at(-1)?.text).toContain("ROUND-TWO-PLAN");
	});

	it("continues a worker that stops after a wrong-role error, then hands back what it did", async () => {
		const { harness, seen, notes, entries, script, say } = await createRelayHarness({ codemode: true });
		harness.setResponses([
			script(`await tools.handover({ plan: "do it" });`),
			script(`await tools.handover({ plan: "pass it on" });`),
			say("I cannot do that."),
			say("WORKER-FINAL-WORDS"),
			say("review done"),
		]);

		await harness.session.prompt("go");

		expect(seen.map((request) => request.model)).toEqual(["large", "small", "small", "small", "large"]);
		// The stop is continued with a reminder of the role; the reminder goes to the worker that stopped.
		expect(seen[3].text).toContain("You stopped after a relay error. You are the worker");
		expect(entries("relay.stall")).toHaveLength(1);
		expect(notes).toContain("relay: worker stopped after an error, continued (1 of 2)");
		// It then ends normally: the last message is the report and the acceptance has nothing to run.
		expect(seen[4].text).toContain("WORKER-FINAL-WORDS");
		expect(seen[4].text).toContain("The worker stopped after a relay error; it was continued.");
	});

	it("continues a worker that answers with text only after a handover, instead of verifying it", async () => {
		const { harness, seen, system, notes, entries, script, call, say } = await createRelayHarness({
			codemode: true,
		});
		harness.setResponses([
			script(`await tools.handover({ plan: "PLAN-X", acceptance: ["true"] });`),
			// The worker takes the lead's messages for its own and stops.
			say("I have handed the work to the worker and wait for it."),
			call("echo", { text: "real work" }),
			call("handback", { status: "done", report: "REAL-REPORT" }),
			say("reviewed"),
		]);
		await harness.session.prompt("build it");
		await harness.session.waitForIdle();
		expect(seen.map((request) => request.model)).toEqual(["large", "small", "small", "small", "large"]);
		// The first worker request already says the handover happened and who wrote the earlier messages.
		expect(system[1]).toContain("The handover has already happened");
		expect(system[1]).toContain("written by the lead");
		// The text-only stop was continued with a reminder, and the acceptance commands did not run for it.
		expect(seen[2].text).toContain("You answered without doing any work");
		expect(entries("relay.stall")).toMatchObject([{ role: "worker", reason: "idle" }]);
		expect(notes).toContain("relay: worker stopped without working, continued (1 of 2)");
		// Had it been verified, the passing command would have ended the phase after the text-only answer.
		expect(seen[4].text).toContain("`true`: passed (exit 0)");
		expect(seen[4].text).toContain("REAL-REPORT");
		expect(seen[4].text).toContain("The worker stopped without doing any work; it was continued.");
	});

	it("hands back as blocked a worker that keeps answering with text only", async () => {
		const { harness, seen, script, say } = await createRelayHarness({ codemode: true });
		harness.setResponses([
			script(`await tools.handover({ plan: "P", acceptance: ["exit 9"] });`),
			say("waiting 1"),
			say("waiting 2"),
			say("waiting 3"),
			say("reviewed"),
		]);
		await harness.session.prompt("build it");
		await harness.session.waitForIdle();
		expect(seen.map((request) => request.model)).toEqual(["large", "small", "small", "small", "large"]);
		expect(seen[4].text).toContain("status: blocked");
		expect(seen[4].text).toContain("The worker stopped without doing any work");
		expect(seen[4].text).not.toContain("failed (exit 9)");
	});

	it("continues a lead that stops after a wrong-role error at most twice, then lets it end", async () => {
		const { harness, seen, entries, script, say } = await createRelayHarness({ codemode: true });
		const wrong = script(`await tools.handback({ status: "done", report: "x" });`);
		harness.setResponses([wrong, say("stop 1"), wrong, say("stop 2"), wrong, say("stop 3"), say("never asked")]);

		await harness.session.prompt("go");

		expect(entries("relay.stall")).toHaveLength(2);
		expect(seen).toHaveLength(6);
		// A lead that stops for another reason is not continued.
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("does not continue a lead that stops after an error that is not a mix-up", async () => {
		const { harness, seen, script, say } = await createRelayHarness({ codemode: true });
		harness.setResponses([script(`await tools.handover({ plan: "  " });`), say("OK, no plan.")]);
		await harness.session.prompt("go");
		expect(seen).toHaveLength(2);
		expect(seen[1].text).toContain("plan is empty");
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("runs a direct handover(...) through codemode: the same result, a note, a line and an entry (seam C)", async () => {
		const { harness, seen, notes, entries, call, say } = await createRelayHarness({ codemode: true });
		harness.setResponses([
			call("handover", { plan: "DIRECT-PLAN" }),
			call("handback", { status: "done", report: "DIRECT-REPORT" }),
			say("lead review"),
		]);

		await harness.session.prompt("go");

		expect(seen.map((request) => request.model)).toEqual(["large", "small", "large"]);
		// The result as the worker reads it: the note first, then the neutral sentence, and no marker line.
		expect(seen[1].text).toContain(
			"(Call handover from codemode next time: await tools.handover(...).)\nHanded over to the worker model (round 1)",
		);
		expect(seen[1].text).toContain("the messages above were written by the lead.");
		expect(seen[1].text).not.toContain("<relay-handover round");
		// The role is the stored phase: a hand tool called by the worker is labelled the worker's.
		expect(entries("relay.direct")).toMatchObject([
			{ tool: "handover", role: "lead" },
			{ tool: "handback", role: "worker" },
		]);
		expect(notes).toContain("relay: direct handover(...) run as a codemode call");
		expect(seen[2].text).toContain("The lead called handover directly; it was run through codemode.");
		expect(seen[2].text).toContain("The worker called handback directly; it was run through codemode.");
	});

	it("does not start the worker after an unawaited handover whose script ended first", async () => {
		const { harness, seen, entries, script, say, call } = await createRelayHarness({ codemode: true });
		harness.setResponses([
			script(`tools.handover({ plan: "UNAWAITED" }); text("script ended");`),
			say("the lead goes on"),
			// A later, real handover works: the voided one did not leave "already handed over" behind.
			script(`await tools.handover({ plan: "REAL" });`),
			call("echo", { text: "work" }),
			say("worker done"),
			say("review"),
		]);
		await harness.session.prompt("go");
		expect(seen.map((request) => request.model)).toEqual(["large", "large"]);
		expect(entries("relay.transition")).toHaveLength(0);
		await harness.session.prompt("again");
		expect(seen.slice(2).map((request) => request.model)).toEqual(["large", "small", "small", "large"]);
		expect(entries("relay.transition")).toMatchObject([{ to: "worker" }, { to: "lead" }]);
	});

	it("writes no handover when its script ends (exit) while the call is still being made", async () => {
		const { harness, seen, entries, script, say } = await createRelayHarness({ codemode: true });
		harness.setResponses([script(`tools.handover({ plan: "CUT" }); exit();`), say("the lead goes on")]);
		await harness.session.prompt("go");
		expect(entries("relay.handover")).toHaveLength(0);
		expect(seen.map((request) => request.model)).toEqual(["large", "large"]);
	});

	it("writes no transition when the worker model cannot be resolved", async () => {
		const { harness, entries, script } = await createRelayHarness({
			codemode: true,
			relay: { worker: "faux/missing" },
		});
		harness.setResponses([script(`await tools.handover({ plan: "P" });`)]);
		await harness.session.prompt("go").catch(() => undefined);
		expect(entries("relay.transition")).toHaveLength(0);
	});

	it("ends the script at the first handover: the second call never runs", async () => {
		const { harness, seen, entries, script, say, call } = await createRelayHarness({ codemode: true });
		harness.setResponses([
			script(`await tools.handover({ plan: "FIRST" }); await tools.handover({ plan: "SECOND" });`),
			call("echo", { text: "work" }),
			say("worker done"),
			say("review"),
		]);
		await harness.session.prompt("go");
		expect(entries("relay.handover")).toMatchObject([{ plan: "FIRST" }]);
		expect(seen.map((request) => request.model)).toEqual(["large", "small", "small", "large"]);
	});

	it("answers 'already handed over' to a second handover in a parallel codemode call", async () => {
		const { harness, seen, entries, parallel, say, call } = await createRelayHarness({ codemode: true });
		harness.setResponses([
			parallel(`text(await tools.handover({ plan: "FIRST" }));`, `text(await tools.handover({ plan: "SECOND" }));`),
			call("echo", { text: "work" }),
			say("worker done"),
			say("review"),
		]);
		await harness.session.prompt("go");
		expect(entries("relay.handover")).toHaveLength(1);
		expect(entries("relay.mixup")).toHaveLength(0);
		// The worker reads both results: one says it handed over, the other says "already".
		expect(seen[1].text.split("Handed over to the worker model (round 1)")).toHaveLength(2);
		expect(seen[1].text.split("Already handed over.")).toHaveLength(2);
		// One handover took effect: the worker answered next, once.
		expect(seen.map((request) => request.model)).toEqual(["large", "small", "small", "large"]);
	});

	it("pauses the worker's phase when another model is selected and resumes it on relay/auto", async () => {
		const { harness, seen, system, notes, entries, script, say, abort, call } = await createRelayHarness({
			codemode: true,
		});
		harness.setResponses([script(HAND_OVER), abort()]);
		await harness.session.prompt("build it");
		expect(seen.map((request) => request.model)).toEqual(["large", "small"]);

		await harness.session.setModel(harness.getModel("large")!);
		expect(notes).toContain("relay paused (worker phase, round 1)");
		expect(entries("relay.pause")).toHaveLength(1);
		// The other model sees neither the relay text nor the hand tools in a listing.
		harness.appendResponses([say("plain answer")]);
		await harness.session.prompt("hello plain");
		expect(seen.at(-1)?.model).toBe("large");
		expect(system.at(-1)).not.toContain("<relay");
		await harness.session.prompt("/relay");
		expect(notes.at(-1)).toContain("paused, the worker has the work, round 1");

		await harness.session.setModel(harness.session.modelRuntime.getModel(RELAY_PROVIDER, RELAY_MODEL)!);
		expect(notes).toContain("relay resumed (worker phase, round 1)");
		expect(entries("relay.resume")).toHaveLength(1);
		harness.appendResponses([call("echo", { text: "work" }), say("worker continues"), say("review")]);
		await harness.session.prompt("carry on");
		expect(seen.slice(-3).map((request) => request.model)).toEqual(["small", "small", "large"]);
		expect(system.at(-3)).toContain('<relay role="worker">');
	});

	it("/handback while the worker has the work: one hand back, with the worker's own report and no acceptance run", async () => {
		const { harness, seen, entries, script, say, abort } = await createRelayHarness({ codemode: true });
		harness.setResponses([
			script(`await tools.handover({ plan: "P", acceptance: ["exit 9"] });`),
			abort(),
			script(`await tools.handback({ status: "done", report: "OWN-REPORT" });`),
			say("reviewed"),
		]);
		await harness.session.prompt("build it");
		await harness.session.prompt("/handback");
		await harness.session.waitForIdle();

		expect(seen.slice(-2).map((request) => request.model)).toEqual(["small", "large"]);
		expect(seen.at(-2)?.text).toContain("The user asks for a hand back now");
		const review = seen.at(-1)?.text ?? "";
		expect(review).toContain("OWN-REPORT");
		expect(review).not.toContain("failed (exit 9)");
		expect(entries("relay.transition")).toHaveLength(2);
		expect(entries("relay.verify")).toHaveLength(0);
	});

	it("/handback with a worker that just stops: stopped, without the acceptance commands", async () => {
		const { harness, seen, script, say, abort } = await createRelayHarness({ codemode: true });
		harness.setResponses([
			script(`await tools.handover({ plan: "P", acceptance: ["exit 9"] });`),
			abort(),
			say("WHERE-THINGS-STAND"),
			say("reviewed"),
		]);
		await harness.session.prompt("build it");
		await harness.session.prompt("/handback");
		await harness.session.waitForIdle();
		const review = seen.at(-1)?.text ?? "";
		expect(review).toContain("status: stopped");
		expect(review).toContain("WHERE-THINGS-STAND");
		expect(review).not.toContain("failed (exit 9)");
	});

	it("keeps a blocked hand back blocked when a user message arrives before the run ends: no acceptance", async () => {
		const { harness, seen, parallel, call, say } = await createRelayHarness({ codemode: true });
		harness.setResponses([
			call("codemode", { code: `await tools.handover({ plan: "P", acceptance: ["exit 9"] });` }),
			// The hand back is in a batch with another call, so the run goes on.
			parallel(`await tools.handback({ status: "blocked", report: "STUCK-REPORT" });`, `text("side")`),
			(context, _options, _state, model): ReturnType<typeof fauxAssistantMessage> => {
				// A user message arrives while the worker answers; it is queued behind this response.
				void harness.session.steer("USER-FOLLOWUP");
				seen.push({ model: model.id, text: textOf(context) });
				return fauxAssistantMessage("worker waits");
			},
			say("worker answers the follow-up"),
			say("reviewed"),
		]);
		await harness.session.prompt("build it");
		await harness.session.waitForIdle();
		// The follow-up reached the worker after its hand back, before the run ended.
		expect(seen.some((request) => request.model === "small" && request.text.includes("USER-FOLLOWUP"))).toBe(true);
		const review = seen.at(-1)?.text ?? "";
		expect(review).toContain("status: blocked");
		expect(review).toContain("STUCK-REPORT");
		expect(review).not.toContain("failed (exit 9)");
		expect(review).not.toContain("did not all pass");
	});

	it("/handover gives the work to the worker without a plan from the lead", async () => {
		const { harness, seen, system, entries, say, call } = await createRelayHarness({ codemode: true });
		harness.setResponses([call("echo", { text: "work" }), say("worker did it"), say("reviewed")]);
		await harness.session.prompt("/handover do the thing");
		await harness.session.waitForIdle();
		expect(seen.map((request) => request.model)).toEqual(["small", "small", "large"]);
		expect(system[0]).toContain("given by the user");
		// The transcript has the user marker, not a handover round line, and the section names the one that exists.
		expect(system[0]).toContain("before the `<relay-handover-by-user>` line");
		expect(system[0]).not.toContain("<relay-handover round=");
		expect(system[0]).toContain("do the thing");
		expect(entries("relay.transition")).toMatchObject([
			{ from: "lead", to: "worker" },
			{ from: "worker", to: "lead" },
		]);
		expect(seen[2].text).toContain("Handover (given by the user with /handover)");
		// A second /handover while the worker has the work is refused; the lead has it again now, so it goes through.
	});

	describe("nextState", () => {
		const user = (text: string): Message => ({ role: "user", content: text, timestamp: 0 });
		const answer = fauxAssistantMessage("answer") as Message;
		const result = (toolName: string, text: string, isError = false, signal?: ToolResultSignal): Message => ({
			role: "toolResult",
			toolCallId: "1",
			toolName,
			content: [{ type: "text", text }],
			...(signal ? { signal } : {}),
			isError,
			timestamp: 0,
		});
		const signalOf = (round: number): ToolResultSignal => ({ type: "relay.handover", data: { round } });
		const handoverResult = result("handover", "Handed over to the worker model (round 1)", false, signalOf(1));
		// Sessions written before the signal ended the result with this marker line.
		const oldHandoverResult = result("handover", handoverMarker(1));

		it("starts with the lead and changes phase once per handover and hand back", () => {
			expect(nextState(undefined, [user("hi")])).toEqual({ phase: "lead", round: 0 });
			const lead = { phase: "lead" as const, round: 0 };
			expect(nextState(lead, [user("hi"), answer, handoverResult])).toEqual({ phase: "worker", round: 1 });
			expect(nextState(lead, [user("hi"), answer, { ...handoverResult, isError: true } as Message])).toBe(lead);
			expect(nextState(lead, [user(`${USER_HANDOVER_MARKER} go`)])).toEqual({ phase: "worker", round: 1 });
			const worker = { phase: "worker" as const, round: 1 };
			expect(nextState(worker, [user("hi"), answer, handoverResult])).toBe(worker);
			expect(nextState(worker, [user(`${RECORD_MARKER} round="1">`), user("review")])).toEqual({
				phase: "lead",
				round: 1,
			});
		});

		it("accepts a handover from the signal of a handover or codemode result with the next round", () => {
			const lead = { phase: "lead" as const, round: 0 };
			const worker = { phase: "worker" as const, round: 1 };
			const script = result("codemode", "Script completed\nOutput:\nHanded over", false, signalOf(1));
			expect(nextState(lead, [user("hi"), answer, script])).toEqual({ phase: "worker", round: 1 });
			// Another tool's signal, another signal type, another round, a failed call and a marker in the text do not count.
			expect(nextState(lead, [user("hi"), answer, result("bash", "x", false, signalOf(1))])).toBe(lead);
			expect(
				nextState(lead, [
					user("hi"),
					answer,
					result("handover", "x", false, { type: "other", data: { round: 1 } }),
				]),
			).toBe(lead);
			expect(nextState(lead, [user("hi"), answer, result("handover", "x", false, signalOf(2))])).toBe(lead);
			expect(nextState(lead, [user("hi"), answer, result("handover", "x", true, signalOf(1))])).toBe(lead);
			expect(nextState(lead, [user("hi"), answer, result("read", `notes\n${handoverMarker(1)}`, false)])).toBe(lead);
			expect(nextState(worker, [user("hi"), answer, script])).toBe(worker);
		});

		it("accepts the handover of an older session: the marker as the last line of a handover or codemode result", () => {
			expect(nextState({ phase: "lead", round: 0 }, [user("hi"), answer, oldHandoverResult])).toEqual({
				phase: "worker",
				round: 1,
			});
			const lead = { phase: "lead" as const, round: 0 };
			const worker = { phase: "worker" as const, round: 1 };
			// A codemode result ends with the marker.
			const script = result(
				"codemode",
				`Script completed\nWall time 0.1 seconds\nOutput:\nsome output\n${handoverMarker(1)}`,
			);
			expect(nextState(lead, [user("hi"), answer, script])).toEqual({ phase: "worker", round: 1 });
			// A file the worker reads that contains the marker string does not end a result with it...
			const read = result("read", `notes\n${handoverMarker(1)}\nmore notes`);
			expect(nextState(lead, [user("hi"), answer, read])).toBe(lead);
			// ... in any tool's result, nor does the marker in the middle of a codemode result ...
			const printed = result("codemode", `Output:\n${handoverMarker(1)}\nand then more`);
			expect(nextState(lead, [user("hi"), answer, printed])).toBe(lead);
			expect(nextState(lead, [user("hi"), answer, result("bash", handoverMarker(1))])).toBe(lead);
			// ... and the round has to be the next one.
			expect(nextState(lead, [user("hi"), answer, result("handover", handoverMarker(2))])).toBe(lead);
			expect(nextState({ phase: "lead", round: 1 }, [user("hi"), answer, handoverResult])).toEqual({
				phase: "lead",
				round: 1,
			});
			expect(nextState(worker, [user("hi"), answer, script])).toBe(worker);
		});

		it("is not delayed by a user message queued during the handover", () => {
			const lead = { phase: "lead" as const, round: 0 };
			expect(nextState(lead, [user("hi"), answer, handoverResult, user("STEER")])).toEqual({
				phase: "worker",
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
