import { describe, expect, it } from "vitest";
import {
	checkGraph,
	formatReport,
	GRAPH_ASKED,
	GRAPH_BLOCKED,
	GRAPH_COMMAND,
	GRAPH_END,
	GRAPH_HALT,
	GRAPH_MOVE,
	GRAPH_NODE,
	GRAPH_START,
	type GraphReport,
	mermaid,
	NESTED_CALLS,
	parseGraph,
	type ReportEntry,
	readState,
	report,
	UNKNOWN_MODEL,
	visitCost,
} from "../src/index.ts";
import { devGraph, EDGE } from "./graphs.ts";

const selection = { provider: "anthropic", id: "claude-sonnet-5-5", thinking: "medium" };
const T0 = Date.parse("2026-11-18T10:00:00.000Z");
/** An ISO time `s` seconds after T0. */
const t = (s: number) => new Date(T0 + s * 1000).toISOString();

// Entries as the host writes them. `at` is when the entry was made; `timestamp` when it was committed.
const custom = (customType: string, data: Record<string, unknown>, committed?: number): ReportEntry => ({
	type: "custom",
	customType,
	data,
	timestamp: t(committed ?? (typeof data.at === "string" ? (Date.parse(data.at) - T0) / 1000 : 0)),
});
const start = (s: number) =>
	custom(GRAPH_START, { graph: devGraph(), path: "/repo/.pi/graphs/dev.js", selection, at: t(s) });
const enter = (node: string, via: string, s: number, edge?: number, committed?: number) =>
	custom(GRAPH_NODE, { node, via, ...(edge === undefined ? {} : { edge }), at: t(s) }, committed);
const move = (edge: number, via: string, s: number, committed?: number) =>
	custom(GRAPH_MOVE, { edge, via, at: t(s) }, committed);
const end = (reason: string, s: number, duringRun = true) => custom(GRAPH_END, { reason, at: t(s), duringRun });
const usage = (cost: number, input = 100, output = 10, cacheRead = 0, cacheWrite = 0) => ({
	input,
	output,
	cacheRead,
	cacheWrite,
	cost: { total: cost },
});
const assistant = (
	cost: number,
	model = "anthropic/claude-opus-5-5",
	toolCall = false,
	cache: [number, number] = [0, 0],
): ReportEntry => {
	const [provider, id] = model.split("/");
	return {
		type: "message",
		message: {
			role: "assistant",
			provider,
			model: id,
			usage: usage(cost, 100, 10, cache[0], cache[1]),
			content: toolCall ? [{ type: "toolCall", id: "c", name: "codemode", arguments: {} }] : [{ type: "text" }],
		},
	};
};
const toolResult = (cost?: number): ReportEntry => ({
	type: "message",
	message: { role: "toolResult", ...(cost === undefined ? {} : { usage: usage(cost) }) },
});
const user: ReportEntry = { type: "message", message: { role: "user" } };
const usageEntry = (kind: string, cost: number, model = "graph/auto"): ReportEntry => {
	const [provider, id] = model.split("/");
	return { type: "usage", kind, provider, model: id, usage: usage(cost) };
};
const command = (node: string, s: number, durationMs: number, outcome: "pass" | "fail", committed: number) => ({
	type: "custom_message",
	customType: GRAPH_COMMAND,
	timestamp: t(committed),
	details: {
		node,
		run: "gh pr checks --watch",
		code: outcome === "pass" ? 0 : 1,
		timedOut: false,
		startedAt: t(s),
		durationMs,
		lines: 12,
		outcome,
	},
});

function run(entries: ReportEntry[], now = T0 + 3600_000): GraphReport {
	const result = report(entries, now);
	if (!result) throw new Error("no report");
	return result;
}

