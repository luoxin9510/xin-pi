import { describe, expect, it } from "vitest";
import {
	exits,
	GRAPH_BLOCKED,
	GRAPH_END,
	GRAPH_HALT,
	GRAPH_MOVE,
	GRAPH_NODE,
	GRAPH_REMINDER,
	GRAPH_START,
	type GraphEntry,
	type GraphState,
	type RunningState,
	readState,
} from "../src/index.ts";
import { devGraph, EDGE } from "./graphs.ts";

const selection = { provider: "anthropic", id: "claude-sonnet-5-5", thinking: "medium" };

// Entries as a host writes them.
const custom = (customType: string, data: unknown): GraphEntry => ({ type: "custom", customType, data });
const start = (graph: unknown = devGraph()) =>
	custom(GRAPH_START, { graph, path: "/repo/.pi/graphs/dev.js", selection });
const enter = (node: string, via: string, edge?: number, report?: string) =>
	custom(GRAPH_NODE, {
		node,
		via,
		...(edge === undefined ? {} : { edge }),
		...(report === undefined ? {} : { report }),
	});
const move = (edge: number, via: string, report?: string) =>
	custom(GRAPH_MOVE, { edge, via, ...(report === undefined ? {} : { report }) });
const halt = (reason: string) => custom(GRAPH_HALT, { reason });
const end = (reason: string) => custom(GRAPH_END, { reason });
const user: GraphEntry = { type: "message", message: { role: "user" } };
const assistant: GraphEntry = { type: "message", message: { role: "assistant" } };
const reminder: GraphEntry = { type: "custom_message", customType: GRAPH_REMINDER };

/** A branch that started the dev graph and is in `build` after the approval. */
const toBuild = [
	start(),
	enter("grill", "start"),
	user,
	assistant,
	enter("build", "approve", EDGE.approve, "spec agreed"),
];

function running(entries: readonly GraphEntry[]): RunningState {
	const state = readState(entries);
	if (state.status !== "running") throw new Error(`expected a running graph, got ${JSON.stringify(state)}`);
	return state;
}

function errorOf(entries: readonly GraphEntry[]): string {
	const state: GraphState = readState(entries);
	if (state.status !== "error") throw new Error(`expected an error state, got ${state.status}`);
	return state.message;
}

