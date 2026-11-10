// The Workflow tool on a real session (faux model, fake subagent children): main's script calls
// tools.Workflow({ name, args }); the workflow starts as its own background script, its Agent calls (nested under the
// Workflow call) reach a child, and its end reaches main as a message naming the workflow.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "xpi-ai";
import { createCodemodeExtension } from "../../src/extensions/codemode/index.ts";
import { codemodeScripts } from "../../src/extensions/codemode/scripts.ts";
import subagent from "../../src/extensions/subagent/index.ts";
import { FAKE_PI } from "../subagent/helpers.ts";
import { createHarness, createTestUiContext, type Harness } from "./harness.ts";

const happy = (text: string) => [
	JSON.stringify({ type: "session", version: 3, id: "child", timestamp: "2026-11-10T00:00:00Z", cwd: "/x" }),
	JSON.stringify({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
		},
	}),
	JSON.stringify({ type: "turn_end", message: {}, toolResults: [] }),
	JSON.stringify({ type: "agent_settled", aborted: false }),
];

describe("Workflow tool", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		for (const h of harnesses) await codemodeScripts.stopAll(h.sessionManager.getSessionId());
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setup() {
		// Nothing of the real user dirs: a temp HOME and agent dir, where the saved workflow lives.
		const root = mkdtempSync(join(tmpdir(), "workflow-tool-"));
		const agentDir = join(root, "agent");
		mkdirSync(join(agentDir, "workflows"), { recursive: true });
		vi.stubEnv("HOME", join(root, "home"));
		vi.stubEnv("XPI_CODING_AGENT_DIR", agentDir);
		vi.stubEnv("FAKE_PI_SCENARIO", join(root, "scenario.json"));
		vi.stubEnv("FAKE_PI_RECORD", join(root, "record.json"));
		writeFileSync(join(root, "scenario.json"), JSON.stringify({ lines: happy("child says hi") }));
		writeFileSync(
			join(agentDir, "workflows", "greet.js"),
			[
				"export const meta = { name: 'greet', description: 'Greet someone through a subagent' }",
				"const out = await agent('say hi to ' + args.who, { label: 'greeter' });",
				"return 'greeted ' + args.who + ': ' + out;",
			].join("\n"),
		);
		const harness = await createHarness({
			settings: { subagent: { piCommand: FAKE_PI } } as never,
			initialActiveToolNames: ["codemode"],
			extensionFactories: [createCodemodeExtension(), subagent],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: createTestUiContext() });
		return harness;
	}

	it("starts the workflow in the background, returns its script id, and its end reaches main", async () => {
		const harness = await setup();
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("codemode", {
						code: "return await tools.Workflow({ name: 'greet', args: { who: 'ada' } })",
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("started it"),
			fauxAssistantMessage("got the result"),
		]);
		await harness.session.prompt("greet ada");
		const toolResults = harness.session.messages.filter((m) => m.role === "toolResult");
		const started = JSON.stringify(toolResults.at(-1));
		expect(started).toMatch(/Workflow greet started as background script S\d+/);
		await vi.waitFor(
			() => {
				const end = harness.session.messages.find(
					(m) => m.role === "custom" && String((m as { content: unknown }).content).includes("(workflow greet)"),
				);
				expect(String((end as { content: unknown } | undefined)?.content)).toMatch(
					/Background script S\d+ \(workflow greet\) completed\.[\s\S]*greeted ada: child says hi/,
				);
			},
			{ timeout: 15_000 },
		);
	});

	it("is described with the saved workflows; an unknown name is an error", async () => {
		const harness = await setup();
		const tool = harness.session.getAllTools().find((t) => t.name === "Workflow");
		expect(tool?.description).toMatch(/- greet: Greet someone through a subagent/);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("codemode", { code: "return await tools.Workflow({ name: 'nope' })" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("ok"),
		]);
		await harness.session.prompt("run nope");
		const result = JSON.stringify(harness.session.messages.filter((m) => m.role === "toolResult").at(-1));
		expect(result).toMatch(/no saved workflow \\"nope\\" is available here/);
	});
});
