import { describe, expect, it } from "vitest";
import { defineGraph, type Graph, pairs, toMermaid, transition } from "../src/graph/graph.ts";

interface View {
	state: "a" | "b" | "c";
	n: number;
}
type Event = { type: "go" } | { type: "back" } | { type: "poke"; by: number };
type Effect = { type: "note"; text: string };

const doc = (view: string) => ({ view, event: "", next: "", effects: "" });
const stay = (view: View) => ({ next: view, effects: [] as Effect[] });

type SampleRow = Graph<View, Event, Effect, { limit: number }>["rows"][number];

function sample(overrides: Partial<Graph<View, Event, Effect, { limit: number }>> = {}) {
	return {
		name: "sample",
		stateOf: (view: View) => view.state,
		states: ["a", "b", "c"],
		events: ["go", "back", "poke"],
		rows: [
			{
				from: "a",
				on: "go",
				to: "b",
				doc: doc("a go"),
				step: (view: View) => ({ next: { ...view, state: "b" as const }, effects: [] }),
			},
			{
				from: "b",
				on: "go",
				to: "c",
				doc: doc("b go"),
				step: (view: View) => ({ next: { ...view, state: "c" as const }, effects: [] }),
			},
			{
				from: ["b", "c"],
				on: "back",
				to: "a",
				doc: doc("back"),
				step: (view: View) => ({ next: { ...view, state: "a" as const }, effects: [] }),
			},
			{
				from: "*",
				on: "poke",
				diagram: false as const,
				when: (_view: View, event: Event, config: { limit: number }) =>
					event.type === "poke" && event.by > config.limit,
				doc: doc("poke over the limit"),
				step: (view: View) => ({
					next: view,
					effects: [{ type: "note", text: "too much" } as Effect],
				}),
			},
			{
				from: "c",
				on: "poke",
				diagram: false,
				doc: doc("c poke"),
				step: (view: View) => ({ next: { ...view, n: view.n + 1 }, effects: [] }),
			},
		],
		otherwise: {
			go: stay,
			back: stay,
			poke: (view: View) => ({ next: view, effects: [{ type: "note", text: "refused" } as Effect] }),
		},
		...overrides,
	} satisfies Graph<View, Event, Effect, { limit: number }>;
}

const start: View = { state: "a", n: 0 };

describe("defineGraph", () => {
	it("accepts a valid definition and returns it", () => {
		const graph = sample();
		expect(defineGraph(graph)).toBe(graph);
	});

	it("refuses a row that names an undeclared state", () => {
		const graph = sample();
		const rows: SampleRow[] = [...graph.rows, { ...graph.rows[0], from: "z" }];
		expect(() => defineGraph({ ...graph, rows })).toThrow(/undeclared state "z"/);
	});

	it("refuses a row that goes to an undeclared state", () => {
		const graph = sample();
		const rows: SampleRow[] = [...graph.rows, { ...graph.rows[0], from: "c", on: "go", to: "z" }];
		expect(() => defineGraph({ ...graph, rows })).toThrow(/undeclared state "z"/);
	});

	it("refuses a row that names an undeclared event", () => {
		const graph = sample();
		const rows = [...graph.rows, { ...graph.rows[0], on: "jump" as "go" }];
		expect(() => defineGraph({ ...graph, rows })).toThrow(/undeclared event "jump"/);
	});

	it("refuses a declared state that appears in no row", () => {
		const graph = sample();
		// A "*" row names every state, so the check needs a graph without one.
		const rows = graph.rows.filter((row) => row.from !== "*");
		expect(() => defineGraph({ ...graph, rows, states: [...graph.states, "d"] })).toThrow(
			/state "d" appears in no row/,
		);
	});

	it("refuses a row that an earlier row without a guard shadows", () => {
		const graph = sample();
		const rows: SampleRow[] = [...graph.rows, { ...graph.rows[0], doc: doc("shadowed") }];
		expect(() => defineGraph({ ...graph, rows })).toThrow(/shadowed.*can never match/);
	});

	it("lets a guarded row come before another row for the same pair", () => {
		const graph = sample();
		// The `poke` rows above: a guarded "*" row, then a row for c.
		expect(() => defineGraph(graph)).not.toThrow();
	});

	it("loads when an event is answered by otherwise alone", () => {
		const graph = sample();
		const rows: SampleRow[] = graph.rows.filter((row) => row.on !== "back");
		// `back` has no row any more; `b` and `c` still appear in other rows.
		expect(() => defineGraph({ ...graph, rows })).not.toThrow();
	});
});

describe("transition", () => {
	const graph = defineGraph(sample());
	const config = { limit: 5 };

	it("applies the first row that matches and names it", () => {
		const result = transition(graph, start, { type: "go" }, config);
		expect(result.next.state).toBe("b");
		expect(result.row).toBe("a go");
	});

	it("tries rows in order: a guarded row before a plain one for the same pair", () => {
		const atC: View = { state: "c", n: 0 };
		expect(transition(graph, atC, { type: "poke", by: 9 }, config).row).toBe("poke over the limit");
		expect(transition(graph, atC, { type: "poke", by: 1 }, config).row).toBe("c poke");
		expect(transition(graph, atC, { type: "poke", by: 1 }, config).next.n).toBe(1);
	});

	it("answers an unmatched pair with otherwise, without a row", () => {
		const result = transition(graph, start, { type: "back" }, config);
		expect(result).toEqual({ next: start, effects: [] });
		const refused = transition(graph, start, { type: "poke", by: 1 }, config);
		expect(refused.effects).toEqual([{ type: "note", text: "refused" }]);
		expect(refused.row).toBeUndefined();
	});
});

describe("pairs and toMermaid", () => {
	const graph = defineGraph(sample());

	it("lists every (state, event) pair with the rows that can answer it", () => {
		const all = pairs(graph);
		expect(all).toHaveLength(9);
		expect(all.find((pair) => pair.state === "a" && pair.event === "go")?.rows).toEqual(["a go"]);
		expect(all.find((pair) => pair.state === "c" && pair.event === "poke")?.rows).toEqual([
			"poke over the limit",
			"c poke",
		]);
		expect(all.find((pair) => pair.state === "a" && pair.event === "back")?.rows).toEqual([]);
	});

	it("draws edges, leaves out diagram:false, and draws a wildcard row once as a note", () => {
		const lines = ["stateDiagram-v2", "    a --> b: go", "    b --> c: go", "    b --> a: back", "    c --> a: back"];
		// The wildcard row is hidden in the sample; it shows as a note once it is not.
		expect(toMermaid(graph)).toBe(lines.join("\n"));
		const shown = {
			...graph,
			rows: graph.rows.map((row) => (row.from === "*" ? { ...row, diagram: undefined } : row)),
		};
		expect(toMermaid(shown)).toBe(
			[...lines, "    note right of a", "        poke over the limit: poke", "    end note"].join("\n"),
		);
	});

	it("draws a row without `to` as a self-loop", () => {
		const base = sample();
		const rows: SampleRow[] = [
			...base.rows,
			{ ...base.rows[0], from: "c", on: "go", to: undefined, doc: doc("c go") },
		];
		expect(toMermaid(defineGraph({ ...base, rows }))).toContain("    c --> c: go");
	});
});