describe("readState", () => {
	it("is none for a branch without a graph", () => {
		expect(readState([])).toEqual({ status: "none" });
		expect(readState([user, assistant, custom("relay.handover", { round: 1 })])).toEqual({ status: "none" });
	});

	it("reads the start: the checked graph, the path, the selection to restore, the first node", () => {
		const state = running([user, start(), enter("grill", "start")]);
		expect(state.node).toBe("grill");
		expect(state.visited).toEqual(["grill"]);
		expect(state.path).toBe("/repo/.pi/graphs/dev.js");
		expect(state.selection).toEqual(selection);
		expect(state.graph.name).toBe("dev");
		// The stored literal went through `checkGraph`: the loop edges have their default max.
		expect(state.graph.edges[EDGE.ciFail].max).toBe(3);
		expect(state.counts).toEqual([0, 0, 0, 0, 0, 0, 0]);
		expect(state.pending).toBeUndefined();
		expect(state.halted).toBeUndefined();
		expect(state.reminded).toBe(false);
	});

	it("follows the moves and counts each edge taken", () => {
		const state = running([
			...toBuild,
			enter("ci", "model", EDGE.built),
			enter("build", "fail", EDGE.ciFail),
			enter("ci", "model", EDGE.built),
			enter("review", "pass", EDGE.ciPass),
		]);
		expect(state.node).toBe("review");
		expect(state.visited).toEqual(["grill", "build", "ci", "build", "ci", "review"]);
		expect(state.counts).toEqual([1, 2, 1, 1, 0, 0, 0]);
	});

	it("starts the counts again after a goto", () => {
		const state = running([
			...toBuild,
			enter("ci", "model", EDGE.built),
			enter("build", "fail", EDGE.ciFail),
			enter("build", "goto"),
			enter("ci", "model", EDGE.built),
		]);
		expect(state.node).toBe("ci");
		expect(state.counts).toEqual([0, 1, 0, 0, 0, 0, 0]);
	});

	describe("a pending move", () => {
		it("is part of the state until the node is entered", () => {
			const pending = running([...toBuild, move(EDGE.built, "model", "built and pushed")]);
			expect(pending.node).toBe("build");
			expect(pending.pending).toEqual({ edge: EDGE.built, via: "model", report: "built and pushed" });
			expect(pending.counts[EDGE.built]).toBe(0);

			const entered = running([...toBuild, move(EDGE.built, "model"), enter("ci", "model", EDGE.built)]);
			expect(entered.node).toBe("ci");
			expect(entered.pending).toBeUndefined();
			expect(entered.counts[EDGE.built]).toBe(1);
		});

		it("keeps where it came from, so a command result can be told from a model's move", () => {
			const state = running([...toBuild, enter("ci", "model", EDGE.built), move(EDGE.ciPass, "pass")]);
			expect(state.pending).toEqual({ edge: EDGE.ciPass, via: "pass" });
		});

		it("survives messages after it: a quit or an aborted turn does not lose it", () => {
			const state = running([...toBuild, move(EDGE.built, "model"), assistant, user]);
			expect(state.pending).toEqual({ edge: EDGE.built, via: "model" });
		});
	});

	describe("a halt", () => {
		it("on a model node is left by the user's next message", () => {
			const halted = running([...toBuild, halt("no move after a reminder"), assistant]);
			expect(halted.halted).toBe("no move after a reminder");
			const left = running([...toBuild, halt("no move after a reminder"), assistant, user]);
			expect(left.halted).toBeUndefined();
			expect(left.node).toBe("build");
		});

		it("on a command node is not left by a message, only by a goto", () => {
			const onCi = [...toBuild, enter("ci", "model", EDGE.built), halt("ci failed and its edge is at max")];
			expect(running([...onCi, user, assistant, user]).halted).toBe("ci failed and its edge is at max");
			const left = running([...onCi, user, enter("build", "goto")]);
			expect(left.halted).toBeUndefined();
			expect(left.node).toBe("build");
		});
	});

	describe("the reminder", () => {
		it("is remembered for the visit, and forgotten when a node is entered", () => {
			expect(running([...toBuild, reminder]).reminded).toBe(true);
			expect(running([...toBuild, reminder, enter("ci", "model", EDGE.built)]).reminded).toBe(false);
		});

		it("is forgotten when a halt is left, so the next idle turn gets a reminder again", () => {
			expect(running([...toBuild, reminder, halt("idle"), user]).reminded).toBe(false);
		});

		it("is not forgotten by a user message without a halt", () => {
			expect(running([...toBuild, reminder, user]).reminded).toBe(true);
		});
	});

	describe("the end", () => {
		it("leaves none, with the selection to restore and the reason", () => {
			expect(readState([...toBuild, end("stopped")])).toEqual({
				status: "none",
				ended: { selection, reason: "stopped" },
			});
			expect(readState([...toBuild, end("done"), user, assistant])).toEqual({
				status: "none",
				ended: { selection, reason: "done" },
			});
		});

		it("allows a second graph after it", () => {
			const state = running([...toBuild, end("done"), user, start(), enter("grill", "start")]);
			expect(state.node).toBe("grill");
			expect(state.visited).toEqual(["grill"]);
			expect(state.counts[EDGE.approve]).toBe(0);
		});
	});

	it("ignores the custom entries of others and its own block records", () => {
		const state = running([
			...toBuild,
			custom("relay.handover", undefined),
			custom(GRAPH_BLOCKED, { call: "gh pr merge", rule: "deny" }),
			{ type: "compaction" },
			{ type: "custom_message", customType: "graph.enter" },
		]);
		expect(state.node).toBe("build");
	});

	it("reads only the branch it is given: a branch from an earlier node is at that node", () => {
		const first = [...toBuild, enter("ci", "model", EDGE.built), enter("review", "pass", EDGE.ciPass)];
		// Branching from the `build` entry drops what came after it.
		const branch = first.slice(0, toBuild.length);
		expect(running(first).node).toBe("review");
		expect(running(branch).node).toBe("build");
		expect(running(branch).counts[EDGE.built]).toBe(0);
	});

	describe("entries that cannot be read", () => {
		it("a start without a selection or a path", () => {
			expect(errorOf([custom(GRAPH_START, { graph: devGraph() })])).toMatch(/no selection or path/);
			expect(errorOf([custom(GRAPH_START, undefined)])).toMatch(/no selection or path/);
		});

		it("a stored graph that does not parse or does not pass the checks", () => {
			expect(errorOf([start({ name: "dev" }), enter("grill", "start")])).toMatch(/graph dev: \d+ problems/);
			const noEnd = devGraph();
			noEnd.edges[EDGE.merged].to = "grill";
			delete noEnd.requires;
			expect(errorOf([start(noEnd), enter("grill", "start")])).toMatch(/"end" cannot be reached/);
		});

		it("a start with no node entered", () => {
			expect(errorOf([start()])).toMatch(/no node was entered/);
		});

		it("a second start while a graph runs", () => {
			expect(errorOf([...toBuild, start()])).toMatch(/a graph already runs/);
		});

		it("a node the graph does not have", () => {
			expect(errorOf([...toBuild, enter("deploy", "goto")])).toMatch(/no node "deploy"/);
		});

		it("an edge that does not exist, or does not join the two nodes", () => {
			expect(errorOf([...toBuild, enter("ci", "model", 99)])).toMatch(/no such edge or via/);
			expect(errorOf([...toBuild, enter("ci", "model")])).toMatch(/no such edge or via/);
			expect(errorOf([...toBuild, enter("ci", "sideways", EDGE.built)])).toMatch(/no such edge or via/);
			expect(errorOf([...toBuild, enter("review", "model", EDGE.built)])).toMatch(
				/edge 1 does not go from "build" to "review"/,
			);
			expect(errorOf([...toBuild, move(EDGE.ciPass, "pass")])).toMatch(/edge 2 does not leave "build"/);
		});

		it("an entry without data, or a halt without a reason", () => {
			expect(errorOf([...toBuild, custom(GRAPH_NODE, undefined)])).toMatch(/no data/);
			expect(errorOf([...toBuild, custom(GRAPH_HALT, {})])).toMatch(/no reason/);
		});

		it("a start entry that is not the first, or a first entry that is not the start node", () => {
			expect(errorOf([...toBuild, enter("review", "start")])).toMatch(/a second start entry/);
			expect(errorOf([start(), enter("build", "start")])).toMatch(/the first entry must be the start node/);
			expect(errorOf([start(), enter("grill", "goto")])).toMatch(/the first entry must be the start node/);
		});

		it("an edge taken by something other than its exit", () => {
			expect(errorOf([...toBuild, enter("ci", "pass", EDGE.built)])).toMatch(/edge 1 is not taken by pass/);
			expect(errorOf([...toBuild, move(EDGE.built, "fail")])).toMatch(/edge 1 is not taken by fail/);
		});

		it("a node entered by another edge than the pending move, and a second pending move", () => {
			const inReview = [...toBuild, enter("ci", "model", EDGE.built), enter("review", "pass", EDGE.ciPass)];
			const entered = [...inReview, move(EDGE.reviewOk, "model"), enter("build", "model", EDGE.reviewFix)];
			expect(errorOf(entered)).toMatch(/edge 5 is not the pending move \(edge 4\)/);
			const twice = [...inReview, move(EDGE.reviewOk, "model"), move(EDGE.reviewFix, "model")];
			expect(errorOf(twice)).toMatch(/a move is already pending \(edge 4\)/);
		});

		it("a goto drops a pending move: the user took over", () => {
			const state = running([...toBuild, move(EDGE.built, "model"), enter("grill", "goto")]);
			expect(state.node).toBe("grill");
			expect(state.pending).toBeUndefined();
		});

		it("an end without a known reason", () => {
			expect(errorOf([...toBuild, end("finished")])).toMatch(/graph\.end: no reason/);
			expect(errorOf([...toBuild, custom(GRAPH_END, undefined)])).toMatch(/graph\.end: no reason/);
		});

		it("stays an error until the graph is ended, and keeps the selection to restore", () => {
			const broken = [...toBuild, enter("deploy", "goto"), enter("ci", "model", EDGE.built), user];
			const state = readState(broken);
			expect(state).toMatchObject({ status: "error", selection });
			expect(readState([...broken, end("stopped")])).toEqual({
				status: "none",
				ended: { selection, reason: "stopped" },
			});
		});
	});
});

