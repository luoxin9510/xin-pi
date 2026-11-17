import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverGraphs, graphDirs, parseGraphText, readGraphFile } from "../src/extensions/graph/files.ts";

const GRAPH = (name: string) =>
	`export default { name: "${name}", start: "a", nodes: { a: { prompt: "A" } }, edges: [{ from: "a", to: "end", exit: "model" }] };\n`;

describe("graph files", () => {
	let root: string;
	let agentDir: string;

	beforeEach(() => {
		// The real path: on macOS the temp directory is behind a symlink.
		root = realpathSync(mkdtempSync(join(tmpdir(), "xpi-graph-files-")));
		agentDir = join(root, "agent");
		mkdirSync(join(root, "repo", ".git"), { recursive: true });
		mkdirSync(join(root, "repo", "packages", "app"), { recursive: true });
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	const write = (dir: string, name: string, text = GRAPH(name.replace(/\.js$/, ""))) => {
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, name), text);
	};

	describe("parseGraphText", () => {
		it("reads a literal with comments, bare keys, any quotes and trailing commas", () => {
			const text = `// The dev flow.
/* Kept as data. */
export default {
	name: 'dev', // the file name
	start: "a",
	nodes: { a: { prompt: \`Do it.\`, }, },
	edges: [{ from: "a", to: "end", exit: "model", max: 2 },],
};
// The end.
`;
			expect(parseGraphText(text)).toEqual({
				name: "dev",
				start: "a",
				nodes: { a: { prompt: "Do it." } },
				edges: [{ from: "a", to: "end", exit: "model", max: 2 }],
			});
		});

		it("refuses a file that does not start with export default", () => {
			expect(() => parseGraphText('const graph = { name: "dev" };\nexport default graph;\n')).toThrow(
				/the first statement must be `export default/,
			);
			expect(() => parseGraphText('export const meta = { name: "dev" };\n')).toThrow(/the first statement must be/);
		});

		it("refuses code: a call, an identifier, a template expression", () => {
			expect(() => parseGraphText("export default buildGraph();\n")).toThrow(/not a plain literal/);
			expect(() => parseGraphText('export default { name: NAME, start: "a" };\n')).toThrow(/not a plain literal/);
			// The template is written without a literal dollar-brace in this file's own source.
			const template = `export default { name: \`dev-${"$"}{process.pid}\` };\n`;
			expect(() => parseGraphText(template)).toThrow(/template expressions are not allowed/);
		});

		it("refuses anything after the literal: a graph file is data, not a script", () => {
			expect(() => parseGraphText('export default { name: "dev" };\nconsole.log("loaded");\n')).toThrow(
				/nothing may follow the graph/,
			);
		});
	});

	describe("discoverGraphs", () => {
		it("finds the project's graphs from the cwd up to the repository root, then the user's", () => {
			const cwd = join(root, "repo", "packages", "app");
			write(join(cwd, ".pi", "graphs"), "near.js");
			write(join(root, "repo", ".pi", "graphs"), "top.js");
			write(join(agentDir, "graphs"), "mine.js");
			// Outside the repository: not a project directory.
			write(join(root, ".pi", "graphs"), "outside.js");
			expect(discoverGraphs(cwd, true, agentDir)).toEqual([
				{ name: "near", path: join(cwd, ".pi", "graphs", "near.js"), source: "project" },
				{ name: "top", path: join(root, "repo", ".pi", "graphs", "top.js"), source: "project" },
				{ name: "mine", path: join(agentDir, "graphs", "mine.js"), source: "user" },
			]);
		});

		it("lets the closer directory win a name, and the project win over the user", () => {
			const cwd = join(root, "repo", "packages", "app");
			write(join(cwd, ".pi", "graphs"), "dev.js");
			write(join(root, "repo", ".pi", "graphs"), "dev.js");
			write(join(agentDir, "graphs"), "dev.js");
			expect(discoverGraphs(cwd, true, agentDir)).toEqual([
				{ name: "dev", path: join(cwd, ".pi", "graphs", "dev.js"), source: "project" },
			]);
		});

		it("reads no project directory in a project that is not trusted", () => {
			const cwd = join(root, "repo");
			write(join(cwd, ".pi", "graphs"), "dev.js");
			write(join(agentDir, "graphs"), "mine.js");
			expect(discoverGraphs(cwd, false, agentDir).map((file) => file.name)).toEqual(["mine"]);
			expect(graphDirs(cwd, false, agentDir)).toEqual([{ dir: join(agentDir, "graphs"), source: "user" }]);
		});

		it("skips what is not a graph file: another extension, a bad name, a directory", () => {
			const dir = join(root, "repo", ".pi", "graphs");
			write(dir, "dev.js");
			write(dir, "notes.md", "# notes\n");
			write(dir, "Bad Name.js");
			mkdirSync(join(dir, "folder.js"));
			expect(discoverGraphs(join(root, "repo"), true, agentDir).map((file) => file.name)).toEqual(["dev"]);
		});

		it("lists a file without reading it: a broken file is found, and fails only when it is read", () => {
			const dir = join(root, "repo", ".pi", "graphs");
			write(dir, "broken.js", "export default buildGraph();\n");
			const [file] = discoverGraphs(join(root, "repo"), true, agentDir);
			expect(file.name).toBe("broken");
			expect(() => readGraphFile(file)).toThrow(/not a plain literal/);
		});
	});

	describe("readGraphFile", () => {
		it("returns the literal to store and the checked graph to run", () => {
			const dir = join(root, "repo", ".pi", "graphs");
			write(dir, "dev.js");
			const [file] = discoverGraphs(join(root, "repo"), true, agentDir);
			const { literal, graph } = readGraphFile(file);
			expect(literal).toEqual({
				name: "dev",
				start: "a",
				nodes: { a: { prompt: "A" } },
				edges: [{ from: "a", to: "end", exit: "model" }],
			});
			expect(graph.nodes.a).toEqual({ kind: "model", prompt: "A", deny: [], readOnly: [] });
		});

		it("refuses a graph whose name is not the file's, and one that fails the checks", () => {
			const dir = join(root, "repo", ".pi", "graphs");
			write(dir, "dev.js", GRAPH("other"));
			write(
				dir,
				"loop.js",
				'export default { name: "loop", start: "a", nodes: { a: { prompt: "A" } }, edges: [{ from: "a", to: "a", exit: "model" }] };\n',
			);
			const files = discoverGraphs(join(root, "repo"), true, agentDir);
			expect(() => readGraphFile(files[0])).toThrow(/name "other" differs from the file name "dev"/);
			expect(() => readGraphFile(files[1])).toThrow(/"end" cannot be reached from "a"/);
		});
	});
});
