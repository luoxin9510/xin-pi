import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall, type JsonObject } from "xpi-ai";
import type { ToolResultMessage } from "xpi-ai/compat";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { createCodemodeExtension } from "../../src/extensions/codemode/index.ts";
import { createHarness, getToolResult, type Harness } from "./harness.ts";

function resultText(message: ToolResultMessage): string {
	return message.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
}

describe("path schemes in a session", () => {
	const harnesses: Harness[] = [];
	const notes = new Map<string, string>([["note://hello", "greetings\nfrom a virtual note\n"]]);

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		notes.set("note://hello", "greetings\nfrom a virtual note\n");
	});

	async function setup() {
		let tempDir = "";
		const harness = await createHarness({
			initialActiveToolNames: ["read", "edit", "write", "ls", "codemode"],
			extensionFactories: [
				createCodemodeExtension(),
				(pi: ExtensionAPI) => {
					pi.registerScheme("note", {
						describe: "a note, note://<name>",
						resolve: async (url) => {
							const content = notes.get(url);
							if (content === undefined) throw new Error(`no such note: ${url}`);
							return { content };
						},
						write: async (url, content) => {
							notes.set(url, content);
						},
					});
					pi.registerScheme("doc", {
						describe: "a project doc, doc://<name>",
						locate: async (url, ctx) => join(ctx.cwd, "docs", `${url.slice("doc://".length)}.md`),
					});
				},
			],
		});
		harnesses.push(harness);
		tempDir = harness.tempDir;
		mkdirSync(join(tempDir, "docs"));
		writeFileSync(join(tempDir, "docs", "a.md"), "alpha\n");
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

	it("lists registered schemes in the system prompt in registration order", async () => {
		const harness = await setup();
		const prompt = harness.session.systemPrompt;
		const note = prompt.indexOf("note:// — a note, note://<name>");
		const doc = prompt.indexOf("doc:// — a project doc, doc://<name>");
		expect(note).toBeGreaterThan(-1);
		expect(doc).toBeGreaterThan(note);
		expect(prompt).toContain("Bash does not understand them.");
	});

	it("reads, edits and writes a virtual note through the tools", async () => {
		const harness = await setup();
		const read = await call(harness, "read", { path: "note://hello" });
		expect(read.isError).toBe(false);
		expect(resultText(read)).toBe("greetings\nfrom a virtual note\n");

		const edit = await call(harness, "edit", {
			path: "note://hello",
			edits: [{ oldText: "greetings", newText: "hello" }],
		});
		expect(edit.isError).toBe(false);
		expect(notes.get("note://hello")).toBe("hello\nfrom a virtual note\n");

		const ls = await call(harness, "ls", { path: "note://hello" });
		expect(ls.isError).toBe(true);
		expect(resultText(ls)).toContain("note://hello is a virtual resource; use read");
	});

	it("reads a virtual URL from a codemode script, and edits it under the same guard", async () => {
		const harness = await setup();
		const script = await call(harness, "codemode", {
			code: 'const text = await tools.read({ path: "note://hello" });\nawait tools.edit({ path: "note://hello", edits: [{ oldText: "virtual", newText: "scripted" }] });\nreturn text;',
		});
		expect(script.isError).toBe(false);
		expect(resultText(script)).toContain("greetings\nfrom a virtual note");
		expect(notes.get("note://hello")).toBe("greetings\nfrom a scripted note\n");

		// A script edit of an unread resource fails like for a file.
		notes.set("note://other", "x\n");
		const unread = await call(harness, "codemode", {
			code: 'await tools.edit({ path: "note://other", edits: [{ oldText: "x", newText: "y" }] });',
		});
		expect(unread.isError).toBe(true);
		expect(resultText(unread)).toContain("Resource note://other has not been read in this session");
	});

	it("works on a file-backed scheme with the guard, from a script too", async () => {
		const harness = await setup();
		const path = join(harness.tempDir, "docs", "a.md");
		const refused = await call(harness, "edit", { path: "doc://a", edits: [{ oldText: "alpha", newText: "ALPHA" }] });
		expect(refused.isError).toBe(true);
		expect(resultText(refused)).toContain("has not been read in this session");

		const script = await call(harness, "codemode", {
			code: 'await tools.read({ path: "doc://a" });\nawait tools.edit({ path: "doc://a", edits: [{ oldText: "alpha", newText: "ALPHA" }] });',
		});
		expect(script.isError).toBe(false);
		expect(readFileSync(path, "utf-8")).toBe("ALPHA\n");
	});
});
