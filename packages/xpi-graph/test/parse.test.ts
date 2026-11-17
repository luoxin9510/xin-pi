import { describe, expect, it } from "vitest";
import { DEFAULT_TIMEOUT_MS, GraphError, parseGraph } from "../src/index.ts";
import { devGraph } from "./graphs.ts";

/** The places of the problems `parseGraph` reports for a value. */
function problemsOf(value: unknown): string[] {
	try {
		parseGraph(value);
	} catch (error) {
		if (error instanceof GraphError) return error.problems.map((problem) => problem.at);
		throw error;
	}
	return [];
}

describe("parseGraph", () => {
	it("reads the dev graph", () => {
		const graph = parseGraph(devGraph());
		expect(graph.name).toBe("dev");
		expect(graph.start).toBe("grill");
		expect(graph.nodes.grill).toEqual({
			kind: "model",
			model: "anthropic/claude-opus-5-5",
			prompt: "Grill the request.",
			deny: [],
			readOnly: ["**"],
		});
		expect(graph.nodes.review).toEqual({
			kind: "model",
			prompt: "Have a fresh subagent review the change.",
			deny: ["gh pr merge"],
			readOnly: [],
		});
		expect(graph.nodes.ci).toEqual({ kind: "command", run: "gh pr checks --watch", timeoutMs: 30 * 60_000 });
		expect(graph.nodes.merge).toEqual({
			kind: "command",
			run: "gh pr merge --merge --delete-branch",
			timeoutMs: DEFAULT_TIMEOUT_MS,
		});
		expect(graph.edges[5]).toEqual({ from: "review", to: "build", exit: "model", label: "findings to fix", max: 2 });
		expect(graph.edges[3]).toEqual({ from: "ci", to: "build", exit: "fail" });
		expect(graph.requires).toEqual([{ before: "merge", passed: "ci", notAfter: ["build"] }]);
	});

	it("reads timeouts in seconds, minutes and hours", () => {
		const timeoutOf = (timeout: string) => {
			const raw = devGraph();
			raw.nodes.ci.timeout = timeout;
			const node = parseGraph(raw).nodes.ci;
			return node.kind === "command" ? node.timeoutMs : undefined;
		};
		expect(timeoutOf("45s")).toBe(45_000);
		expect(timeoutOf("2m")).toBe(120_000);
		expect(timeoutOf("1h")).toBe(3_600_000);
	});

	it("takes a graph without requires, and a thinking level", () => {
		const raw = devGraph();
		delete raw.requires;
		raw.nodes.build.thinking = "high";
		const graph = parseGraph(raw);
		expect(graph.requires).toEqual([]);
		expect(graph.nodes.build).toMatchObject({ thinking: "high" });
	});

	it("refuses a value that is not an object", () => {
		expect(problemsOf("dev")).toEqual(["graph"]);
		expect(problemsOf(null)).toEqual(["graph"]);
		expect(problemsOf([])).toEqual(["graph"]);
	});

	it("reports every problem at once, each with its place", () => {
		const raw = devGraph();
		raw.name = "Dev Flow";
		raw.nodes.build.promt = "typo";
		raw.nodes.ci.timeout = "soon";
		raw.edges[1].exit = "done";
		raw.edges[2].max = 0;
		expect(problemsOf(raw)).toEqual([
			"name",
			"nodes.build.promt",
			"nodes.ci.timeout",
			"edges[1].exit",
			"edges[2].max",
		]);
	});

	it("names the graph and the problems in the message", () => {
		const raw = devGraph();
		raw.edges[1].exit = "done";
		expect(() => parseGraph(raw)).toThrow(
			/graph dev: 1 problem\n {2}edges\[1\]\.exit: must be one of model, approve, pass, fail/,
		);
	});

	it.each([
		["a missing name", (raw: Record<string, unknown>) => delete raw.name, ["name"]],
		["a missing start", (raw: Record<string, unknown>) => delete raw.start, ["start"]],
		["no nodes", (raw: Record<string, unknown>) => delete raw.nodes, ["nodes"]],
		["empty nodes", (raw: Record<string, unknown>) => Object.assign(raw, { nodes: {} }), ["nodes"]],
		["no edges", (raw: Record<string, unknown>) => delete raw.edges, ["edges"]],
		[
			"requires that is not a list",
			(raw: Record<string, unknown>) => Object.assign(raw, { requires: {} }),
			["requires"],
		],
		["an unknown key", (raw: Record<string, unknown>) => Object.assign(raw, { begin: "grill" }), ["begin"]],
	])("refuses %s", (_what, change, places) => {
		const raw: Record<string, unknown> = { ...devGraph() };
		change(raw);
		expect(problemsOf(raw)).toEqual(places);
	});

	it("checks each field of a model node", () => {
		const places = (node: unknown) => {
			const raw = devGraph();
			Object.assign(raw.nodes, { build: node });
			return problemsOf(raw);
		};
		expect(places("build it")).toEqual(["nodes.build"]);
		expect(places({})).toEqual(["nodes.build.prompt"]);
		expect(places({ prompt: "  " })).toEqual(["nodes.build.prompt"]);
		expect(places({ prompt: "p", model: "haiku" })).toEqual(["nodes.build.model"]);
		expect(places({ prompt: "p", thinking: 3 })).toEqual(["nodes.build.thinking"]);
		expect(places({ prompt: "p", deny: "gh pr merge" })).toEqual(["nodes.build.deny"]);
		expect(places({ prompt: "p", deny: ["ok", ""] })).toEqual(["nodes.build.deny[1]"]);
		expect(places({ prompt: "p", readOnly: [1] })).toEqual(["nodes.build.readOnly[0]"]);
	});

	it("checks each field of a command node, which has no prompt and no model", () => {
		const places = (node: unknown) => {
			const raw = devGraph();
			Object.assign(raw.nodes, { ci: node });
			return problemsOf(raw);
		};
		expect(places({ run: "" })).toEqual(["nodes.ci.run"]);
		expect(places({ run: "true", timeout: "0m" })).toEqual(["nodes.ci.timeout"]);
		expect(places({ run: "true", timeout: 30 })).toEqual(["nodes.ci.timeout"]);
		expect(places({ run: "true", prompt: "p" })).toEqual(["nodes.ci.prompt"]);
		expect(places({ run: "true", model: "a/b" })).toEqual(["nodes.ci.model"]);
	});

	it("refuses a node named end, and an id with other characters", () => {
		const raw = devGraph();
		raw.nodes.end = { prompt: "p" };
		raw.nodes["two words"] = { prompt: "p" };
		expect(problemsOf(raw)).toEqual(["nodes.end", "nodes.two words"]);
	});

	it("checks each field of an edge", () => {
		const places = (edge: unknown) => {
			const raw = devGraph();
			Object.assign(raw.edges, { 0: edge });
			return problemsOf(raw);
		};
		expect(places("grill -> build")).toEqual(["edges[0]"]);
		expect(places({})).toEqual(["edges[0].from", "edges[0].to", "edges[0].exit"]);
		expect(places({ from: "grill", to: "build", exit: "approve", label: "" })).toEqual(["edges[0].label"]);
		expect(places({ from: "grill", to: "build", exit: "approve", max: 1.5 })).toEqual(["edges[0].max"]);
		expect(places({ from: "grill", to: "build", exit: "approve", max: "3" })).toEqual(["edges[0].max"]);
		expect(places({ from: "grill", to: "build", exit: "approve", when: "x" })).toEqual(["edges[0].when"]);
	});

	it("checks each field of a requirement", () => {
		const places = (requirement: unknown) => {
			const raw = devGraph();
			raw.requires = [requirement as Record<string, unknown>];
			return problemsOf(raw);
		};
		expect(places("ci before merge")).toEqual(["requires[0]"]);
		expect(places({})).toEqual(["requires[0].before", "requires[0].passed"]);
		expect(places({ before: "merge", passed: "ci", notAfter: "build" })).toEqual(["requires[0].notAfter"]);
		expect(places({ before: "merge", passed: "ci", after: ["build"] })).toEqual(["requires[0].after"]);
	});
});
