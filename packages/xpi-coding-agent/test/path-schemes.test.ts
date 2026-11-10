import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import type { ExtensionContext, ExtensionFactory, SchemeHandler } from "../src/core/extensions/types.ts";
import { createAllTools, FileStateStore, SchemeResolver } from "../src/core/tools/index.ts";

/** Text of a tool result. */
function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((block) => block.text ?? "").join("\n");
}

describe("path schemes in the file tools", () => {
	let dir: string;
	let guard: boolean;
	let store: Map<string, string>;
	let writes: string[];

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "path-schemes-"));
		guard = true;
		store = new Map();
		writes = [];
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	/** A virtual scheme backed by `store`. */
	function memoryScheme(overrides: Partial<SchemeHandler> = {}): SchemeHandler {
		return {
			describe: "an in-memory note",
			resolve: async (url) => {
				const content = store.get(url);
				if (content === undefined) throw new Error(`no such note: ${url}`);
				return { content, contentType: "text/plain" };
			},
			write: async (url, content) => {
				writes.push(url);
				store.set(url, content);
			},
			...overrides,
		};
	}

	/** Load inline extensions into one runtime, as the session does, and build the tools over it. */
	async function setup(factories: Record<string, ExtensionFactory>) {
		const runtime = createExtensionRuntime();
		const bus = createEventBus();
		for (const [path, factory] of Object.entries(factories)) {
			await loadExtensionFromFactory(factory, dir, bus, runtime, path);
		}
		const schemes = new SchemeResolver(runtime.schemes, () => ({ cwd: dir }) as ExtensionContext);
		const fileState = new FileStateStore(() => guard);
		const tools = createAllTools(dir, { fileState, schemes });
		return {
			runtime,
			read: (path: string, extra: { offset?: number; limit?: number } = {}) =>
				tools.read.execute("r", { path, ...extra }),
			write: (path: string, content: string) => tools.write.execute("w", { path, content }),
			edit: (path: string, oldText: string, newText: string) =>
				tools.edit.execute("e", { path, edits: [{ oldText, newText }] }),
			grep: (path: string) => tools.grep.execute("g", { pattern: "x", path }),
			find: (path: string) => tools.find.execute("f", { pattern: "*", path }),
			ls: (path: string) => tools.ls.execute("l", { path }),
		};
	}

	const longContent = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join("\n");

	describe("virtual scheme", () => {
		it("reads with the same offset and limit as a file", async () => {
			store.set("note://a", "one\ntwo\nthree\nfour\nfive");
			const t = await setup({ ext: (pi) => pi.registerScheme("note", memoryScheme()) });

			expect(text(await t.read("note://a"))).toBe("one\ntwo\nthree\nfour\nfive");
			expect(text(await t.read("note://a", { offset: 2, limit: 2 }))).toBe(
				"two\nthree\n\n[2 more lines in file. Use offset=4 to continue.]",
			);
			await expect(t.read("note://a", { offset: 9 })).rejects.toThrow("Offset 9 is beyond end of file");
		});

		it("truncates long content with a continuation hint and never suggests sed", async () => {
			store.set("note://long", longContent);
			const t = await setup({ ext: (pi) => pi.registerScheme("note", memoryScheme()) });

			const first = text(await t.read("note://long"));
			expect(first).toContain("line 1\n");
			expect(first).toContain("[Showing lines 1-2000 of 3000. Use offset=2001 to continue.]");
			const rest = text(await t.read("note://long", { offset: 2001 }));
			expect(rest).toContain("line 3000");
			expect(rest).not.toContain("Showing");
			expect(first).not.toMatch(/sed|bash/);
		});

		it("says a single line over the byte limit cannot be shown, without a bash hint", async () => {
			store.set("note://wide", "x".repeat(60 * 1024));
			const t = await setup({ ext: (pi) => pi.registerScheme("note", memoryScheme()) });
			const out = text(await t.read("note://wide"));
			expect(out).toContain("Line 1 is 60.0KB, exceeds 50.0KB limit and cannot be shown");
			expect(out).not.toMatch(/sed|bash/);
		});

		it("reports a resolve failure as the tool error", async () => {
			const t = await setup({ ext: (pi) => pi.registerScheme("note", memoryScheme()) });
			await expect(t.read("note://missing")).rejects.toThrow("no such note: note://missing");
		});

		it("writes through the handler, creating a resource that does not exist yet", async () => {
			const t = await setup({ ext: (pi) => pi.registerScheme("note", memoryScheme()) });
			const result = await t.write("note://new", "hello\n");
			expect(text(result)).toBe("Successfully wrote to note://new");
			expect(store.get("note://new")).toBe("hello\n");
			expect(writes).toEqual(["note://new"]);
		});

		it("serializes writes to one URL and lets different URLs run in parallel", async () => {
			const events: string[] = [];
			const gates = new Map<string, () => void>();
			const handler = memoryScheme({
				write: async (url, content) => {
					events.push(`start ${url} ${content}`);
					await new Promise<void>((resolve) => gates.set(`${url} ${content}`, resolve));
					events.push(`end ${url} ${content}`);
				},
			});
			const t = await setup({ ext: (pi) => pi.registerScheme("note", handler) });

			const first = t.write("note://a", "1");
			const second = t.write("note://a", "2");
			const other = t.write("note://b", "1");
			await new Promise((resolve) => setTimeout(resolve, 50));
			// Same URL: the second write waits; the other URL started.
			expect(events).toEqual(["start note://a 1", "start note://b 1"]);
			gates.get("note://a 1")?.();
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(events).toContain("start note://a 2");
			gates.get("note://a 2")?.();
			gates.get("note://b 1")?.();
			await Promise.all([first, second, other]);
			expect(events.indexOf("end note://a 1")).toBeLessThan(events.indexOf("start note://a 2"));
		});

		it("edits after a read, through resolve and write", async () => {
			store.set("note://a", "alpha\nbeta\n");
			const t = await setup({ ext: (pi) => pi.registerScheme("note", memoryScheme()) });
			await t.read("note://a");
			const result = await t.edit("note://a", "alpha", "ALPHA");
			expect(text(result)).toBe("Successfully replaced 1 block(s) in note://a.");
			expect(store.get("note://a")).toBe("ALPHA\nbeta\n");
			// The edit counts as seen: another edit needs no new read.
			await t.edit("note://a", "beta", "BETA");
			expect(store.get("note://a")).toBe("ALPHA\nBETA\n");
		});

		it("keys the stale-edit guard by URL: unread, then changed after the read", async () => {
			store.set("note://a", "alpha\n");
			store.set("note://b", "other\n");
			const t = await setup({ ext: (pi) => pi.registerScheme("note", memoryScheme()) });

			await expect(t.edit("note://a", "alpha", "x")).rejects.toThrow(
				"Resource note://a has not been read in this session. Read it before editing.",
			);
			await t.read("note://a");
			// A read of another URL does not count.
			await expect(t.edit("note://b", "other", "x")).rejects.toThrow("Resource note://b has not been read");
			store.set("note://a", "alpha\nchanged elsewhere\n");
			await expect(t.edit("note://a", "alpha", "x")).rejects.toThrow(
				"Resource note://a changed since you last read it. Read it again before editing.",
			);
			expect(store.get("note://a")).toBe("alpha\nchanged elsewhere\n");
			await t.read("note://a");
			await t.edit("note://a", "alpha", "ALPHA");
			expect(store.get("note://a")).toBe("ALPHA\nchanged elsewhere\n");
		});

		it("guards an overwrite of an existing resource but not the creation of a new one", async () => {
			store.set("note://a", "alpha\n");
			const t = await setup({ ext: (pi) => pi.registerScheme("note", memoryScheme()) });
			await expect(t.write("note://a", "x")).rejects.toThrow(
				"Resource note://a has not been read in this session. Read it before overwriting it.",
			);
			await t.read("note://a");
			await t.write("note://a", "rewritten\n");
			// A write counts as seen.
			await t.edit("note://a", "rewritten", "again");
			expect(store.get("note://a")).toBe("again\n");
			await t.write("note://fresh", "new");
		});

		it("skips the guard when staleEditGuard is off", async () => {
			store.set("note://a", "alpha\n");
			guard = false;
			const t = await setup({ ext: (pi) => pi.registerScheme("note", memoryScheme()) });
			await t.edit("note://a", "alpha", "ALPHA");
			expect(store.get("note://a")).toBe("ALPHA\n");
		});

		it("refuses write and edit on a readOnly scheme and on one without write", async () => {
			store.set("ro://a", "alpha\n");
			store.set("nw://a", "alpha\n");
			const t = await setup({
				one: (pi) => pi.registerScheme("ro", memoryScheme({ readOnly: true })),
				two: (pi) => pi.registerScheme("nw", memoryScheme({ write: undefined })),
			});
			for (const scheme of ["ro", "nw"]) {
				await t.read(`${scheme}://a`);
				await expect(t.edit(`${scheme}://a`, "alpha", "x")).rejects.toThrow(`${scheme}:// is read-only`);
				await expect(t.write(`${scheme}://a`, "x")).rejects.toThrow(`${scheme}:// is read-only`);
			}
			expect(store.get("ro://a")).toBe("alpha\n");
			expect(writes).toEqual([]);
		});

		it("refuses grep, find and ls and points at read", async () => {
			store.set("note://a", "alpha\n");
			const t = await setup({ ext: (pi) => pi.registerScheme("note", memoryScheme()) });
			for (const run of [t.grep, t.find, t.ls]) {
				await expect(run("note://a")).rejects.toThrow("note://a is a virtual resource; use read");
			}
		});
	});

	describe("file-backed scheme", () => {
		function fileScheme(overrides: Partial<SchemeHandler> = {}): SchemeHandler {
			return {
				describe: "a doc file",
				locate: async (url) => join(dir, "docs", `${url.slice("doc://".length)}.md`),
				...overrides,
			};
		}

		beforeEach(() => {
			mkdirSync(join(dir, "docs"));
			writeFileSync(join(dir, "docs", "a.md"), "alpha\nbeta\n");
			writeFileSync(join(dir, "docs", "b.md"), "needle in b\n");
		});

		it("reads and edits the located file with the stale-edit guard", async () => {
			const t = await setup({ ext: (pi) => pi.registerScheme("doc", fileScheme()) });
			expect(text(await t.read("doc://a"))).toBe("alpha\nbeta\n");
			await t.edit("doc://a", "alpha", "ALPHA");
			expect(readFileSync(join(dir, "docs", "a.md"), "utf-8")).toBe("ALPHA\nbeta\n");

			writeFileSync(join(dir, "docs", "a.md"), "ALPHA\nbeta\nchanged elsewhere\n");
			await expect(t.edit("doc://a", "beta", "BETA")).rejects.toThrow(
				"File doc://a changed since you last read it. Read it again before editing.",
			);
		});

		it("shares the guard with plain paths to the same file", async () => {
			const t = await setup({ ext: (pi) => pi.registerScheme("doc", fileScheme()) });
			await t.read("docs/a.md");
			await t.edit("doc://a", "alpha", "ALPHA");
			expect(readFileSync(join(dir, "docs", "a.md"), "utf-8")).toBe("ALPHA\nbeta\n");
			await expect(t.edit("doc://b", "needle", "x")).rejects.toThrow("has not been read in this session");
		});

		it("writes the located file, creating it when missing", async () => {
			const t = await setup({ ext: (pi) => pi.registerScheme("doc", fileScheme()) });
			await t.write("doc://c", "new file\n");
			expect(readFileSync(join(dir, "docs", "c.md"), "utf-8")).toBe("new file\n");
		});

		it("lets grep, find and ls work on the located path", async () => {
			const t = await setup({
				ext: (pi) => pi.registerScheme("doc", fileScheme({ locate: async () => join(dir, "docs") })),
			});
			expect(text(await t.ls("doc://anything"))).toBe("a.md\nb.md");
			expect(text(await t.grep("doc://anything"))).toContain("No matches");
			expect(text(await t.find("doc://anything"))).toBe("a.md\nb.md");
		});

		it("refuses write and edit when the scheme is readOnly, still reading", async () => {
			const t = await setup({ ext: (pi) => pi.registerScheme("doc", fileScheme({ readOnly: true })) });
			expect(text(await t.read("doc://a"))).toBe("alpha\nbeta\n");
			await expect(t.edit("doc://a", "alpha", "x")).rejects.toThrow("doc:// is read-only");
			await expect(t.write("doc://a", "x")).rejects.toThrow("doc:// is read-only");
			expect(readFileSync(join(dir, "docs", "a.md"), "utf-8")).toBe("alpha\nbeta\n");
		});

		it("rejects a relative located path", async () => {
			const t = await setup({
				ext: (pi) => pi.registerScheme("doc", fileScheme({ locate: async () => "docs/a.md" })),
			});
			await expect(t.read("doc://a")).rejects.toThrow("locate() must return an absolute path");
		});
	});

	it("leaves unregistered schemes alone: the path stays a relative file path", async () => {
		mkdirSync(join(dir, "x:"));
		writeFileSync(join(dir, "x:", "file.txt"), "plain\n");
		const t = await setup({ ext: (pi) => pi.registerScheme("note", memoryScheme()) });
		expect(text(await t.read("x://file.txt"))).toBe("plain\n");
		await expect(t.read("y://nothing")).rejects.toThrow(/ENOENT|not found/i);
	});

	describe("registration", () => {
		const handler = (): SchemeHandler => memoryScheme();

		it("rejects reserved names", async () => {
			for (const name of ["http", "https", "file", "data"]) {
				await expect(setup({ ext: (pi) => pi.registerScheme(name, handler()) })).rejects.toThrow(
					`scheme name "${name}" is reserved`,
				);
			}
		});

		it("rejects invalid names", async () => {
			for (const name of ["", "Note", "1note", "no_te", "a b", "a:b"]) {
				await expect(setup({ ext: (pi) => pi.registerScheme(name, handler()) })).rejects.toThrow(/Invalid scheme/);
			}
			// Accepted characters.
			await setup({ ext: (pi) => pi.registerScheme("a1+.-z", handler()) });
		});

		it("names both extensions when a name is taken", async () => {
			await expect(
				setup({
					"first-ext": (pi) => pi.registerScheme("note", handler()),
					"second-ext": (pi) => pi.registerScheme("note", handler()),
				}),
			).rejects.toThrow(
				'Scheme "note" registered by extension "second-ext" is already registered by extension "first-ext"',
			);
		});

		it("rejects the same name twice from one extension", async () => {
			await expect(
				setup({
					ext: (pi) => {
						pi.registerScheme("note", handler());
						pi.registerScheme("note", handler());
					},
				}),
			).rejects.toThrow('Scheme "note" registered by extension "ext" is already registered by extension "ext"');
		});

		it("does not keep the schemes of an extension that failed to load", async () => {
			const runtime = createExtensionRuntime();
			const bus = createEventBus();
			await expect(
				loadExtensionFromFactory(
					(pi) => {
						pi.registerScheme("note", handler());
						throw new Error("boom");
					},
					dir,
					bus,
					runtime,
					"broken",
				),
			).rejects.toThrow("boom");
			expect(runtime.schemes.list()).toEqual([]);
			await loadExtensionFromFactory((pi) => pi.registerScheme("note", handler()), dir, bus, runtime, "good");
			expect(runtime.schemes.list().map((scheme) => scheme.extensionPath)).toEqual(["good"]);
		});

		it("requires exactly one of resolve and locate", async () => {
			const both = { describe: "d", resolve: async () => ({ content: "" }), locate: async () => "/x" };
			const neither = { describe: "d" };
			for (const bad of [both, neither]) {
				await expect(setup({ ext: (pi) => pi.registerScheme("note", bad) })).rejects.toThrow(
					"set exactly one of resolve (virtual) and locate (file-backed)",
				);
			}
		});

		it("validates the other handler fields", async () => {
			const cases: Array<[SchemeHandler, string]> = [
				[{ ...handler(), describe: "" }, "describe must be a non-empty single line"],
				[{ ...handler(), describe: "two\nlines" }, "describe must be a non-empty single line"],
				[{ ...handler(), write: "no" as unknown as SchemeHandler["write"] }, "write must be a function"],
				[{ describe: "d", locate: async () => "/x", write: async () => {} }, "write is for virtual schemes"],
				[{ ...handler(), readOnly: "yes" as unknown as boolean }, "readOnly must be a boolean"],
				[null as unknown as SchemeHandler, "the handler must be an object"],
			];
			for (const [bad, message] of cases) {
				await expect(setup({ ext: (pi) => pi.registerScheme("note", bad) })).rejects.toThrow(message);
			}
		});

		it("lists registered schemes in registration order", async () => {
			const t = await setup({
				one: (pi) => pi.registerScheme("zeta", handler()),
				two: (pi) => {
					pi.registerScheme("alpha", handler());
					pi.registerScheme("mid", handler());
				},
			});
			expect(t.runtime.schemes.list().map((scheme) => scheme.name)).toEqual(["zeta", "alpha", "mid"]);
		});
	});
});
