import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "xpi-ai";
import { createCodemodeExtension } from "../../src/extensions/codemode/index.ts";
import protectExtension from "../../src/extensions/protect/index.ts";
import { createHarness, createTestUiContext, getMessageText, getToolResult, type Harness } from "./harness.ts";

describe("protect extension", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setup() {
		const harness = await createHarness({
			initialActiveToolNames: ["read", "write", "grep", "codemode"],
			extensionFactories: [createCodemodeExtension(), protectExtension],
		});
		harnesses.push(harness);
		const notifications: string[] = [];
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({ notify: (message) => notifications.push(message) }),
		});
		writeFileSync(join(harness.tempDir, ".env"), "TOKEN=hunter2\n");
		writeFileSync(join(harness.tempDir, "notes.txt"), "hello\n");
		mkdirSync(join(harness.tempDir, ".git"));
		const call = (name: string, input: Record<string, string>) =>
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall(name, input), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
		const resultText = (name: string) => getMessageText(getToolResult(harness, name));
		return { harness, notifications, call, resultText };
	}

	it("blocks a direct read of .env with the reason", async () => {
		const { harness, notifications, call, resultText } = await setup();
		call("read", { path: ".env" });
		await harness.session.prompt("go");
		const text = resultText("read");
		expect(text).toContain(
			"`.env` is protected (secret): it cannot be read or written. If it is needed, ask the user.",
		);
		expect(text).not.toContain("hunter2");
		expect(notifications).toContain("protect: blocked read of .env (secret)");
	});

	it("lets an ordinary read through", async () => {
		const { harness, call, resultText } = await setup();
		call("read", { path: "notes.txt" });
		await harness.session.prompt("go");
		expect(resultText("read")).toContain("hello");
	});

	it("blocks a nested codemode write to .git/x, until /protect off, and again after /protect on", async () => {
		const { harness, notifications, call, resultText } = await setup();
		const script = `try { await tools.write({ path: ".git/x", content: "1" }); return "written"; } catch (error) { return error.message; }`;
		call("codemode", { code: script });
		await harness.session.prompt("go");
		expect(resultText("codemode")).toContain("`.git/x` is protected (read-only): it cannot be written.");
		expect(notifications).toContain("protect: blocked write of .git/x (read-only)");

		await harness.session.prompt("/protect off");
		call("codemode", { code: script });
		await harness.session.prompt("go again");
		expect(resultText("codemode")).toContain("written");

		await harness.session.prompt("/protect on");
		call("codemode", { code: script.replace(".git/x", ".git/y") });
		await harness.session.prompt("and again");
		expect(resultText("codemode")).toContain("is protected (read-only)");
	});

	it("shows the state and the lists with /protect", async () => {
		const { harness, notifications } = await setup();
		await harness.session.prompt("/protect");
		const text = notifications.find((n) => n.startsWith("protect: on for this session")) ?? "";
		expect(text).toContain("secret (no read, no write): .env, .env.*");
		expect(text).toContain("read-only (no write): .git/, node_modules/");
	});

	it("does not block a grep over the project", async () => {
		const { harness, call, resultText } = await setup();
		call("grep", { pattern: "TOKEN", path: "." });
		await harness.session.prompt("go");
		const text = resultText("grep");
		expect(text).not.toContain("is protected");
		// The search ran and printed the secret: the documented gap outside a git repository.
		expect(text).toContain("hunter2");
	});

	it("blocks a grep named at .env", async () => {
		const { harness, call, resultText } = await setup();
		call("grep", { pattern: "TOKEN", path: ".env" });
		await harness.session.prompt("go");
		expect(resultText("grep")).toContain("is protected (secret)");
	});
});
