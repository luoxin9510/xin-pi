import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type GraphEntry, type RunningState, readState } from "xpi-graph";
import { blockedBy, limitsOf, type NodeLimits, readLimitsEnv } from "../src/extensions/graph/limits.ts";

const GRAPH = {
	name: "ship",
	start: "build",
	nodes: {
		build: { prompt: "Build.", deny: ["gh pr merge"], readOnly: ["docs/**"] },
		ci: { run: "run-ci" },
		review: { prompt: "Review.", deny: ["git push", "gh pr merge"] },
	},
	edges: [
		{ from: "build", to: "ci", exit: "model" },
		{ from: "ci", to: "review", exit: "pass" },
		{ from: "review", to: "end", exit: "model" },
	],
};

function stateAt(...nodes: string[]): RunningState {
	const entries: GraphEntry[] = [
		{
			type: "custom",
			customType: "graph.start",
			data: { graph: GRAPH, path: "/g/ship.js", selection: { provider: "p", id: "m", thinking: "off" } },
		},
		{ type: "custom", customType: "graph.node", data: { node: "build", via: "start" } },
		...nodes.map((node) => ({ type: "custom", customType: "graph.node", data: { node, via: "goto" } })),
	];
	const state = readState(entries);
	if (state.status !== "running") throw new Error("expected a running graph");
	return state;
}

describe("graph limits", () => {
	let root: string;
	let limits: NodeLimits;

	beforeEach(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "xpi-graph-limits-")));
		mkdirSync(join(root, ".pi", "graphs"), { recursive: true });
		mkdirSync(join(root, "docs"));
		writeFileSync(join(root, ".pi", "graphs", "ship.js"), "x");
		writeFileSync(join(root, "session.jsonl"), "x");
		limits = limitsOf(stateAt(), [join(root, ".pi", "graphs"), join(root, "session.jsonl")]);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	const write = (path: unknown, platform?: NodeJS.Platform) =>
		blockedBy(limits, { toolName: "write", effect: "write", input: { path } }, root, platform)?.rule;
	const bash = (command: unknown, toolName = "bash") =>
		blockedBy(limits, { toolName, effect: "exec", input: { command } }, root)?.rule;

	describe("limitsOf", () => {
		it("is the node's own lists on a model node", () => {
			expect(limitsOf(stateAt(), [])).toMatchObject({ node: "build", deny: ["gh pr merge"], readOnly: ["docs/**"] });
			expect(limitsOf(stateAt("review"), [])).toMatchObject({ deny: ["git push", "gh pr merge"], readOnly: [] });
		});

		it("is every node's deny, once each, and no readOnly on a command node", () => {
			expect(limitsOf(stateAt("ci"), ["/kept"])).toEqual({
				graph: "ship",
				node: "ci",
				deny: ["gh pr merge", "git push"],
				readOnly: [],
				protected: ["/kept"],
			});
		});
	});

	describe("deny", () => {
		it("blocks a shell command that contains the text, in bash and powershell", () => {
			expect(bash("gh pr merge 12")).toBe("deny: gh pr merge");
			expect(bash("cd repo && gh pr merge --squash")).toBe("deny: gh pr merge");
			expect(bash("gh pr merge", "powershell")).toBe("deny: gh pr merge");
		});

		it("lets other commands through, and is only a match on the text", () => {
			expect(bash("gh pr view 12")).toBeUndefined();
			expect(bash("git push")).toBeUndefined();
			// Not parsed: the same command written another way is not seen. The docs say so.
			expect(bash("gh pr  merge")).toBeUndefined();
		});

		it("does not look at a tool that is not a shell, or at a command that is not text", () => {
			expect(bash("gh pr merge", "read")).toBeUndefined();
			expect(bash(["gh pr merge"])).toBeUndefined();
			expect(bash(undefined)).toBeUndefined();
		});
	});

	describe("readOnly", () => {
		it("blocks a write to a matching path, however the path is spelled", () => {
			expect(write("docs/guide.md")).toBe("readOnly");
			expect(write("./docs/a/b.md")).toBe("readOnly");
			expect(write(join(root, "docs", "x.md"))).toBe("readOnly");
			expect(write("src/../docs/x.md")).toBe("readOnly");
		});

		it("blocks a write through a symlink into a matching path", () => {
			symlinkSync(join(root, "docs"), join(root, "manual"));
			expect(write("manual/x.md")).toBe("readOnly");
		});

		it("lets other paths through, and a read of a matching path", () => {
			expect(write("src/a.ts")).toBeUndefined();
			expect(
				blockedBy(limits, { toolName: "read", effect: "read", input: { path: "docs/guide.md" } }, root),
			).toBeUndefined();
		});

		it("skips a path that is not text, is empty, or has a scheme", () => {
			expect(write(["docs/guide.md"])).toBeUndefined();
			expect(write("")).toBeUndefined();
			expect(write("note://docs/guide.md")).toBeUndefined();
		});
	});

	describe("the graph files and the session file", () => {
		it("cannot be written while a graph runs: a file in a graph directory, a new one, the session file", () => {
			expect(write(".pi/graphs/ship.js")).toBe("graph files");
			expect(write(".pi/graphs/new.js")).toBe("graph files");
			expect(write(join(root, "session.jsonl"))).toBe("graph files");
			expect(write(".pi/settings.json")).toBeUndefined();
			// A sibling whose name only starts the same is not inside the directory.
			expect(write(".pi/graphs-old/x.js")).toBeUndefined();
		});

		it("are found whatever the case of the path where the file system ignores case", () => {
			expect(write(".PI/Graphs/ship.js", "darwin")).toBe("graph files");
			expect(write(".PI/Graphs/ship.js", "win32")).toBe("graph files");
			expect(write(".PI/Graphs/ship.js", "linux")).toBeUndefined();
		});
	});

	describe("readLimitsEnv", () => {
		it("reads what a parent left", () => {
			expect(readLimitsEnv(JSON.stringify(limits))).toEqual(limits);
		});

		it("is undefined for nothing, for text that is not JSON, and for a shape that is not the limits", () => {
			expect(readLimitsEnv(undefined)).toBeUndefined();
			expect(readLimitsEnv("")).toBeUndefined();
			expect(readLimitsEnv("{ not json")).toBeUndefined();
			expect(readLimitsEnv("null")).toBeUndefined();
			expect(readLimitsEnv(JSON.stringify({ ...limits, deny: "gh pr merge" }))).toBeUndefined();
			expect(readLimitsEnv(JSON.stringify({ ...limits, readOnly: [1] }))).toBeUndefined();
			expect(readLimitsEnv(JSON.stringify({ graph: "ship", node: "build" }))).toBeUndefined();
		});
	});
});
