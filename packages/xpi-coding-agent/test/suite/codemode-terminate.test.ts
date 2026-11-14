import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "xpi-ai";
import type { ToolResultMessage } from "xpi-ai/compat";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { createCodemodeExtension } from "../../src/extensions/codemode/index.ts";
import { createHarness, getToolResult, type Harness } from "./harness.ts";

/** Seam B (a nested `terminate` ends the script) and seam A (`listed: false`) of the codemode tool. */

function lines(message: ToolResultMessage): string[] {
	return message.content.flatMap((block) => (block.type === "text" ? block.text.split("\n") : []));
}

describe("codemode: nested terminate and unlisted tools", () => {
	const harnesses: Harness[] = [];
	const calls: string[] = [];

	afterEach(() => {
		calls.length = 0;
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setup() {
		const harness = await createHarness({
			initialActiveToolNames: ["codemode"],
			extensionFactories: [
				createCodemodeExtension(),
				(pi: ExtensionAPI) => {
					// Ends the script; unlisted, so only a script that knows the name reaches it.
					pi.registerTool({
						name: "stop",
						label: "Stop",
						description: "Stops the script",
						parameters: Type.Object({ text: Type.Optional(Type.String()) }),
						exposure: "deferred",
						listed: false,
						async execute(_id, params) {
							calls.push("stop");
							return {
								content: [{ type: "text", text: params.text ?? "STOP-MARKER" }],
								details: {},
								terminate: true,
							};
						},
					});
					pi.registerTool({
						name: "plain",
						label: "Plain",
						description: "A listed tool",
						parameters: Type.Object({}),
						exposure: "deferred",
						async execute() {
							calls.push("plain");
							return { content: [{ type: "text", text: "plain result" }], details: {} };
						},
					});
				},
			],
		});
		harnesses.push(harness);
		return harness;
	}

	async function run(harness: Harness, code: string) {
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("codemode", { code })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		return getToolResult(harness, "codemode");
	}

	it("ends the script at a terminating nested call and puts that call's text last", async () => {
		const harness = await setup();
		const result = await run(
			harness,
			`text("OUT"); console.log("LOG"); await tools.stop({}); calls_after = true; text("AFTER"); await tools.plain({});`,
		);
		expect(result.isError).toBeFalsy();
		const text = lines(result);
		expect(text[0]).toBe("Script completed");
		expect(text.at(-1)).toBe("STOP-MARKER");
		expect(text.join("\n")).toContain("<console_output>\nLOG\n</console_output>\nSTOP-MARKER");
		expect(text.join("\n")).toContain("OUT");
		expect(text.join("\n")).not.toContain("AFTER");
		expect(calls).toEqual(["stop"]);
		// The codemode result asks to terminate and is the batch's only call, so the run stops: no second request.
		expect(harness.session.messages.at(-1)?.role).toBe("toolResult");
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("does not truncate the terminating call's text", async () => {
		const harness = await setup();
		const marker = `LONG-${"x".repeat(2000)}`;
		const result = await run(
			harness,
			`// @options: {"max_output_tokens": 20}\nconsole.log("y".repeat(4000)); await tools.stop({ text: ${JSON.stringify(marker)} });`,
		);
		const text = lines(result);
		expect(text.join("\n")).toContain("truncated output");
		expect(text.at(-1)).toBe(marker);
	});

	it("leaves an ordinary script alone: no terminate, the run goes on", async () => {
		const harness = await setup();
		const result = await run(harness, `await tools.plain({}); text("fine");`);
		expect(lines(result).join("\n")).toContain("fine");
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("calls an unlisted tool by name but hides it from every listing", async () => {
		const harness = await setup();
		const result = await run(
			harness,
			`
			const names = ALL_TOOLS.map((tool) => tool.name);
			const found = (await searchTools("stop script")).map((tool) => tool.name);
			const described = await describeTool("stop");
			const listed = await describeTool("plain");
			return { names, found, described: described ?? null, listed: Boolean(listed), callable: typeof tools.stop };
			`,
		);
		const value = JSON.parse(lines(result).slice(3).join("\n")) as {
			names: string[];
			found: string[];
			described: string | null;
			listed: boolean;
			callable: string;
		};
		expect(value.names).toContain("plain");
		expect(value.names).not.toContain("stop");
		expect(value.found).not.toContain("stop");
		expect(value.described).toBeNull();
		expect(value.listed).toBe(true);
		expect(value.callable).toBe("function");
		// And it stays out of the codemode description.
		const description = harness.session.agent.state.tools.find((tool) => tool.name === "codemode")?.description ?? "";
		expect(description).not.toContain("Stops the script");
	});

	it("runs a direct call of a codemode-only tool through the pipeline, with a note on the first line (seam C)", async () => {
		const hooked: string[] = [];
		const harness = await setup();
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("stop", { text: "STOP-MARKER" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "tool_execution_end") hooked.push(event.toolName);
		});
		await harness.session.prompt("go");
		unsubscribe();
		const result = getToolResult(harness, "stop");
		expect(lines(result)).toEqual(["(Call stop from codemode next time: await tools.stop(...).)", "STOP-MARKER"]);
		expect(result.isError).toBe(false);
		expect(calls).toEqual(["stop"]);
		expect(hooked).toEqual(["stop"]);
		// terminate: the run ended without a second request.
		expect(harness.getPendingResponseCount()).toBe(1);
		// An unknown name still fails.
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("nothing", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("ok"),
		]);
		await harness.session.prompt("again");
		expect(lines(getToolResult(harness, "nothing"))).toEqual(["Tool nothing not found"]);
	});
});
