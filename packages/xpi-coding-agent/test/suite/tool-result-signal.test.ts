import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "xpi-ai";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createCodemodeExtension } from "../../src/extensions/codemode/index.ts";
import { createHarness, getToolResult, type Harness } from "./harness.ts";

/** `signal` on a tool result: kept in the session, copied by codemode from the call that ended the script. */

const ENDING = { type: "test.ending", data: { round: 3 } };
const QUIET = { type: "test.quiet" };

describe("tool result signal", () => {
	const harnesses: Harness[] = [];
	const dirs: string[] = [];
	let rewrite = false;

	afterEach(() => {
		rewrite = false;
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
	});

	async function setup(sessionManager?: SessionManager) {
		const harness = await createHarness({
			initialActiveToolNames: ["codemode"],
			...(sessionManager ? { sessionManager } : {}),
			extensionFactories: [
				createCodemodeExtension(),
				(pi: ExtensionAPI) => {
					pi.registerTool({
						name: "ending",
						label: "Ending",
						description: "Ends the script and raises a signal",
						parameters: Type.Object({}),
						exposure: "deferred",
						async execute() {
							return {
								content: [{ type: "text", text: "ENDED" }],
								details: {},
								terminate: true,
								signal: ENDING,
							};
						},
					});
					pi.registerTool({
						name: "quiet",
						label: "Quiet",
						description: "Raises a signal and lets the script go on",
						parameters: Type.Object({}),
						exposure: "deferred",
						async execute() {
							return { content: [{ type: "text", text: "quiet" }], details: {}, signal: QUIET };
						},
					});
					pi.on("tool_result", (event) =>
						rewrite && event.toolName === "ending"
							? { content: [{ type: "text", text: "REWRITTEN" }], details: { changed: true } }
							: undefined,
					);
				},
			],
		});
		harnesses.push(harness);
		return harness;
	}

	async function run(harness: Harness, call: ReturnType<typeof fauxToolCall>) {
		harness.setResponses([fauxAssistantMessage([call], { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
		await harness.session.prompt("go");
	}

	it("takes the signal of the nested call that ended the script", async () => {
		const harness = await setup();
		await run(harness, fauxToolCall("codemode", { code: `await tools.quiet({}); await tools.ending({});` }));
		const result = getToolResult(harness, "codemode");
		expect(result.signal).toEqual(ENDING);
		expect(result.nestedCalls?.calls.map((call) => call.name)).toEqual(["quiet", "ending"]);
	});

	it("does not take the signal of a nested call that did not end the script", async () => {
		const harness = await setup();
		await run(harness, fauxToolCall("codemode", { code: `await tools.quiet({}); text("fine");` }));
		expect(getToolResult(harness, "codemode").signal).toBeUndefined();
	});

	it("keeps the signal on a direct call of a codemode-only tool", async () => {
		const harness = await setup();
		await run(harness, fauxToolCall("ending", {}));
		const result = getToolResult(harness, "ending");
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("ENDED") });
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining("Call ending from codemode") });
		expect(result.signal).toEqual(ENDING);
	});

	it("keeps the signal when a tool_result handler returns a modified result", async () => {
		rewrite = true;
		const harness = await setup();
		await run(harness, fauxToolCall("ending", {}));
		const result = getToolResult(harness, "ending");
		expect(JSON.stringify(result.content)).toContain("REWRITTEN");
		expect(result.signal).toEqual(ENDING);
	});

	it("is kept in the session file and after a reload", async () => {
		const dir = mkdtempSync(join(tmpdir(), "xpi-signal-"));
		dirs.push(dir);
		const harness = await setup(SessionManager.create(dir));
		await run(harness, fauxToolCall("codemode", { code: `await tools.ending({});` }));
		const file = harness.session.sessionFile;
		expect(file).toBeDefined();
		const reloaded = SessionManager.open(file as string);
		const messages = reloaded
			.getEntries()
			.flatMap((entry) => (entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : []));
		expect(messages.map((message) => message.signal)).toEqual([ENDING]);
	});
});
