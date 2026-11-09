// Review fixes C2, C4, C6 on a real session: nested calls of a codemode script that went to the background.

import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentTool } from "xpi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "xpi-ai";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { createToolDefinitionFromAgentTool } from "../../src/core/tools/tool-definition-wrapper.ts";
import { createCodemodeExtension } from "../../src/extensions/codemode/index.ts";
import {
	beginCodemodeScript,
	type CodemodeScriptEnd,
	type CodemodeScriptInfo,
	codemodeScripts,
} from "../../src/extensions/codemode/scripts.ts";
import { createHarness, type Harness } from "./harness.ts";

const PAID_COST = 0.5;

describe("background codemode scripts: nested calls after the early return", () => {
	const harnesses: Harness[] = [];
	const unsubscribe: Array<() => void> = [];

	afterEach(async () => {
		while (unsubscribe.length > 0) unsubscribe.pop()?.();
		for (const h of harnesses) await codemodeScripts.stopAll(h.sessionManager.getSessionId());
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setup() {
		const gates = new Map<string, (value: string) => void>();
		const gate: AgentTool = {
			name: "gate",
			label: "Gate",
			description: "Wait until the test opens the gate",
			parameters: Type.Object({ name: Type.String() }),
			execute: async (_id, params: any) => ({
				content: [{ type: "text", text: await new Promise<string>((r) => gates.set(params.name, r)) }],
				details: {},
			}),
		};
		const paid: AgentTool = {
			name: "paid",
			label: "Paid",
			description: "A tool that reports usage, as an Agent call does",
			parameters: Type.Object({}),
			execute: async () => ({
				content: [{ type: "text", text: "paid" }],
				details: {},
				usage: {
					input: 100,
					output: 50,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 150,
					cost: { input: PAID_COST / 2, output: PAID_COST / 2, cacheRead: 0, cacheWrite: 0, total: PAID_COST },
				},
			}),
		};
		const harness = await createHarness({
			initialActiveToolNames: ["codemode", "gate", "paid"],
			extensionFactories: [
				createCodemodeExtension(),
				(pi: ExtensionAPI) => {
					pi.registerTool(createToolDefinitionFromAgentTool(gate));
					pi.registerTool(createToolDefinitionFromAgentTool(paid));
				},
			],
		});
		harnesses.push(harness);
		const ended: Array<{ info: CodemodeScriptInfo; outcome: CodemodeScriptEnd }> = [];
		const waiters: Array<() => void> = [];
		unsubscribe.push(
			codemodeScripts.subscribe({
				onStart: (s) => s.sessionId === harness.sessionManager.getSessionId() && codemodeScripts.background(s.id),
				onEnd: (s, outcome) => {
					ended.push({ info: { ...s }, outcome });
					for (const w of waiters.splice(0)) w();
				},
			}),
		);
		const waitEnded = async () => {
			while (ended.length < 1) await new Promise<void>((r) => waiters.push(r));
		};
		const open = async (name: string) => {
			for (let i = 0; i < 200 && !gates.has(name); i++) await new Promise((r) => setTimeout(r, 10));
			gates.get(name)?.(name);
			gates.delete(name);
		};
		const script = (code: string) =>
			fauxAssistantMessage([fauxToolCall("codemode", { code })], { stopReason: "toolUse" });
		return { harness, ended, waitEnded, open, script };
	}

	it("C2: usage of calls a background script makes after the early return is in the session totals", async () => {
		const { harness, ended, waitEnded, open, script } = await setup();
		harness.setResponses([
			script('await tools.gate({ name: "a" }); await tools.paid({}); await tools.paid({}); return "x"'),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		const before = harness.session.getSessionStats().cost;
		await open("a");
		await waitEnded();
		expect(ended[0].outcome.background).toBe(true);
		expect(harness.session.getSessionStats().cost - before).toBeCloseTo(2 * PAID_COST);
	});

	it("C4: a background script's calls still run after the session's messages are gone (no assistant message issued)", async () => {
		const { harness, waitEnded, open, script } = await setup();
		harness.setResponses([
			script('await tools.gate({ name: "a" }); const r = await tools.paid({}); return JSON.stringify(r)'),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		harness.session.agent.state.messages = []; // /new, resume, a rewind: the latest turn is not the originating one
		await open("a");
		await waitEnded();
		const calls = harness.session.getSessionStats();
		expect(calls.cost).toBeGreaterThanOrEqual(PAID_COST); // the paid call ran, it did not fail "No assistant message"
	});
});

describe("C6: a script that already settled cannot be moved to the background", () => {
	it("background() is refused after settle(), and the end is not a background end", () => {
		const events: string[] = [];
		const off = codemodeScripts.subscribe({
			onBackground: () => events.push("background"),
			onEnd: (_s, outcome) => events.push(`end:${outcome.background}`),
		});
		const run = beginCodemodeScript("c6-call", "c6", undefined);
		run.settle();
		expect(codemodeScripts.background(run.info.id)).toBe(false);
		expect(run.info.state).toBe("foreground");
		run.end({ result: { content: [], details: {} } });
		off();
		expect(events).toEqual(["end:false"]);
	});
});
