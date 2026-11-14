import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "xpi-ai";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import checksExtension from "../../src/extensions/checks/index.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

// The repo's own tsc by absolute path: no network, no npx.
const TSC = join(import.meta.dirname, "..", "..", "..", "..", "node_modules", ".bin", "tsc");

describe("checks extension with a real tsc", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("reports the type error an edit adds, and only that one", async () => {
		let dir = "";
		const editTool = (pi: ExtensionAPI) =>
			pi.registerTool({
				name: "break_types",
				label: "break_types",
				description: "Adds a type error to a.ts",
				parameters: Type.Object({}),
				effect: "write",
				execute: async () => {
					writeFileSync(join(dir, "a.ts"), 'export const n: number = 1;\nexport const s: number = "text";\n');
					return { content: [{ type: "text" as const, text: "edited" }], details: {} };
				},
			});
		const harness = await createHarness({
			settings: { checks: { commands: [`"${TSC}" --noEmit -p .`], timeoutMs: 120_000 } },
			extensionFactories: [editTool, checksExtension],
			initialActiveToolNames: ["break_types"],
		});
		harnesses.push(harness);
		dir = harness.tempDir;
		writeFileSync(
			join(dir, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: { strict: true, noEmit: true, types: [], target: "es2022", module: "esnext" },
				include: ["a.ts"],
			}),
		);
		writeFileSync(join(dir, "a.ts"), "export const n: number = 1;\n");
		await harness.session.bindExtensions({});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("break_types", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		const messages = harness.session.messages
			.filter((message) => message.role === "custom")
			.map((message) => getMessageText(message));
		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain("1 new error");
		expect(messages[0]).toContain("a.ts:2:14 TS2322");
	}, 180_000);
});
