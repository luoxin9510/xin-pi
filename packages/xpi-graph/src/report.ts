// What a graph run shows: the last run on the branch, folded from the same entries as its state (spec 02). Pure: the
// host passes the branch and the time; nothing is written.

import { checkGraph } from "./check.ts";
import { parseGraph } from "./parse.ts";
import {
	type EndReason,
	GRAPH_BLOCKED,
	GRAPH_COMMAND,
	GRAPH_END,
	GRAPH_HALT,
	GRAPH_MOVE,
	GRAPH_NODE,
	GRAPH_START,
	type GraphEntry,
	type NodeVia,
	readState,
} from "./state.ts";
import { END, type Graph } from "./types.ts";

/** `graph.asked`: the answer of an approval question. A record only; it changes no state. */
export const GRAPH_ASKED = "graph.asked";

export type AskedAnswer = "approve" | "send_back" | "stop" | "dismissed";

export interface AskedData {
	node: string;
	to: string;
	answer: AskedAnswer;
	askedAt: string;
	at: string;
}

/** The `details` of a `graph.command` message. */
export interface CommandDetails {
	node: string;
	run: string;
	code: number | null;
	timedOut: boolean;
	startedAt: string;
	durationMs: number;
	lines: number;
	outcome: "pass" | "fail";
}

/** The usage fields the report reads, as `xpi-ai`'s `Usage` has them. */
export interface UsageLike {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total?: number };
}

/** What the report reads of a session entry, on top of what the state reads. */
export interface ReportEntry extends GraphEntry {
	timestamp?: string;
	/** A custom message's details. */
	details?: unknown;
	/** A `usage` entry's kind, provider and model. */
	kind?: string;
	provider?: string;
	model?: string;
	/** The usage of a `usage`, `compaction` or `branch_summary` entry. */
	usage?: UsageLike;
	message?: {
		role: string;
		provider?: string;
		model?: string;
		usage?: UsageLike;
		content?: unknown;
	};
}

