// The step list of a round: short lines the lead gives with a handover, which the worker ticks off as it goes. It is
// state on the branch (the handover's `steps` and `relay.step` entries), so a compaction cannot lose it, and it is
// what the user watches. Nothing enforces it: a hand back with open steps is a hand back, and the acceptance commands
// stay the only hard check.

import type { RelayEntry } from "./entry.ts";
import type { Handover } from "./record.ts";
import { HANDOVER_ENTRY, ROUND_ENTRY, VOID_ENTRY } from "./view.ts";

/** The worker's tool. */
export const STEP_TOOL = "step";
/** One change of the list by the worker: `{ round, n, status, note? }` or `{ round, add }`. */
export const STEP_ENTRY = "relay.step";
/** Steps a round may hold, the lead's and the worker's together. */
export const MAX_STEPS = 30;
/** Characters of one step; a longer line is cut. A step is a label, the plan holds the detail. */
export const STEP_CHARS = 160;

/** One step's text: one line, without a list marker or number the model put in front, cut to `STEP_CHARS`. */
function stepText(value: string): string {
	const line = value
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^(?:[-*•](?:\s+|$)|\[[ xX-]?\]\s*|\(?\d{1,2}[.):](?:\s+|$))+/, "")
		.trim();
	return line.length <= STEP_CHARS ? line : `${line.slice(0, STEP_CHARS - 3).trimEnd()}...`;
}

export interface Step {
	text: string;
	status: "todo" | "done" | "skipped";
	/** Why a step was skipped. */
	note?: string;
	by: "lead" | "worker";
}

export interface StepList {
	round: number;
	steps: Step[];
	/** The round was handed back. */
	handedBack: boolean;
	/** The user wrote after the hand back: the list is history. */
	closed: boolean;
}

export interface StepParams {
	n?: number;
	status?: "done" | "skipped";
	note?: string;
	add?: string;
}

/** The lines of a handover's `steps`, trimmed, without empty ones. Throws for a wrong shape. */
export function cleanSteps(value: unknown): string[] | undefined {
	if (value === undefined || value === null) return undefined;
	if (!Array.isArray(value) || value.some((line) => typeof line !== "string")) {
		throw new Error("steps must be a list of strings");
	}
	const lines = (value as string[]).map(stepText).filter((line) => line !== "");
	if (lines.length > MAX_STEPS) throw new Error(`steps holds ${lines.length} lines; at most ${MAX_STEPS}`);
	return lines.length > 0 ? lines : undefined;
}

/** The step list of the latest handover on the branch, with the worker's changes applied. Undefined: it gave none. */
export function readSteps(branch: readonly RelayEntry[]): StepList | undefined {
	let list: StepList | undefined;
	for (const entry of branch) {
		if (entry.type === "custom") {
			if (entry.customType === HANDOVER_ENTRY) {
				const handover = entry.data as Handover;
				list = handover.steps?.length
					? {
							round: handover.round,
							steps: handover.steps.map((text) => ({ text, status: "todo", by: "lead" })),
							handedBack: false,
							closed: false,
						}
					: undefined;
			} else if (entry.customType === STEP_ENTRY && list) {
				const data = (entry.data ?? {}) as StepParams & { round?: number };
				if (data.round !== list.round) continue;
				if (typeof data.add === "string") list.steps.push({ text: data.add, status: "todo", by: "worker" });
				else if (typeof data.n === "number" && list.steps[data.n - 1] && data.status) {
					const step = list.steps[data.n - 1]!;
					step.status = data.status;
					if (data.status === "skipped" && data.note) step.note = data.note;
					else delete step.note;
				}
			} else if (entry.customType === ROUND_ENTRY && list) list.handedBack = true;
			// A handover whose result never reached the router did not happen: the lead goes on, without a list.
			else if (entry.customType === VOID_ENTRY) list = undefined;
		} else if (entry.type === "message" && list?.handedBack && entry.message.role === "user") list.closed = true;
	}
	return list;
}

