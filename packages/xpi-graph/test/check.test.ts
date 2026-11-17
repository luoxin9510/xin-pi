import { describe, expect, it } from "vitest";
import { checkGraph, DEFAULT_LOOP_MAX, GraphError, parseGraph } from "../src/index.ts";
import { devGraph, EDGE, type RawGraph } from "./graphs.ts";

/** The problems `checkGraph` reports for the dev graph after a change, as `place: message`. */
function problemsOf(change: (raw: RawGraph) => void): string[] {
	const raw = devGraph();
	change(raw);
	try {
		checkGraph(parseGraph(raw));
	} catch (error) {
		if (error instanceof GraphError) return error.problems.map((problem) => `${problem.at}: ${problem.message}`);
		throw error;
	}
	return [];
}

describe("checkGraph", () => {
	it("passes the dev graph", () => {
		expect(problemsOf(() => {})).toEqual([]);
	});

	describe("names", () => {
		it("refuses a start that is not a node", () => {
			expect(problemsOf((raw) => Object.assign(raw, { start: "plan" }))).toEqual(['start: no node "plan"']);
		});

		it("refuses an edge from or to a node that does not exist, with the place", () => {
			expect(
				problemsOf((raw) => {
					raw.edges[EDGE.ciPass].to = "revieww";
					raw.edges[EDGE.built].from = "biuld";
				}),
			).toEqual(['edges[1].from: no node "biuld"', 'edges[2].to: no node "revieww"']);
		});

		it("refuses an edge out of end", () => {
			expect(problemsOf((raw) => raw.edges.push({ from: "end", to: "grill", exit: "model" }))).toEqual([
				'edges[7].from: "end" has no edges out',
			]);
		});
	});

	describe("exits", () => {
		it("refuses a pass or fail edge out of a model node", () => {
			expect(problemsOf((raw) => Object.assign(raw.edges[EDGE.built], { exit: "pass" }))).toEqual([
				'edges[1].exit: "build" is a model node: its exits are model and approve',
			]);
		});

		it("refuses a model or approve edge out of a command node", () => {
			expect(problemsOf((raw) => Object.assign(raw.edges[EDGE.ciPass], { exit: "approve" }))).toEqual([
				'edges[2].exit: "ci" is a command node: its exits are pass and fail',
			]);
		});

		it("refuses two edges of a model node to the same node", () => {
			expect(problemsOf((raw) => raw.edges.push({ from: "review", to: "merge", exit: "approve" }))).toEqual([
				'edges[7]: "review" already has an edge to "merge" (edges[4])',
			]);
		});

		it("refuses two pass edges of a command node", () => {
			expect(problemsOf((raw) => raw.edges.push({ from: "ci", to: "merge", exit: "pass" }))).toEqual([
				'edges[7]: "ci" already has a pass edge (edges[2])',
			]);
		});

		it("allows a command node with no fail edge: that result halts the graph", () => {
			expect(problemsOf((raw) => raw.edges.splice(EDGE.ciFail, 1))).toEqual([]);
		});
	});

	describe("reach", () => {
		it("refuses a node with no edge out", () => {
			expect(
				problemsOf((raw) => {
					raw.nodes.notes = { prompt: "Write the notes." };
					raw.edges.push({ from: "review", to: "notes", exit: "model" });
				}),
			).toEqual(['nodes.notes: has no edge out (an edge to "end" ends the graph)']);
		});

		it("refuses a node that cannot be reached from the start", () => {
			expect(
				problemsOf((raw) => {
					raw.nodes.notes = { prompt: "Write the notes." };
					raw.edges.push({ from: "notes", to: "end", exit: "model" });
				}),
			).toEqual(['nodes.notes: cannot be reached from "grill"']);
		});

		it("refuses a graph that cannot end", () => {
			expect(
				problemsOf((raw) => {
					raw.edges[EDGE.merged].to = "grill";
					delete raw.requires;
				}),
			).toEqual(['edges: "end" cannot be reached from "grill"']);
		});
	});

	describe("requires", () => {
		it("refuses names that are not nodes, a passed node that is not a command, and before in notAfter", () => {
			expect(
				problemsOf((raw) => {
					raw.requires = [
						{ before: "ship", passed: "tests", notAfter: ["biuld"] },
						{ before: "merge", passed: "review", notAfter: ["merge"] },
					];
				}),
			).toEqual([
				'requires[0].before: no node "ship"',
				'requires[0].passed: no node "tests"',
				'requires[0].notAfter[0]: no node "biuld"',
				'requires[1].passed: "review" is not a command node: only a command can pass',
				'requires[1].notAfter[0]: "merge" is the node in before',
			]);
		});

		// Example 1 of the spec.
		it("refuses a path to the node that does not pass the check, and shows it", () => {
			expect(problemsOf((raw) => raw.edges.push({ from: "build", to: "merge", exit: "model" }))).toEqual([
				'requires[0]: "merge" can be reached without a pass of "ci": grill -> build -> merge',
				'requires[0]: "merge" can be reached from "build" with no pass of "ci" after it: build -> merge',
			]);
		});

		it("refuses the dev graph without its ci node", () => {
			expect(
				problemsOf((raw) => {
					delete raw.nodes.ci;
					raw.edges = raw.edges.filter((edge) => edge.from !== "ci" && edge.to !== "ci");
					raw.edges.push({ from: "build", to: "review", exit: "model" });
				}),
			).toEqual(['requires[0].passed: no node "ci"']);
		});

		// Example 2 of the spec: every path to merge passes ci, but one changes the code after the check.
		const withPatch = (raw: RawGraph, notAfter: string[]) => {
			raw.nodes.patch = { prompt: "Make the small fixes." };
			raw.edges.push({ from: "review", to: "patch", exit: "model" }, { from: "patch", to: "merge", exit: "model" });
			raw.requires = [{ before: "merge", passed: "ci", notAfter }];
		};

		it("does not see a change made after the check without notAfter", () => {
			expect(problemsOf((raw) => withPatch(raw, []))).toEqual([]);
		});

		it("refuses a change made after the check with notAfter", () => {
			expect(problemsOf((raw) => withPatch(raw, ["patch"]))).toEqual([
				'requires[0]: "merge" can be reached from "patch" with no pass of "ci" after it: patch -> merge',
			]);
		});

		it("accepts the same node when the path from it passes the check again", () => {
			expect(
				problemsOf((raw) => {
					raw.nodes.patch = { prompt: "Make the small fixes." };
					raw.edges.push(
						{ from: "review", to: "patch", exit: "model" },
						{ from: "patch", to: "ci", exit: "model" },
					);
					raw.requires = [{ before: "merge", passed: "ci", notAfter: ["patch", "build"] }];
				}),
			).toEqual([]);
		});

		it("refuses a requirement on the start node: nothing has passed yet", () => {
			expect(problemsOf((raw) => Object.assign(raw, { requires: [{ before: "grill", passed: "ci" }] }))).toEqual([
				'requires[0]: "grill" can be reached without a pass of "ci": grill',
			]);
		});
	});

	describe("loops", () => {
		it("gives an edge on a loop the default max, keeps a max that is set, and leaves the other edges alone", () => {
			const graph = checkGraph(parseGraph(devGraph()));
			const max = (index: number) => graph.edges[index].max;
			// build -> ci -> build and build -> ci -> review -> build are the loops.
			expect(max(EDGE.built)).toBe(DEFAULT_LOOP_MAX);
			expect(max(EDGE.ciFail)).toBe(DEFAULT_LOOP_MAX);
			expect(max(EDGE.ciPass)).toBe(DEFAULT_LOOP_MAX);
			expect(max(EDGE.reviewFix)).toBe(2);
			expect(max(EDGE.approve)).toBeUndefined();
			expect(max(EDGE.reviewOk)).toBeUndefined();
			expect(max(EDGE.merged)).toBeUndefined();
		});

		it("counts an edge from a node to itself as a loop", () => {
			const raw = devGraph();
			raw.nodes.poll = { run: "true" };
			raw.edges[EDGE.merged].to = "poll";
			raw.edges.push({ from: "poll", to: "poll", exit: "fail" }, { from: "poll", to: "end", exit: "pass" });
			const graph = checkGraph(parseGraph(raw));
			expect(graph.edges[7].max).toBe(DEFAULT_LOOP_MAX);
			expect(graph.edges[8].max).toBeUndefined();
		});

		it("does not change the graph it was given", () => {
			const parsed = parseGraph(devGraph());
			checkGraph(parsed);
			expect(parsed.edges[EDGE.ciFail].max).toBeUndefined();
		});
	});
});