describe("report", () => {
	it("is undefined on a branch with no graph", () => {
		expect(report([user, assistant(0.1)], T0)).toBeUndefined();
	});

	it("sums the usage of each visit in three parts", () => {
		const result = run([
			start(0),
			enter("grill", "start", 0),
			user,
			assistant(0.1, "anthropic/claude-opus-5-5", true, [500, 50]),
			toolResult(0.3), // a script that started a subagent
			assistant(0.05),
			usageEntry("nested_tool_calls", 0.02),
			usageEntry("cache_warm", 0.01, "anthropic/claude-opus-5-5"),
			usageEntry("ext:summary", 0.004, "anthropic/claude-haiku-5-5"),
			{ type: "compaction", usage: usage(0.03) },
			enter("build", "approve", 60, EDGE.approve),
			assistant(0.01, "anthropic/claude-haiku-5-5"),
		]);
		const [grill, build] = result.visits;
		expect(grill.own).toMatchObject({ requests: 2, input: 200, output: 20, cacheRead: 500, cacheWrite: 50 });
		expect(grill.own.cost).toBeCloseTo(0.15);
		expect(grill.tools.cost).toBeCloseTo(0.32);
		expect(Object.keys(grill.other).sort()).toEqual(["cache_warm", "compaction", "ext:summary"]);
		expect(visitCost(grill)).toBeCloseTo(0.514);
		expect(grill.models).toEqual(["anthropic/claude-opus-5-5"]);
		expect(build.own.cost).toBeCloseTo(0.01);
		expect(result.total.cost).toBeCloseTo(0.524);
		// The nested calls of scripts have no model on record; a virtual model's usage goes to the visit's model.
		expect(result.byModel[NESTED_CALLS].cost).toBeCloseTo(0.32);
		expect(result.byModel["anthropic/claude-opus-5-5"].cost).toBeCloseTo(0.15 + 0.01 + 0.03);
		expect(result.byModel["anthropic/claude-haiku-5-5"].cost).toBeCloseTo(0.014);
	});

	it("puts a virtual model's usage under 'unknown' when no model answered in the visit", () => {
		const result = run([start(0), enter("grill", "start", 0), usageEntry("cache_warm", 0.01)]);
		expect(result.byModel[UNKNOWN_MODEL].cost).toBeCloseTo(0.01);
		expect(result.visits[0].models).toEqual([]);
	});

	it("takes times from `at`, so drafts committed together after a command keep their own times", () => {
		// build moves at 100 s; ci is entered at 101 s and runs 45 minutes; all four entries are committed at 2801 s.
		const result = run([
			start(0),
			enter("grill", "start", 0),
			enter("build", "approve", 40, EDGE.approve),
			assistant(0.01, "anthropic/claude-haiku-5-5", true),
			move(EDGE.built, "model", 100),
			toolResult(),
			enter("ci", "model", 101, EDGE.built, 2801),
			command("ci", 101, 2700_000, "fail", 2801),
			move(EDGE.ciFail, "fail", 2801, 2801),
			enter("build", "fail", 2801, EDGE.ciFail, 2801),
		]);
		const [, build, ci, again] = result.visits;
		expect(build.durationMs).toBe(61_000);
		expect(ci.durationMs).toBe(2700_000);
		expect(ci.command).toMatchObject({ outcome: "fail", durationMs: 2700_000, lines: 12 });
		expect(ci.left).toEqual({ via: "fail", to: "build" });
		expect(again.left).toBeUndefined();
		expect(result.edgesTaken).toEqual([EDGE.approve, EDGE.built, EDGE.ciFail]);
	});

	it("falls back to the committed timestamp when an entry has no `at`", () => {
		const old = (customType: string, data: Record<string, unknown>, s: number): ReportEntry => ({
			type: "custom",
			customType,
			data,
			timestamp: t(s),
		});
		const result = run([
			old(GRAPH_START, { graph: devGraph(), path: "/p", selection }, 0),
			old(GRAPH_NODE, { node: "grill", via: "start" }, 0),
			old(GRAPH_NODE, { node: "build", via: "approve", edge: EDGE.approve }, 30),
		]);
		expect(result.visits[0].durationMs).toBe(30_000);
	});

	it("runs the current visit's time to now, and shows a pending move", () => {
		const result = run(
			[
				start(0),
				enter("grill", "start", 0),
				enter("build", "approve", 10, EDGE.approve),
				move(EDGE.built, "model", 20),
			],
			T0 + 25_000,
		);
		expect(result.status).toBe("running");
		expect(result.node).toBe("build");
		expect(result.visits[1].durationMs).toBe(15_000);
		expect(result.visits[1].pending).toEqual({ to: "ci" });
		expect(formatReport(result)).toContain("(now) → ci pending");
	});

	it("matches a queued command message to its own visit by node and start time", () => {
		const result = run([
			start(0),
			enter("grill", "start", 0),
			enter("build", "approve", 10, EDGE.approve),
			enter("ci", "model", 20, EDGE.built),
			enter("review", "pass", 80, EDGE.ciPass),
			// sent while another turn ran: it lands after the next node
			command("ci", 20, 60_000, "pass", 90),
		]);
		expect(result.visits[2].command?.outcome).toBe("pass");
		expect(result.visits[3].command).toBeUndefined();
	});

	it("reads a command message without details as having no result", () => {
		const result = run([
			start(0),
			enter("grill", "start", 0),
			enter("build", "approve", 10, EDGE.approve),
			enter("ci", "model", 20, EDGE.built),
			{ type: "custom_message", customType: GRAPH_COMMAND, timestamp: t(30) },
			enter("review", "pass", 30, EDGE.ciPass),
		]);
		expect(result.visits[2].command).toBeUndefined();
		expect(result.visits[2].run).toBe("gh pr checks --watch");
		expect(result.visits[2].durationMs).toBe(10_000);
	});

	it("records approval answers and the time spent on them", () => {
		const result = run([
			start(0),
			enter("grill", "start", 0),
			custom(GRAPH_ASKED, { node: "grill", to: "build", answer: "send_back", askedAt: t(10), at: t(40) }),
			custom(GRAPH_ASKED, { node: "grill", to: "build", answer: "approve", askedAt: t(50), at: t(55) }),
			enter("build", "approve", 55, EDGE.approve),
		]);
		expect(result.asked.map((asked) => asked.answer)).toEqual(["send_back", "approve"]);
		expect(result.visits[0].waitMs).toBe(35_000);
		expect(formatReport(result)).toContain("asked: grill → build send_back (1) · grill → build approve (1)");
	});

	it("lists blocks and halts with their visit", () => {
		const result = run([
			start(0),
			enter("grill", "start", 0),
			enter("build", "approve", 10, EDGE.approve),
			custom(GRAPH_BLOCKED, { tool: "bash", rule: "gh pr merge", node: "build", at: t(15) }),
			custom(GRAPH_HALT, { reason: "the model ended its turn twice", at: t(20) }),
		]);
		expect(result.blocked).toEqual([{ visit: 2, node: "build", tool: "bash", rule: "gh pr merge", at: t(15) }]);
		expect(result.halts).toEqual([{ visit: 2, node: "build", reason: "the model ended its turn twice", at: t(20) }]);
		expect(result.halted).toBe("the model ended its turn twice");
	});

	it("after an end inside a run, counts the rest of that run's own and tools usage only", () => {
		// "stop" on an approval inside a script: the end is written before the script's tool result.
		const result = run([
			start(0),
			enter("grill", "start", 0),
			enter("build", "approve", 10, EDGE.approve),
			assistant(0.01, "anthropic/claude-haiku-5-5", true),
			end("stopped", 30),
			toolResult(0.4),
			usageEntry("cache_warm", 0.5, "anthropic/claude-haiku-5-5"),
			assistant(0.02, "anthropic/claude-haiku-5-5"),
			// the session goes on idle after the run: none of this is the graph's
			usageEntry("cache_warm", 0.5, "anthropic/claude-haiku-5-5"),
			assistant(1, "anthropic/claude-sonnet-5-5"),
			user,
			assistant(1),
		]);
		expect(result.status).toBe("ended");
		expect(result.endReason).toBe("stopped");
		const build = result.visits[1];
		expect(build.ended).toBe("stopped");
		expect(build.durationMs).toBe(20_000);
		expect(build.tools.cost).toBeCloseTo(0.4);
		expect(build.own.cost).toBeCloseTo(0.03);
		expect(build.other).toEqual({});
		expect(result.total.cost).toBeCloseTo(0.43);
	});

	it("after an end written while idle, counts nothing more", () => {
		const result = run([
			start(0),
			enter("grill", "start", 0),
			assistant(0.1),
			end("stopped", 30, false),
			assistant(0.5, "anthropic/claude-opus-5-5", true),
			toolResult(0.5),
		]);
		expect(result.total.cost).toBeCloseTo(0.1);
	});

	it("reports the last run only", () => {
		const result = run([
			start(0),
			enter("grill", "start", 0),
			assistant(1),
			end("stopped", 10),
			user,
			start(20),
			enter("grill", "start", 20),
			assistant(0.1),
		]);
		expect(result.startedAt).toBe(t(20));
		expect(result.visits).toHaveLength(1);
		expect(result.total.cost).toBeCloseTo(0.1);
	});

	it("reports a run it cannot read as an error, with the visits before the bad entry", () => {
		const result = run([
			start(0),
			enter("grill", "start", 0),
			assistant(0.1),
			enter("merge", "model", 10, EDGE.merged), // no such edge from grill
			assistant(5),
		]);
		expect(result.status).toBe("error");
		expect(result.error).toContain("does not go from");
		expect(result.visits.map((visit) => visit.node)).toEqual(["grill"]);
		expect(result.total.cost).toBeCloseTo(0.1);
	});

	it("reports a start whose graph cannot be read as an error with no visits", () => {
		const result = run([custom(GRAPH_START, { graph: { name: "x" }, path: "/p", selection, at: t(0) })]);
		expect(result.status).toBe("error");
		expect(result.visits).toEqual([]);
	});

	it("formats a table with a row per visit and the totals", () => {
		const text = formatReport(
			run([
				start(0),
				enter("grill", "start", 0),
				assistant(0.21, "anthropic/claude-opus-5-5", false, [41_000, 6000]),
				enter("build", "approve", 242, EDGE.approve),
				assistant(0.03, "anthropic/claude-haiku-5-5"),
				end("stopped", 300),
			]),
		);
		const lines = text.split("\n");
		expect(lines[0]).toBe("dev (/repo/.pi/graphs/dev.js) · ended (stopped) in build");
		expect(lines[1]).toMatch(/^#\s+node\s+kind\s+model \/ command\s+time\s+cost\s+cache r\/w\s+left by$/);
		expect(lines[2]).toMatch(
			/^1\s+grill\s+model\s+anthropic\/claude-opus-5-5\s+4m02s\s+\$0\.21\s+41k\/6k\s+approve → build$/,
		);
		expect(lines[3]).toMatch(/ended \(stopped\)$/);
		expect(text).toContain(
			"total 5m00s · $0.24 · anthropic/claude-opus-5-5 $0.21 · anthropic/claude-haiku-5-5 $0.03",
		);
		expect(text).toContain("not counted: the cost of background agents");
	});
});

describe("readState and graph.asked", () => {
	it("changes no state", () => {
		const entries = [start(0), enter("grill", "start", 0)];
		const before = readState(entries);
		const after = readState([
			...entries,
			custom(GRAPH_ASKED, { node: "grill", to: "build", answer: "dismissed", askedAt: t(1), at: t(2) }),
		]);
		expect(after).toEqual(before);
	});
});

describe("mermaid", () => {
	it("draws the graph with the current node and the edges taken marked", () => {
		const graph = checkGraph(parseGraph(devGraph()));
		const result = run([
			start(0),
			enter("grill", "start", 0),
			enter("build", "approve", 10, EDGE.approve),
			enter("ci", "model", 20, EDGE.built),
		]);
		expect(mermaid(graph, result)).toBe(
			[
				"flowchart LR",
				'  n0["grill"]',
				'  n1["build"]',
				'  n2[["ci"]]',
				'  n3["review"]',
				'  n4[["merge"]]',
				'  n_end(("end"))',
				"  n0 -->|approve| n1",
				"  n1 -->|model ≤3| n2",
				"  n2 -->|pass ≤3| n3",
				"  n2 -->|fail ≤3| n1",
				"  n3 -->|model| n4",
				"  n3 -->|model ≤2| n1",
				"  n4 -->|pass| n_end",
				"  classDef visited fill:#e8f0fe,stroke:#4a6fa5",
				"  classDef current fill:#fff3c4,stroke:#b08800,stroke-width:3px",
				"  class n0,n1 visited",
				"  class n2 current",
				"  linkStyle 0,1 stroke-width:3px",
			].join("\n"),
		);
	});

	it("draws the graph alone without a run", () => {
		const graph = checkGraph(parseGraph(devGraph()));
		expect(mermaid(graph)).not.toContain("classDef");
	});
});