/** What a `step` call changes: the entry to write and the result text. Throws what the worker is told. */
export function applyStep(list: StepList | undefined, params: StepParams): { data: StepParams; text: string } {
	if (!list) throw new Error("This round has no step list: the handover gave none. Go on with the plan.");
	const left = (steps: readonly Step[]) => {
		const open = steps.flatMap((step, index) => (step.status === "todo" ? [index + 1] : []));
		return open.length > 0 ? `Open: ${open.join(", ")}.` : "No step is open.";
	};
	const add = typeof params.add === "string" ? stepText(params.add) : "";
	if (typeof params.add === "string" && !add) throw new Error("add is empty: give the new step as one short line.");
	if (add) {
		if (params.n !== undefined) throw new Error("Give n with status, or add, not both.");
		if (list.steps.length >= MAX_STEPS) throw new Error(`The list is full (${MAX_STEPS} steps).`);
		const steps = [...list.steps, { text: add, status: "todo" as const, by: "worker" as const }];
		return { data: { add }, text: `Added step ${steps.length}. ${left(steps)}` };
	}
	const { n, status } = params;
	if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > list.steps.length) {
		throw new Error(`n must be a step number from 1 to ${list.steps.length}, or give add.`);
	}
	if (status !== "done" && status !== "skipped") throw new Error('status must be "done" or "skipped".');
	const note = status === "skipped" ? params.note?.replace(/\s+/g, " ").trim() || undefined : undefined;
	const steps = list.steps.map((step, index) => (index === n - 1 ? { ...step, status } : step));
	return { data: { n, status, ...(note ? { note } : {}) }, text: `Step ${n} ${status}. ${left(steps)}` };
}

const BOX = { todo: "[ ]", done: "[x]", skipped: "[-]" } as const;

/** The list for a model: one numbered line a step, with its state. */
export function renderSteps(steps: readonly Step[]): string[] {
	return steps.map((step, index) => {
		const tail = [
			step.status === "skipped" ? `skipped${step.note ? `: ${step.note}` : ""}` : "",
			step.by === "worker" ? "added by the worker" : "",
		].filter(Boolean);
		return `${index + 1}. ${BOX[step.status]} ${step.text}${tail.length > 0 ? ` (${tail.join("; ")})` : ""}`;
	});
}

/** Step rows of the widget: with the title it stays under the ten lines a host widget may show. */
const WIDGET_ROWS = 8;

/**
 * The lines of the user's widget: who has the work, the round, the count, then the steps. Undefined: nothing to show
 * (no list, or the user moved on after the hand back).
 */
export function stepsWidget(branch: readonly RelayEntry[], workerModel: string): string[] | undefined {
	const list = readSteps(branch);
	if (!list || list.closed) return undefined;
	const closed = list.steps.filter((step) => step.status !== "todo").length;
	// From the handover on the list is the worker's, also in the moment before its first request.
	const who = list.handedBack ? "handed back to the lead" : `worker (${workerModel})`;
	const lines = [`relay round ${list.round} · ${who} · ${closed}/${list.steps.length}`];
	const current = list.steps.findIndex((step) => step.status === "todo");
	const rows = list.steps.map((step, index) => {
		const mark = step.status === "done" ? "✓" : step.status === "skipped" ? "–" : index === current ? "▸" : " ";
		const tail = [
			step.status === "skipped" && step.note ? `skipped: ${step.note}` : step.status === "skipped" ? "skipped" : "",
			step.by === "worker" ? "added by the worker" : "",
		].filter(Boolean);
		return `  ${mark} ${index + 1} ${step.text}${tail.length > 0 ? ` (${tail.join("; ")})` : ""}`;
	});
	// A long list folds the closed steps in front of the current one into one line, then leaves out the far end.
	let shown = rows;
	const lead = current < 0 ? list.steps.length : current;
	if (shown.length > WIDGET_ROWS && lead > 1) shown = [`  ✓ 1-${lead} closed`, ...rows.slice(lead)];
	if (shown.length > WIDGET_ROWS) {
		const more = shown.length - (WIDGET_ROWS - 1);
		shown = [...shown.slice(0, WIDGET_ROWS - 1), `    +${more} more`];
	}
	lines.push(...shown);
	return lines;
}
