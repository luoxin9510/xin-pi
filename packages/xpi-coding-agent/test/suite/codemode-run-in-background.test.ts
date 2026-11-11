import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentTool } from "xpi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "xpi-ai";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { createToolDefinitionFromAgentTool } from "../../src/core/tools/tool-definition-wrapper.ts";
import { createCodemodeExtension } from "../../src/extensions/codemode/index.ts";
import {
	type CodemodeScriptEnd,
	type CodemodeScriptInfo,
	codemodeScripts,
} from "../../src/extensions/codemode/scripts.ts";
import { CODEMODE_TOOL_NAME, codemodeSchema, createCodemodeDescription } from "../../src/extensions/codemode/tool.ts";
import { createHarness, getToolResult, type Harness } from "./harness.ts";

const text = (result: { content?: { type: string; text?: string }[] } | undefined) =>
	(result?.content ?? []).map((c) => c.text ?? "").join("");

describe("codemode run_in_background", () => {
	const harnesses: Harness[] = [];
	const cleanups: Array<() => void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) cleanups.pop()?.();
		for (const h of harnesses) await codemodeScripts.stopAll(h.sessionManager.getSessionId());
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	// `background`: whether a provider (the subagent extension's role) allows background scripts for the session.
	async function setup(background: boolean | "off") {
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
		const harness = await createHarness({
			initialActiveToolNames: ["codemode", "gate"],
			extensionFactories: [
				createCodemodeExtension(),
				(pi: ExtensionAPI) => pi.registerTool(createToolDefinitionFromAgentTool(gate)),
			],
		});
		harnesses.push(harness);
		if (background !== false) {
			cleanups.push(
				codemodeScripts.provideBackground({
					sessionId: () => harness.sessionManager.getSessionId(),
					enabled: () => background === true,
				}),
			);
		}
		const started: CodemodeScriptInfo[] = [];
		const ended: Array<{ info: CodemodeScriptInfo; outcome: CodemodeScriptEnd }> = [];
		const waiters: Array<() => void> = [];
		cleanups.push(
			codemodeScripts.subscribe({
				onStart: (s) => started.push({ ...s }),
				onEnd: (s, outcome) => {
					ended.push({ info: { ...s }, outcome });
					for (const w of waiters.splice(0)) w();
				},
			}),
		);
		const waitEnded = async () => {
			while (ended.length < 1) await new Promise<void>((r) => waiters.push(r));
		};
		const open = async (name: string, value = name) => {
			for (let i = 0; i < 200 && !gates.has(name); i++) await new Promise((r) => setTimeout(r, 10));
			gates.get(name)?.(value);
			gates.delete(name);
		};
		const call = (input: Parameters<typeof fauxToolCall>[1]) =>
			fauxAssistantMessage([fauxToolCall("codemode", input)], { stopReason: "toolUse" });
		return { harness, started, ended, waitEnded, open, call };
	}

	const CODE = 'const r = await tools.gate({ name: "a" }); return "got " + r';

	it("returns at once with an early text naming the id and description, and the script's result arrives at its end", async () => {
		const { harness, started, ended, waitEnded, open, call } = await setup(true);
		harness.setResponses([
			call({ code: CODE, run_in_background: true, description: "build and test" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go"); // main's turn ends while the script still waits on its gate
		const early = getToolResult(harness, "codemode");
		expect(text(early)).toMatch(/^Script S\d+ \(build and test\) started in the background/);
		expect(text(early)).toContain("Do not wait");
		expect(early.details).toMatchObject({ background: true, scriptId: started[0].id });
		expect(started[0]).toMatchObject({ description: "build and test" }); // snapshot taken at the start
		expect(codemodeScripts.owner(`${started[0].toolCallId}/1`)).toMatchObject({ state: "background" });
		expect(started[0].code).toBe(CODE);
		expect(ended).toHaveLength(0);
		await open("a");
		await waitEnded();
		expect(ended[0].outcome).toMatchObject({ background: true, stopped: false });
		expect(text(ended[0].outcome.result)).toContain("got a");
	});

	it("without a description the early text names only the id", async () => {
		const { harness, call } = await setup(true);
		harness.setResponses([call({ code: "return 1", run_in_background: true }), fauxAssistantMessage("done")]);
		await harness.session.prompt("go");
		expect(text(getToolResult(harness, "codemode"))).toMatch(/^Script S\d+ started in the background/);
	});

	it("waits when no background provider is registered (subagent extension off)", async () => {
		const { harness, call } = await setup(false);
		harness.setResponses([
			call({ code: 'return "plain"', run_in_background: true, description: "x" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		const result = getToolResult(harness, "codemode");
		expect(text(result)).toContain("plain");
		expect(result.details).not.toHaveProperty("background");
	});

	it("waits when the provider is off (subagent.backgroundScripts: false, print mode)", async () => {
		const { harness, ended, call } = await setup("off");
		harness.setResponses([call({ code: 'return "plain"', run_in_background: true }), fauxAssistantMessage("done")]);
		await harness.session.prompt("go");
		expect(text(getToolResult(harness, "codemode"))).toContain("plain");
		expect(ended[0].outcome.background).toBe(false);
	});

	it("run_in_background: false and an omitted flag keep the call waiting", async () => {
		const { harness, call } = await setup(true);
		harness.setResponses([call({ code: 'return "plain"', run_in_background: false }), fauxAssistantMessage("done")]);
		await harness.session.prompt("go");
		expect(text(getToolResult(harness, "codemode"))).toContain("plain");
	});

	it("the schema has both optional fields and the description tells the model when to use the flag", () => {
		expect(codemodeSchema.properties.run_in_background).toBeDefined();
		expect(codemodeSchema.properties.description).toBeDefined();
		expect(codemodeSchema.required).toEqual(["code"]);
		const description = createCodemodeDescription([]);
		expect(description).toContain("run_in_background");
		expect(description).toContain("more than about 30 seconds");
		expect(description).toContain("dev server");
		expect(description).toContain("filtered result");
		expect(CODEMODE_TOOL_NAME).toBe("codemode");
	});
});
