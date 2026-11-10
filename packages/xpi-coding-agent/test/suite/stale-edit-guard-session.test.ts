import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall, type JsonObject } from "xpi-ai";
import type { ToolResultMessage } from "xpi-ai/compat";
import { createCodemodeExtension } from "../../src/extensions/codemode/index.ts";
import { createHarness, getToolResult, type Harness } from "./harness.ts";

function resultText(message: ToolResultMessage): string {
	return message.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
}

describe("stale-edit guard in a session", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setup(settings: { staleEditGuard?: boolean } = {}) {
		const harness = await createHarness({
			settings,
			initialActiveToolNames: ["read", "edit", "write", "codemode"],
			extensionFactories: [createCodemodeExtension()],
		});
		harnesses.push(harness);
		return harness;
	}

	async function call(harness: Harness, name: string, args: JsonObject) {
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		return getToolResult(harness, name);
	}

	it("refuses a direct edit of an unread file and accepts it after a read", async () => {
		const harness = await setup();
		const path = join(harness.tempDir, "a.txt");
		writeFileSync(path, "alpha\n");
		const edit = { path: "a.txt", edits: [{ oldText: "alpha", newText: "ALPHA" }] };

		const refused = await call(harness, "edit", edit);
		expect(refused.isError).toBe(true);
		expect(resultText(refused)).toContain("has not been read in this session. Read it before editing.");

		await call(harness, "read", { path: "a.txt" });
		const accepted = await call(harness, "edit", edit);
		expect(accepted.isError).toBe(false);
		expect(readFileSync(path, "utf-8")).toBe("ALPHA\n");
	});

	it("applies the same rules to edit and write calls made from a codemode script", async () => {
		const harness = await setup();
		const path = join(harness.tempDir, "a.txt");
		writeFileSync(path, "alpha\n");

		// Reads in an earlier call count for later scripts, and a change in between is caught.
		await call(harness, "read", { path: "a.txt" });
		writeFileSync(path, "alpha\nchanged elsewhere\n");
		const stale = await call(harness, "codemode", {
			code: 'await tools.edit({ path: "a.txt", edits: [{ oldText: "alpha", newText: "ALPHA" }] });',
		});
		expect(stale.isError).toBe(true);
		expect(resultText(stale)).toContain("changed since you last read it. Read it again before editing.");
		expect(readFileSync(path, "utf-8")).toBe("alpha\nchanged elsewhere\n");

		// Read then edit then write inside one script works.
		const fresh = await call(harness, "codemode", {
			code: 'await tools.read({ path: "a.txt" });\nawait tools.edit({ path: "a.txt", edits: [{ oldText: "alpha", newText: "ALPHA" }] });\nawait tools.write({ path: "a.txt", content: "final\\n" });',
		});
		expect(fresh.isError).toBe(false);
		expect(readFileSync(path, "utf-8")).toBe("final\n");

		// A script that overwrites an unread existing file fails.
		writeFileSync(join(harness.tempDir, "b.txt"), "b\n");
		const unread = await call(harness, "codemode", {
			code: 'await tools.write({ path: "b.txt", content: "x" });',
		});
		expect(unread.isError).toBe(true);
		expect(resultText(unread)).toContain("File b.txt has not been read in this session.");
	});

	it("is switched off by the staleEditGuard setting, also while the session runs", async () => {
		const harness = await setup({ staleEditGuard: false });
		const path = join(harness.tempDir, "a.txt");
		writeFileSync(path, "alpha\n");
		const accepted = await call(harness, "edit", { path: "a.txt", edits: [{ oldText: "alpha", newText: "ALPHA" }] });
		expect(accepted.isError).toBe(false);

		harness.settingsManager.applyOverrides({ staleEditGuard: true });
		writeFileSync(path, "ALPHA\nmore\n");
		const refused = await call(harness, "edit", { path: "a.txt", edits: [{ oldText: "ALPHA", newText: "x" }] });
		expect(refused.isError).toBe(true);
	});
});
