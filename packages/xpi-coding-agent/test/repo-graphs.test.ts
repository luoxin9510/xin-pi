// The two graphs this repository keeps for its own work, `.pi/graphs/dev.js` and `.pi/graphs/release.js`: they load,
// they pass the checks, and the checks do refuse them when a control is taken out.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkGraph, type Graph, GraphError, parseGraph } from "xpi-graph";
import { parseGraphText } from "../src/extensions/graph/files.ts";

interface RawGraph {
	name: string;
	start: string;
	nodes: Record<string, Record<string, unknown>>;
	edges: { from: string; to: string; exit: string; max?: number }[];
	requires: Record<string, unknown>[];
}

/** The literal of a graph file of this repository, as a fresh object a test may change. */
function literal(name: string): RawGraph {
	const path = fileURLToPath(new URL(`../../../.pi/graphs/${name}.js`, import.meta.url));
	return parseGraphText(readFileSync(path, "utf8")) as RawGraph;
}

const load = (raw: RawGraph): Graph => checkGraph(parseGraph(raw));

function problems(raw: RawGraph): string[] {
	try {
		load(raw);
	} catch (error) {
		if (error instanceof GraphError) return error.problems.map((problem) => `${problem.at}: ${problem.message}`);
		throw error;
	}
	return [];
}

const kinds = (graph: Graph) => Object.fromEntries(Object.entries(graph.nodes).map(([id, node]) => [id, node.kind]));

describe("the repository's own graphs", () => {
	describe("dev", () => {
		it("loads and passes the checks", () => {
			const graph = load(literal("dev"));
			expect(graph.name).toBe("dev");
			expect(kinds(graph)).toEqual({
				grill: "model",
				spec: "model",
				build: "model",
				ci: "command",
				review: "model",
				merge: "command",
			});
		});

		it("lets no model node run the merge or push to main", () => {
			const graph = load(literal("dev"));
			for (const id of ["build", "review"]) {
				const node = graph.nodes[id];
				expect(node.kind === "model" && node.deny).toContain("gh pr merge");
			}
			const build = graph.nodes.build;
			expect(build.kind === "model" && build.deny).toContain("git push origin main");
		});

		it("is refused without its ci node", () => {
			const raw = literal("dev");
			delete raw.nodes.ci;
			raw.edges = raw.edges.filter((edge) => edge.from !== "ci" && edge.to !== "ci");
			raw.edges.push({ from: "build", to: "review", exit: "model" });
			expect(problems(raw)).toEqual(['requires[0].passed: no node "ci"']);
		});

		it("is refused with an edge from build straight to the merge, and the message shows the path", () => {
			const raw = literal("dev");
			raw.edges.push({ from: "build", to: "merge", exit: "model" });
			expect(problems(raw)).toEqual([
				'requires[0]: "merge" can be reached without a pass of "ci": grill -> spec -> build -> merge',
				'requires[0]: "merge" can be reached from "build" with no pass of "ci" after it: build -> merge',
			]);
		});

		it("is refused when the review may change code and merge without another check", () => {
			const raw = literal("dev");
			raw.nodes.patch = { prompt: "Make the small fixes the review asked for." };
			raw.edges.push({ from: "review", to: "patch", exit: "model" }, { from: "patch", to: "merge", exit: "model" });
			raw.requires = [{ before: "merge", passed: "ci", notAfter: ["build", "patch"] }];
			expect(problems(raw)).toEqual([
				'requires[0]: "merge" can be reached from "patch" with no pass of "ci" after it: patch -> merge',
			]);
		});

		it("limits its loops", () => {
			const graph = load(literal("dev"));
			const max = (from: string, to: string) =>
				graph.edges.find((edge) => edge.from === from && edge.to === to)?.max;
			expect(max("ci", "build")).toBe(3);
			expect(max("review", "build")).toBe(3);
			// Not set in the file: an edge on a loop gets the default.
			expect(max("build", "ci")).toBe(3);
			expect(max("grill", "spec")).toBeUndefined();
		});
	});

	describe("release", () => {
		it("loads and passes the checks", () => {
			const graph = load(literal("release"));
			expect(graph.name).toBe("release");
			expect(Object.keys(graph.nodes)).toEqual([
				"plan",
				"patch",
				"minor",
				"ci",
				"fix",
				"review",
				"merge",
				"sync",
				"main-ci",
				"tag",
				"done",
			]);
		});

		it("runs the bump, the merge and the tag itself, and asks before the bump and the merge", () => {
			const graph = load(literal("release"));
			for (const id of ["patch", "minor", "merge", "sync", "tag"]) expect(graph.nodes[id].kind).toBe("command");
			const exitInto = (to: string) => graph.edges.filter((edge) => edge.to === to).map((edge) => edge.exit);
			expect(exitInto("patch")).toEqual(["approve"]);
			expect(exitInto("minor")).toEqual(["approve"]);
			expect(exitInto("merge")).toEqual(["approve"]);
			expect(exitInto("tag")).toEqual(["pass"]);
		});

		it("lets no model node publish to npm or tag", () => {
			const graph = load(literal("release"));
			for (const [id, node] of Object.entries(graph.nodes)) {
				if (node.kind !== "model") continue;
				expect(node.deny, id).toContain("npm publish");
			}
		});

		it("is refused when the tag can be reached without the merge", () => {
			const raw = literal("release");
			raw.edges.push({ from: "review", to: "tag", exit: "model" });
			expect(
				problems(raw).some((problem) => problem.includes('"tag" can be reached without a pass of "merge"')),
			).toBe(true);
		});

		it("is refused when a fix can reach the merge without another check", () => {
			const raw = literal("release");
			raw.edges.push({ from: "fix", to: "merge", exit: "approve" });
			expect(problems(raw)).toContain(
				'requires[0]: "merge" can be reached from "fix" with no pass of "ci" after it: fix -> merge',
			);
		});
	});
});