/** Summed usage. `requests` counts assistant messages; the other parts have none. */
export interface Tally {
	requests: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export interface VisitReport {
	/** 1 for the first visit of the run. */
	visit: number;
	node: string;
	kind: "model" | "command";
	/** How the node was entered. */
	via: NodeVia;
	/** The models that answered in the visit (`provider/id`), in the order they first did. */
	models: string[];
	/** A command node's command, as the graph has it. */
	run?: string;
	/** A command node's result, when its message has details. */
	command?: CommandDetails;
	startedAt: string;
	durationMs: number;
	/** Time spent on approval questions in the visit. */
	waitMs: number;
	/** The node's own model. */
	own: Tally;
	/** What codemode scripts' nested calls spent (foreground subagents, `models.*`). */
	tools: Tally;
	/** Every other usage in the visit, by kind (`cache_warm`, `ext:<purpose>`, `compaction`, `branch_summary`). */
	other: Record<string, Tally>;
	/** How it was left; absent for the visit that runs or the one the graph ended in. */
	left?: { via: NodeVia; to: string };
	/** A move accepted and not entered yet. */
	pending?: { to: string };
	/** The graph ended in this visit. */
	ended?: EndReason;
}

export interface AskedRecord extends AskedData {
	visit: number;
}

export interface BlockedRecord {
	visit: number;
	node: string;
	tool: string;
	rule: string;
	at: string;
}

export interface HaltRecord {
	visit: number;
	node: string;
	reason: string;
	at: string;
}

export interface GraphReport {
	schemaVersion: 1;
	status: "running" | "ended" | "error";
	/** The state's message when `status` is `error`; the visits are those read up to the bad entry. */
	error?: string;
	graph: string;
	path: string;
	startedAt: string;
	endedAt?: string;
	endReason?: EndReason;
	/** The node the run is in, or ended in. */
	node?: string;
	halted?: string;
	visits: VisitReport[];
	asked: AskedRecord[];
	blocked: BlockedRecord[];
	halts: HaltRecord[];
	total: { durationMs: number; own: Tally; tools: Tally; other: Tally; cost: number };
	/**
	 * Cost and tokens by model: the node's own requests under the model that answered, `usage` entries under their
	 * model (a virtual one replaced by the model that answered the visit, or "unknown"), and the nested calls of
	 * scripts, whose model the session does not record, under "nested calls".
	 */
	byModel: Record<string, Tally>;
	/** The edges taken, by index, in order. */
	edgesTaken: number[];
	/** What the report cannot count. */
	notCounted: string[];
}

export interface ReportOptions {
	/** True for a virtual model (`provider/id`). Default: only `graph/auto`. */
	isVirtual?: (key: string) => boolean;
}

export const NESTED_CALLS = "nested calls";
export const UNKNOWN_MODEL = "unknown";

type Fields = Record<string, unknown>;

const isFields = (value: unknown): value is Fields =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export function emptyTally(): Tally {
	return { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

function add(into: Tally, usage: UsageLike | undefined, request = false): void {
	if (!usage) return;
	if (request) into.requests += 1;
	into.input += num(usage.input);
	into.output += num(usage.output);
	into.cacheRead += num(usage.cacheRead);
	into.cacheWrite += num(usage.cacheWrite);
	into.cost += num(usage.cost?.total);
}

function sum(into: Tally, from: Tally): void {
	into.requests += from.requests;
	into.input += from.input;
	into.output += from.output;
	into.cacheRead += from.cacheRead;
	into.cacheWrite += from.cacheWrite;
	into.cost += from.cost;
}

const ms = (iso: string | undefined): number | undefined => {
	if (iso === undefined) return undefined;
	const value = Date.parse(iso);
	return Number.isNaN(value) ? undefined : value;
};

/** When a graph entry happened: its own `at`, else when it was committed. */
function atOf(entry: ReportEntry): string | undefined {
	if (isFields(entry.data) && typeof entry.data.at === "string") return entry.data.at;
	return entry.timestamp;
}

const hasToolCall = (content: unknown): boolean =>
	Array.isArray(content) && content.some((part) => isFields(part) && part.type === "toolCall");

function readDetails(value: unknown): CommandDetails | undefined {
	if (!isFields(value)) return undefined;
	const { node, run, code, timedOut, startedAt, durationMs, lines, outcome } = value;
	if (typeof node !== "string" || typeof run !== "string" || typeof startedAt !== "string") return undefined;
	if (outcome !== "pass" && outcome !== "fail") return undefined;
	return {
		node,
		run,
		code: typeof code === "number" ? code : null,
		timedOut: timedOut === true,
		startedAt,
		durationMs: num(durationMs),
		lines: num(lines),
		outcome,
	};
}

const ANSWERS: readonly AskedAnswer[] = ["approve", "send_back", "stop", "dismissed"];

const isCustom = (entry: ReportEntry, type: string) => entry.type === "custom" && entry.customType === type;

/**
 * The report of the last run on the branch, or undefined when the branch has none. `now` (ms) ends the time of the
 * visit that runs.
 */
export function report(
	entries: readonly ReportEntry[],
	now: number,
	options: ReportOptions = {},
): GraphReport | undefined {
	const isVirtual = options.isVirtual ?? ((key: string) => key === "graph/auto");
	let first = -1;
	for (let index = entries.length - 1; index >= 0; index--) {
		if (isCustom(entries[index], GRAPH_START)) {
			first = index;
			break;
		}
	}
	if (first < 0) return undefined;
	const start = entries[first];
	const startData = isFields(start.data) ? start.data : {};
	const name = isFields(startData.graph) && typeof startData.graph.name === "string" ? startData.graph.name : "?";
	const result: GraphReport = {
		schemaVersion: 1,
		status: "running",
		graph: name,
		path: typeof startData.path === "string" ? startData.path : "",
		startedAt: atOf(start) ?? "",
		visits: [],
		asked: [],
		blocked: [],
		halts: [],
		total: { durationMs: 0, own: emptyTally(), tools: emptyTally(), other: emptyTally(), cost: 0 },
		byModel: {},
		edgesTaken: [],
		notCounted: ["the cost of background agents (the session records it only as text)"],
	};
	let graph: Graph;
	try {
		graph = checkGraph(parseGraph(startData.graph));
	} catch (error) {
		result.status = "error";
		result.error = error instanceof Error ? error.message : String(error);
		return result;
	}

	// Where the state cannot be read, the report stops: the visits are those before the bad entry.
	let last = entries.length;
	const state = readState(entries);
	if (state.status === "error") {
		result.status = "error";
		result.error = state.message;
		for (let index = first + 1; index <= entries.length; index++) {
			const prefix = readState(entries.slice(0, index));
			// A prefix that has the start and no node yet is not a bad entry, only an unfinished one.
			if (prefix.status === "error" && !prefix.message.startsWith(`${GRAPH_START}: no node was entered`)) {
				last = index - 1;
				break;
			}
		}
	}

	const tallyOf = (key: string) => {
		result.byModel[key] ??= emptyTally();
		return result.byModel[key];
	};
	const visitModel = (visit: VisitReport) => visit.models[0] ?? UNKNOWN_MODEL;
	let visit: VisitReport | undefined;
	const close = (at: string | undefined) => {
		if (!visit) return;
		const from = ms(visit.startedAt);
		const to = ms(at);
		if (from !== undefined && to !== undefined) visit.durationMs = Math.max(0, to - from);
	};
	// After the end: the rest of the agent run that wrote it, own and tools only.
	let after: "no" | "counting" | "done" = "no";

	for (let index = first + 1; index < last; index++) {
		const entry = entries[index];
		const data = isFields(entry.data) ? entry.data : {};
		if (after === "done") break;
		if (entry.type === "custom") {
			if (after !== "no") continue;
			const at = atOf(entry) ?? "";
			if (entry.customType === GRAPH_NODE && typeof data.node === "string") {
				const node = graph.nodes[data.node];
				if (!node) continue;
				const via = data.via as NodeVia;
				close(at);
				if (visit) {
					visit.left = { via, to: data.node };
					visit.pending = undefined;
				}
				if (typeof data.edge === "number") result.edgesTaken.push(data.edge);
				visit = {
					visit: result.visits.length + 1,
					node: data.node,
					kind: node.kind,
					via,
					models: [],
					...(node.kind === "command" ? { run: node.run } : {}),
					startedAt: at,
					durationMs: 0,
					waitMs: 0,
					own: emptyTally(),
					tools: emptyTally(),
					other: {},
				};
				result.visits.push(visit);
			} else if (entry.customType === GRAPH_MOVE && visit && typeof data.edge === "number") {
				const edge = graph.edges[data.edge];
				if (edge) visit.pending = { to: edge.to };
			} else if (entry.customType === GRAPH_HALT && visit && typeof data.reason === "string") {
				result.halts.push({ visit: visit.visit, node: visit.node, reason: data.reason, at });
			} else if (entry.customType === GRAPH_BLOCKED && visit) {
				result.blocked.push({
					visit: visit.visit,
					node: typeof data.node === "string" ? data.node : visit.node,
					tool: typeof data.tool === "string" ? data.tool : "?",
					rule: typeof data.rule === "string" ? data.rule : "?",
					at,
				});
			} else if (entry.customType === GRAPH_ASKED && visit) {
				const answer = ANSWERS.find((known) => known === data.answer);
				if (answer && typeof data.node === "string" && typeof data.to === "string") {
					const askedAt = typeof data.askedAt === "string" ? data.askedAt : at;
					result.asked.push({ visit: visit.visit, node: data.node, to: data.to, answer, askedAt, at });
					const from = ms(askedAt);
					const to = ms(at);
					if (from !== undefined && to !== undefined) visit.waitMs += Math.max(0, to - from);
				}
			} else if (entry.customType === GRAPH_END) {
				close(at);
				result.status = result.status === "error" ? "error" : "ended";
				result.endedAt = at;
				const reason = data.reason as EndReason;
				result.endReason = reason;
				if (visit) {
					visit.ended = reason;
					visit.pending = undefined;
				}
				after = data.duringRun === true ? "counting" : "done";
			}
			continue;
		}
		if (entry.type === "custom_message" && entry.customType === GRAPH_COMMAND) {
			if (after !== "no") continue;
			const details = readDetails(entry.details);
			if (details) {
				// A message sent while another turn ran can land after its visit: match it by node and start time.
				const started = ms(details.startedAt) ?? 0;
				const owner =
					[...result.visits]
						.reverse()
						.find((candidate) => candidate.node === details.node && (ms(candidate.startedAt) ?? 0) <= started) ??
					visit;
				if (owner) owner.command = details;
			}
			continue;
		}
		if (!visit) continue;
		if (entry.type === "message" && entry.message) {
			const { role } = entry.message;
			if (role === "user") {
				if (after === "counting") break;
				continue;
			}
			if (role === "assistant" && entry.message.usage) {
				const key = `${entry.message.provider ?? "?"}/${entry.message.model ?? "?"}`;
				if (!isVirtual(key) && !visit.models.includes(key)) visit.models.push(key);
				add(visit.own, entry.message.usage, true);
				add(tallyOf(isVirtual(key) ? visitModel(visit) : key), entry.message.usage, true);
				if (after === "counting" && !hasToolCall(entry.message.content)) after = "done";
			} else if (role === "toolResult" && entry.message.usage) {
				add(visit.tools, entry.message.usage);
				add(tallyOf(NESTED_CALLS), entry.message.usage);
			}
			continue;
		}
		if (entry.type === "usage" && entry.usage) {
			if (entry.kind === "nested_tool_calls") {
				add(visit.tools, entry.usage);
				const key = `${entry.provider ?? "?"}/${entry.model ?? "?"}`;
				add(tallyOf(isVirtual(key) ? NESTED_CALLS : key), entry.usage);
				continue;
			}
			if (after !== "no") continue;
			const kind = entry.kind ?? "usage";
			visit.other[kind] ??= emptyTally();
			add(visit.other[kind], entry.usage);
			const key = `${entry.provider ?? "?"}/${entry.model ?? "?"}`;
			add(tallyOf(isVirtual(key) ? visitModel(visit) : key), entry.usage);
			continue;
		}
		if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) {
			if (after !== "no") continue;
			visit.other[entry.type] ??= emptyTally();
			add(visit.other[entry.type], entry.usage);
			add(tallyOf(visitModel(visit)), entry.usage);
		}
	}

	if (result.status === "running" && visit) {
		const from = ms(visit.startedAt);
		if (from !== undefined) visit.durationMs = Math.max(0, now - from);
	}
	if (state.status === "running") {
		result.node = state.node;
		result.halted = state.halted;
	} else if (visit) {
		result.node = visit.node;
	}
	for (const each of result.visits) {
		result.total.durationMs += each.durationMs;
		sum(result.total.own, each.own);
		sum(result.total.tools, each.tools);
		for (const tally of Object.values(each.other)) sum(result.total.other, tally);
	}
	result.total.cost = result.total.own.cost + result.total.tools.cost + result.total.other.cost;
	return result;
}

/** The total cost of a visit. */
export function visitCost(visit: VisitReport): number {
	return visit.own.cost + visit.tools.cost + Object.values(visit.other).reduce((all, tally) => all + tally.cost, 0);
}

/** The graph as Mermaid (`flowchart LR`), with the current node and the edges taken marked. */
export function mermaid(graph: Graph, run?: GraphReport): string {
	const ids = new Map<string, string>();
	for (const [index, node] of Object.keys(graph.nodes).entries()) ids.set(node, `n${index}`);
	ids.set(END, "n_end");
	const label = (text: string) => text.replaceAll('"', "#quot;");
	const lines = ["flowchart LR"];
	for (const [node, definition] of Object.entries(graph.nodes)) {
		const id = ids.get(node);
		lines.push(definition.kind === "command" ? `  ${id}[["${label(node)}"]]` : `  ${id}["${label(node)}"]`);
	}
	if (graph.edges.some((edge) => edge.to === END)) lines.push(`  ${ids.get(END)}(("end"))`);
	const taken = new Set(run?.edgesTaken ?? []);
	const links: number[] = [];
	graph.edges.forEach((edge, index) => {
		const text = edge.max === undefined ? edge.exit : `${edge.exit} ≤${edge.max}`;
		lines.push(`  ${ids.get(edge.from)} -->|${label(text)}| ${ids.get(edge.to)}`);
		if (taken.has(index)) links.push(index);
	});
	if (run) {
		const visited = [...new Set(run.visits.map((visit) => visit.node))];
		lines.push("  classDef visited fill:#e8f0fe,stroke:#4a6fa5");
		lines.push("  classDef current fill:#fff3c4,stroke:#b08800,stroke-width:3px");
		const others = visited.filter((node) => node !== run.node);
		if (others.length > 0) lines.push(`  class ${others.map((node) => ids.get(node)).join(",")} visited`);
		if (run.node !== undefined && ids.has(run.node)) lines.push(`  class ${ids.get(run.node)} current`);
		if (links.length > 0) lines.push(`  linkStyle ${links.join(",")} stroke-width:3px`);
	}
	return lines.join("\n");
}

function duration(msValue: number): string {
	const seconds = Math.round(msValue / 1000);
	if (msValue < 1000) return `${(msValue / 1000).toFixed(1)}s`;
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

const money = (cost: number) => `$${cost.toFixed(cost > 0 && cost < 0.01 ? 4 : 2)}`;

function tokens(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1000) return `${Math.round(value / 1000)}k`;
	return String(value);
}

function cut(text: string, width: number): string {
	const flat = text.replace(/\s+/g, " ");
	return flat.length > width ? `${flat.slice(0, Math.max(1, width - 1))}…` : flat;
}

/** The report as text, for `/graph`. */
export function formatReport(run: GraphReport): string {
	const state =
		run.status === "running"
			? `running · node ${run.node ?? "?"}${run.halted === undefined ? "" : ` (halted: ${run.halted})`}`
			: run.status === "ended"
				? `ended (${run.endReason ?? "?"}) in ${run.node ?? "?"}`
				: `cannot be read: ${run.error ?? "?"}`;
	const lines = [`${run.graph} (${run.path}) · ${state}`];
	const rows = run.visits.map((visit) => {
		const what = visit.kind === "command" ? (visit.run ?? "") : visit.models.join(", ") || "—";
		const cost = visit.kind === "command" && visitCost(visit) === 0 ? "—" : money(visitCost(visit));
		const cache =
			visit.own.cacheRead + visit.own.cacheWrite === 0
				? "—"
				: `${tokens(visit.own.cacheRead)}/${tokens(visit.own.cacheWrite)}`;
		const time = visit.command ? duration(visit.command.durationMs) : duration(visit.durationMs);
		const left = visit.left
			? `${visit.left.via} → ${visit.left.to}`
			: visit.ended
				? `ended (${visit.ended})`
				: `(now)${visit.pending ? ` → ${visit.pending.to} pending` : ""}`;
		const tools = visit.tools.cost > 0 ? ` (tools ${money(visit.tools.cost)})` : "";
		return [String(visit.visit), visit.node, visit.kind, cut(what, 28), time, `${cost}${tools}`, cache, left];
	});
	const header = ["#", "node", "kind", "model / command", "time", "cost", "cache r/w", "left by"];
	const widths = header.map((title, column) => Math.max(title.length, ...rows.map((row) => row[column].length)));
	const line = (cells: string[]) =>
		cells
			.map((cell, column) => (column === cells.length - 1 ? cell : cell.padEnd(widths[column])))
			.join("  ")
			.trimEnd();
	lines.push(line(header), ...rows.map(line));
	if (run.asked.length > 0) {
		lines.push(
			`asked: ${run.asked.map((asked) => `${asked.node} → ${asked.to} ${asked.answer} (${asked.visit})`).join(" · ")}`,
		);
	}
	for (const blocked of run.blocked) {
		lines.push(`blocked: visit ${blocked.visit} ${blocked.node}: ${blocked.tool} (${blocked.rule})`);
	}
	for (const halt of run.halts) lines.push(`halted: visit ${halt.visit} ${halt.node}: ${halt.reason}`);
	const models = Object.entries(run.byModel)
		.filter(([, tally]) => tally.cost > 0 || tally.requests > 0)
		.map(([key, tally]) => `${key} ${money(tally.cost)}`);
	const toolsTotal = run.total.tools.cost > 0 ? ` (tools ${money(run.total.tools.cost)})` : "";
	lines.push(
		`total ${duration(run.total.durationMs)} · ${money(run.total.cost)}${toolsTotal}${models.length > 0 ? ` · ${models.join(" · ")}` : ""}`,
	);
	lines.push(`not counted: ${run.notCounted.join("; ")}`);
	return lines.join("\n");
}