describe("exits", () => {
	it("lists the edges out of the current node with their counts", () => {
		const state = running([...toBuild, enter("ci", "model", EDGE.built), enter("review", "pass", EDGE.ciPass)]);
		expect(exits(state)).toEqual([
			{ index: EDGE.reviewOk, edge: state.graph.edges[EDGE.reviewOk], count: 0, open: true },
			{ index: EDGE.reviewFix, edge: state.graph.edges[EDGE.reviewFix], count: 0, open: true },
		]);
	});

	it("closes an edge at its max", () => {
		const round = [
			enter("build", "model", EDGE.reviewFix),
			enter("ci", "model", EDGE.built),
			enter("review", "pass", EDGE.ciPass),
		];
		const once = [...toBuild, enter("ci", "model", EDGE.built), enter("review", "pass", EDGE.ciPass), ...round];
		const fix = (state: RunningState) => exits(state).find((choice) => choice.index === EDGE.reviewFix);
		expect(fix(running(once))).toMatchObject({ count: 1, open: true });
		// `review -> build` has max 2 in the dev graph.
		expect(fix(running([...once, ...round]))).toMatchObject({ count: 2, open: false });
	});

	it("opens the edges again after a goto", () => {
		const round = [
			enter("build", "model", EDGE.reviewFix),
			enter("ci", "model", EDGE.built),
			enter("review", "pass", EDGE.ciPass),
		];
		const state = running([
			...toBuild,
			enter("ci", "model", EDGE.built),
			enter("review", "pass", EDGE.ciPass),
			...round,
			...round,
			enter("review", "goto"),
		]);
		expect(exits(state).every((choice) => choice.open && choice.count === 0)).toBe(true);
	});
});
