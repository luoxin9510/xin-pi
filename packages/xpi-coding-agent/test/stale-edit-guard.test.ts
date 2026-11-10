import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAllTools, createEditTool, FileStateStore } from "../src/core/tools/index.ts";

const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

describe("stale-edit guard", () => {
	let dir: string;
	let enabled: boolean;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "stale-edit-guard-"));
		enabled = true;
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function createTools() {
		const fileState = new FileStateStore(() => enabled);
		const tools = createAllTools(dir, { fileState });
		return {
			read: (path: string, extra: { offset?: number; limit?: number } = {}) =>
				tools.read.execute("r", { path, ...extra }),
			edit: (path: string, oldText: string, newText: string) =>
				tools.edit.execute("e", { path, edits: [{ oldText, newText }] }),
			write: (path: string, content: string) => tools.write.execute("w", { path, content }),
		};
	}

	const file = (name: string) => join(dir, name);
	const NOT_READ = (name: string) => `File ${name} has not been read in this session. Read it before editing.`;
	const CHANGED = (name: string) => `File ${name} changed since you last read it. Read it again before editing.`;

	it("refuses to edit a file that was not read", async () => {
		const t = createTools();
		writeFileSync(file("a.txt"), "alpha\n");
		await expect(t.edit("a.txt", "alpha", "ALPHA")).rejects.toThrow(NOT_READ("a.txt"));
		expect(readFileSync(file("a.txt"), "utf-8")).toBe("alpha\n");
	});

	it("refuses to edit a file that changed after the read, even when the old text still matches", async () => {
		const t = createTools();
		writeFileSync(file("a.txt"), "alpha\nbeta\n");
		await t.read("a.txt");
		writeFileSync(file("a.txt"), "alpha\nbeta\ngamma\n");
		await expect(t.edit("a.txt", "alpha", "ALPHA")).rejects.toThrow(CHANGED("a.txt"));
		expect(readFileSync(file("a.txt"), "utf-8")).toBe("alpha\nbeta\ngamma\n");

		// Reading again clears it.
		await t.read("a.txt");
		await t.edit("a.txt", "alpha", "ALPHA");
		expect(readFileSync(file("a.txt"), "utf-8")).toBe("ALPHA\nbeta\ngamma\n");
	});

	it("lets consecutive edits and an edit followed by a write pass without another read", async () => {
		const t = createTools();
		writeFileSync(file("a.txt"), "one\ntwo\n");
		await t.read("a.txt");
		await t.edit("a.txt", "one", "1");
		await t.edit("a.txt", "two", "2");
		await t.write("a.txt", "rewritten\n");
		await t.edit("a.txt", "rewritten", "again");
		expect(readFileSync(file("a.txt"), "utf-8")).toBe("again\n");
	});

	it("ignores trailing spaces, tabs and CR when comparing", async () => {
		const t = createTools();
		writeFileSync(file("a.txt"), "alpha  \nbeta\n");
		await t.read("a.txt");
		writeFileSync(file("a.txt"), "alpha\r\nbeta\t\n");
		await t.edit("a.txt", "beta", "BETA");
		expect(readFileSync(file("a.txt"), "utf-8")).toBe("alpha\r\nBETA\t\n");

		// A change to the text itself still counts.
		writeFileSync(file("a.txt"), "alphaX\r\nBETA\t\n");
		await expect(t.edit("a.txt", "BETA", "beta")).rejects.toThrow(CHANGED("a.txt"));
	});

	it("refuses to overwrite an existing file that was not read or that changed, and lets a new file be created", async () => {
		const t = createTools();
		writeFileSync(file("a.txt"), "keep me\n");
		await expect(t.write("a.txt", "x")).rejects.toThrow(NOT_READ("a.txt"));
		await t.read("a.txt");
		writeFileSync(file("a.txt"), "someone else\n");
		await expect(t.write("a.txt", "x")).rejects.toThrow(CHANGED("a.txt"));
		expect(readFileSync(file("a.txt"), "utf-8")).toBe("someone else\n");

		await t.write("sub/new.txt", "fresh\n");
		expect(readFileSync(file("sub/new.txt"), "utf-8")).toBe("fresh\n");
		// A file the session created counts as read.
		await t.edit("sub/new.txt", "fresh", "stale");
	});

	it("counts a paged read as a read of the whole file", async () => {
		const t = createTools();
		const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
		writeFileSync(file("big.txt"), `${lines.join("\n")}\n`);
		await t.read("big.txt", { offset: 10, limit: 5 });
		await t.edit("big.txt", "line 40", "LINE 40");
		expect(readFileSync(file("big.txt"), "utf-8")).toContain("LINE 40");
		// A change outside the paged range is still a change.
		writeFileSync(file("big.txt"), `${lines.join("\n")}\nextra\n`);
		await expect(t.edit("big.txt", "line 41", "x")).rejects.toThrow(CHANGED("big.txt"));
	});

	it("does not count an image read", async () => {
		const t = createTools();
		writeFileSync(file("pixel.png"), Buffer.from(TINY_PNG_BASE64, "base64"));
		await t.read("pixel.png");
		await expect(t.write("pixel.png", "not an image")).rejects.toThrow(NOT_READ("pixel.png"));
	});

	it("keeps one store per set of tools", async () => {
		const first = createTools();
		const second = createTools();
		writeFileSync(file("a.txt"), "alpha\n");
		await first.read("a.txt");
		await expect(second.edit("a.txt", "alpha", "ALPHA")).rejects.toThrow(NOT_READ("a.txt"));
	});

	it("checks nothing when the store is off, and starts clean when turned on again", async () => {
		const t = createTools();
		writeFileSync(file("a.txt"), "alpha\n");
		enabled = false;
		await t.edit("a.txt", "alpha", "ALPHA");
		await t.write("a.txt", "rewritten\n");
		expect(readFileSync(file("a.txt"), "utf-8")).toBe("rewritten\n");
		enabled = true;
		await expect(t.edit("a.txt", "rewritten", "x")).rejects.toThrow(NOT_READ("a.txt"));
	});

	it("leaves a tool created alone, without a store, unguarded", async () => {
		writeFileSync(file("a.txt"), "alpha\n");
		await createEditTool(dir).execute("e", { path: "a.txt", edits: [{ oldText: "alpha", newText: "ALPHA" }] });
		expect(readFileSync(file("a.txt"), "utf-8")).toBe("ALPHA\n");
	});
});
