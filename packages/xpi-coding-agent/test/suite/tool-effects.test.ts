import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "xpi-ai";
import type { ExtensionAPI, ToolCallEvent, ToolEffect } from "../../src/core/extensions/types.ts";
import { createCodemodeExtension } from "../../src/extensions/codemode/index.ts";
import { createMcpToolDefinition } from "../../src/extensions/mcp/tools.ts";
import { createToolSearchExtension } from "../../src/extensions/tool-search/index.ts";
import { createHarness, type Harness } from "./harness.ts";

const noopClient = async () => ({ callTool: async () => ({ content: [] }) }) as never;

function mcpTool(name: string, annotations?: Record<string, unknown>) {
	return createMcpToolDefinition({
		server: "docs",
		tool: { name, inputSchema: { type: "object", properties: {} }, ...(annotations ? { annotations } : {}) },
		name: `mcp__docs__${name}`,
		exposure: "direct",
		namespace: { name: "mcp__docs" },
		timeoutMs: 1000,
		getClient: noopClient,
	});
}

describe("tool effects", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	function effectsExtension(seen: Map<string, ToolEffect>) {
		return (pi: ExtensionAPI) => {
			const execute = async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} });
			pi.registerTool({
				name: "declared_read",
				label: "declared_read",
				description: "Declares read.",
				parameters: Type.Object({}),
				effect: "read",
				execute,
			});
			pi.registerTool({
				name: "undeclared",
				label: "undeclared",
				description: "Declares nothing.",
				parameters: Type.Object({}),
				execute,
			});
			pi.registerTool(mcpTool("lookup", { readOnlyHint: true }));
			pi.registerTool(mcpTool("change", { readOnlyHint: false }));
			pi.registerTool(mcpTool("unknown"));
			pi.on("tool_call", async (event: ToolCallEvent) => {
				seen.set(event.toolName, event.effect);
				return undefined;
			});
		};
	}

	it("passes the effect on tool_call events", async () => {
		const seen = new Map<string, ToolEffect>();
		const names = [
			"read",
			"bash",
			"edit",
			"declared_read",
			"undeclared",
			"mcp__docs__lookup",
			"mcp__docs__change",
			"mcp__docs__unknown",
		];
		const harness = await createHarness({
			extensionFactories: [effectsExtension(seen)],
			initialActiveToolNames: names,
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("read", { path: "missing.txt" }),
					fauxToolCall("bash", { command: "true" }),
					fauxToolCall("edit", { path: "missing.txt", edits: [] }),
					fauxToolCall("declared_read", {}),
					fauxToolCall("undeclared", {}),
					fauxToolCall("mcp__docs__lookup", {}),
					fauxToolCall("mcp__docs__change", {}),
					fauxToolCall("mcp__docs__unknown", {}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");

		expect(Object.fromEntries(seen)).toEqual({
			read: "read",
			bash: "exec",
			edit: "write",
			declared_read: "read",
			undeclared: "exec",
			mcp__docs__lookup: "read",
			mcp__docs__change: "write",
			mcp__docs__unknown: "write",
		});
	});

	it("lists effects in getAllTools()", async () => {
		const harness = await createHarness({
			extensionFactories: [effectsExtension(new Map()), createCodemodeExtension(), createToolSearchExtension()],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const effects = Object.fromEntries(harness.session.getAllTools().map((tool) => [tool.name, tool.effect]));
		expect(effects).toMatchObject({
			read: "read",
			grep: "read",
			find: "read",
			ls: "read",
			edit: "write",
			write: "write",
			bash: "exec",
			codemode: "exec",
			tool_search: "read",
			declared_read: "read",
			undeclared: "exec",
			mcp__docs__lookup: "read",
			mcp__docs__change: "write",
			mcp__docs__unknown: "write",
		});
	});
});
