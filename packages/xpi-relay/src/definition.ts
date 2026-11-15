// The relay's control flow as rows on the graph engine: `transition(view, event, config)` says what an event does to
// the view and which effects follow. It is pure: it reads nothing and writes nothing, so every (view, event) pair can
// be tested. `relay.ts` builds the view from the session entries, calls this, and carries out the effects. The rows
// are in the order of decision; where two match the earlier one wins. See docs/relay.md.

import type { ToolResultSignal } from "xpi-ai";
import { defineGraph, transition as graphTransition, type Row } from "./graph/graph.ts";
import { HANDOVER_SIGNAL, handoverResult, type RelayState } from "./router.ts";

/** Times a role is corrected or continued before the machine hands the work back as blocked (or, for the lead, stops). */
export const MAX_REPAIRS = 2;

/**
 * What the machine decides on: the router state stored on the branch, plus what the extension reads from its entries.
 * The stored state changes only at the next request (`route()`), so a hand-off made in this response is `pending`.
 */
export interface RelayView extends RelayState {
	/** A `handover` or `handback` was made in this response and the stored state has not caught up. */
	pending?: "handover" | "handback";
	/** The pending hand back is `blocked`. */
	blocked: boolean;
	/** Wrong-role calls since the latest handover or hand back. */
	mixups: number;
	/** Continuations after a relay error since the latest handover or hand back. */
	stalls: number;
	/** The worker's phase is paused: another model is selected. */
	paused: boolean;
	/** The user asked for a hand back with `/handback`: the acceptance commands are skipped. */
	userAsked: boolean;
}

export function initialView(state?: RelayState): RelayView {
	return {
		phase: state?.phase ?? "lead",
		round: state?.round ?? 0,
		...(state?.limit ? { limit: state.limit } : {}),
		blocked: false,
		mixups: 0,
		stalls: 0,
		paused: false,
		userAsked: false,
	};
}

/** Who has the work once the pending hand-off takes effect, and in which round. */
export function effectiveState(view: RelayView): RelayState {
	if (view.pending === "handover") return { phase: "worker", round: view.round + 1 };
	if (view.pending === "handback") return { phase: "lead", round: view.round };
	return { phase: view.phase, round: view.round, ...(view.limit ? { limit: view.limit } : {}) };
}

export type RelayEvent =
	/** The `handover` tool, or `/handover`. */
	| { type: "handover"; byUser: boolean }
	/** The `handback` tool, or `/handback`. */
	| { type: "handback"; status: "done" | "blocked"; byUser: boolean }
	/**
	 * A run settles. `afterRelayError`: its last turn ended right after a `relay.mixup`. `handoverLanded` (default true):
	 * the handover's signal really reached a tool result; false when the call was cut off after its entry was written.
	 * `workerIdle`: the worker has made no tool call since the handover (it answered with text only).
	 */
	| { type: "run_end"; afterRelayError: boolean; handoverLanded?: boolean; workerIdle?: boolean }
	/** The acceptance commands ran. `attempt`: how many times they failed before this run. */
	| { type: "acceptance"; passed: boolean; attempt: number }
	| { type: "model_away" }
	| { type: "model_back" }
	/** A tool of the other role was called. */
	| { type: "wrong_role"; tool: "handover" | "handback" }
	/**
	 * The router raised the stuck guard: the phase has written `compactions` summaries under its context limit, and the
	 * state it stored now says `to` (`lifted`: the limit is gone; `asked`: the worker is asked to hand back).
	 */
	| { type: "limit_reached"; compactions: number; to: "lifted" | "asked" };

export type EntryKind =
	| "relay.handover"
	| "relay.handback"
	| "relay.mixup"
	| "relay.stall"
	| "relay.pause"
	| "relay.resume"
	| "relay.transition"
	| "relay.verify"
	/** The stuck guard acted on a context limit. */
	| "relay.limit"
	/** A pending hand-off that never took effect is voided. */
	| "relay.void";

export type Effect =
	/** The tool call's result. `terminate` ends the script and the turn. `signal` is kept on the result for the host. */
	| { type: "result"; text: string; isError?: boolean; terminate?: boolean; signal?: ToolResultSignal }
	/** A custom entry on the branch. Without `data` the executor supplies it (the call's own arguments). */
	| { type: "append_entry"; entry: EntryKind; data?: Record<string, unknown> }
	| { type: "run_acceptance" }
	/** Compact the conversation to the hand-back record, and wake the lead. */
	| { type: "compact_record" }
	/** Go on with the same role: after a relay error (`role_reminder`) or a failed acceptance run (`acceptance_failure`). */
	| {
			type: "continue_with";
			kind: "role_reminder" | "acceptance_failure" | "worker_starts";
			/** For `role_reminder`: why the role is continued. */
			reason?: StallReason;
	  }
	/** Tell the user: a line in the TUI. */
	| { type: "notify"; text: string; level?: "info" | "warning" }
	/** `/handback`: ask the worker to stop and report. */
	| { type: "steer"; kind: "report" | "limit" };

export interface MachineConfig {
	/** Times failed acceptance commands go back to the worker. */
	maxRounds: number;
	/** What the stuck guard does to the worker; `"lift"` when absent. */
	whenStuck?: "lift" | "handback";
}

export interface Transition {
	next: RelayView;
	effects: Effect[];
}

const BLOCKED_BY_MIXUP = "The worker mixed up its role twice";
export type StallReason = "error" | "idle";

const BLOCKED_BY_STALL: Record<StallReason, string> = {
	error: "The worker stopped after relay errors",
	idle: "The worker stopped without doing any work",
};

function refuse(view: RelayView, text: string): Transition {
	return { next: view, effects: [{ type: "result", text, isError: true }] };
}

/** What is pending says which hand-off it is, whichever tool was called. */
function already(view: RelayView): Transition {
	const what = view.pending === "handback" ? "back" : "over";
	return { next: view, effects: [{ type: "result", text: `Already handed ${what}.` }] };
}

function transitionEntry(from: string, to: string, event: string, round: number): Effect {
	return { type: "append_entry", entry: "relay.transition", data: { from, to, event, round } };
}

/** The lead has the work again: the view after a hand back is processed. */
function leadAgain(view: RelayView): RelayView {
	const { limit: _limit, ...rest } = view;
	return { ...rest, phase: "lead", pending: undefined, blocked: false, mixups: 0, stalls: 0, userAsked: false };
}

function handBackBlocked(view: RelayView, report: string): Transition {
	return {
		next: { ...view, pending: "handback", blocked: true },
		effects: [{ type: "append_entry", entry: "relay.handback", data: { status: "blocked", report } }],
	};
}

/** The worker's run ended: verify (or skip it) and hand back. */
function endWorkerRun(view: RelayView): Transition {
	const skip = view.blocked || view.userAsked;
	if (skip) {
		return {
			next: leadAgain(view),
			effects: [{ type: "compact_record" }, transitionEntry("worker", "lead", "handback", view.round)],
		};
	}
	return { next: view, effects: [{ type: "run_acceptance" }] };
}

type EventOf<T extends RelayEvent["type"]> = Extract<RelayEvent, { type: T }>;
type RelayRow = Row<RelayView, RelayEvent, Effect, MachineConfig>;

/** A row whose guard and step see the event narrowed to the types the row answers. */
function row<T extends RelayEvent["type"]>(definition: {
	from: RelayRow["from"];
	on: T | readonly T[];
	when?(view: RelayView, event: EventOf<T>, config: MachineConfig): boolean;
	doc: RelayRow["doc"];
	to?: string;
	diagram?: false;
	label?: string;
	step(view: RelayView, event: EventOf<T>, config: MachineConfig): Transition;
}): RelayRow {
	return definition as unknown as RelayRow;
}

const nothing = (view: RelayView): Transition => ({ next: view, effects: [] });

function stall(view: RelayView, role: "lead" | "worker", reason: StallReason = "error"): Transition {
	const what = reason === "idle" ? "stopped without working" : "stopped after an error";
	return {
		next: { ...view, stalls: view.stalls + 1 },
		effects: [
			{ type: "append_entry", entry: "relay.stall", data: { role, reason } },
			{
				type: "notify",
				text: `relay: ${role} ${what}, continued (${view.stalls + 1} of ${MAX_REPAIRS})`,
				level: "warning",
			},
			{ type: "continue_with", kind: "role_reminder", reason },
		],
	};
}

const skipsAcceptance = (view: RelayView) => view.blocked || view.userAsked;

/** Why a worker's run that made no hand back counts as a stall, if it does. */
function stallReason(view: RelayView, event: EventOf<"run_end">): StallReason | undefined {
	// A worker that answered with text only, without a tool call and without a hand back, took the lead's messages for
	// its own: it counts as a stall too, unless the user asked it to stop.
	if (event.afterRelayError) return "error";
	return event.workerIdle === true && !view.userAsked && !view.blocked ? "idle" : undefined;
}

function handedOver(view: RelayView): RelayView {
	const { limit: _limit, ...rest } = view;
	return { ...rest, pending: "handover", blocked: false, mixups: 0, stalls: 0, userAsked: false };
}

const ROWS: readonly RelayRow[] = [
	// ---- Hand-offs (the `handover` and `handback` tools and the commands) ----
	row({
		// A second call in the same response, including a parallel codemode call: one hand-off.
		from: "*",
		on: ["handover", "handback"],
		when: (view) => view.pending !== undefined,
		doc: {
			view: "any with a pending hand-off",
			event: "handover / handback",
			next: "unchanged",
			effects: 'result "Already handed over/back." (no error, not counted)',
		},
		step: (view) => already(view),
	}),
	row({
		from: "*",
		on: ["handover", "handback"],
		when: (view) => view.paused,
		diagram: false,
		doc: {
			view: "any, paused",
			event: "handover / handback",
			next: "unchanged",
			effects: 'refusal "The relay is paused: select relay/auto again."',
		},
		step: (view) => refuse(view, "The relay is paused: select relay/auto again."),
	}),
	row({
		from: "worker",
		on: "handover",
		diagram: false,
		doc: {
			view: "worker",
			event: "handover",
			next: "unchanged",
			effects: 'refusal "The worker already has the work."',
		},
		step: (view) => refuse(view, "The worker already has the work."),
	}),
	row({
		from: "lead",
		on: "handover",
		when: (_view, event) => !event.byUser,
		to: "worker",
		label: "handover",
		doc: {
			view: "lead",
			event: "handover",
			next: "pending worker, round + 1",
			effects: "`relay.handover` entry; a `relay.handover` signal on the result; the turn ends",
		},
		step: (view) => ({
			next: handedOver(view),
			effects: [
				{ type: "append_entry", entry: "relay.handover" },
				{
					type: "result",
					text: handoverResult(view.round + 1),
					terminate: true,
					signal: { type: HANDOVER_SIGNAL, data: { round: view.round + 1 } },
				},
			],
		}),
	}),
	row({
		from: "lead",
		on: "handover",
		to: "worker",
		doc: {
			view: "lead",
			event: "`/handover` (by the user)",
			next: "pending worker, round + 1",
			effects: "`relay.handover` entry; the host sends the user's message that starts the worker",
		},
		step: (view) => ({ next: handedOver(view), effects: [{ type: "append_entry", entry: "relay.handover" }] }),
	}),
	row({
		from: "lead",
		on: "handback",
		diagram: false,
		doc: {
			view: "lead",
			event: "handback",
			next: "unchanged",
			effects: 'refusal "The lead already has the work."',
		},
		step: (view) => refuse(view, "The lead already has the work."),
	}),
	row({
		// The worker reports with its own handback; this flag only skips the acceptance commands.
		from: "worker",
		on: "handback",
		when: (_view, event) => event.byUser,
		label: "/handback, the acceptance commands are skipped",
		doc: {
			view: "worker",
			event: "`/handback` (by the user)",
			next: "user asked: the acceptance commands are skipped",
			effects: "steer: ask the worker to stop and report",
		},
		step: (view) => ({ next: { ...view, userAsked: true }, effects: [{ type: "steer", kind: "report" }] }),
	}),
	row({
		from: "worker",
		on: "handback",
		to: "lead",
		label: "handback (the lead has the work after the run ends)",
		doc: {
			view: "worker",
			event: "handback",
			next: "pending hand back",
			effects: '`relay.handback` entry; "Handed back."; the turn ends',
		},
		step: (view, event) => ({
			next: { ...view, pending: "handback", blocked: event.status === "blocked" },
			effects: [
				{ type: "append_entry", entry: "relay.handback" },
				{ type: "result", text: "Handed back.", terminate: true },
			],
		}),
	}),

	// ---- A tool of the other role ----
	row({
		from: "*",
		on: "wrong_role",
		when: (view) => view.paused || view.pending !== undefined,
		diagram: false,
		doc: {
			view: "any, paused or with a pending hand-off",
			event: "wrong role",
			next: "unchanged",
			effects: 'refusal "Not now."',
		},
		step: (view) => refuse(view, "Not now."),
	}),
	row({
		from: "worker",
		on: "wrong_role",
		when: (view, event) => event.tool === "handover" && view.mixups === 0,
		diagram: false,
		doc: {
			view: "worker",
			event: "wrong role (handover), first time",
			next: "mixups 1",
			effects: "`relay.mixup`; an error with the correction",
		},
		step: (view) => ({
			next: { ...view, mixups: 1 },
			effects: [
				{ type: "append_entry", entry: "relay.mixup", data: { tool: "handover", role: "worker" } },
				{ type: "result", text: "Only the lead hands over. You are the worker.", isError: true },
				{ type: "notify", text: "relay: worker called handover, corrected (1 of 2)", level: "warning" },
			],
		}),
	}),
	row({
		from: "worker",
		on: "wrong_role",
		when: (_view, event) => event.tool === "handover",
		diagram: false,
		doc: {
			view: "worker",
			event: "wrong role (handover), second time",
			next: "pending hand back, blocked",
			effects: '`relay.mixup` and a blocked `relay.handback` ("The worker mixed up its role twice"); the turn ends',
		},
		step: (view) => {
			const blocked = handBackBlocked({ ...view, mixups: view.mixups + 1 }, BLOCKED_BY_MIXUP);
			return {
				next: blocked.next,
				effects: [
					{ type: "append_entry", entry: "relay.mixup", data: { tool: "handover", role: "worker" } },
					...blocked.effects,
					{ type: "result", text: "Handed back as blocked: the roles were mixed up.", terminate: true },
					{ type: "notify", text: "relay: roles mixed up twice, handed back as blocked", level: "warning" },
				],
			};
		},
	}),
	row({
		from: "lead",
		on: "wrong_role",
		when: (_view, event) => event.tool === "handback",
		diagram: false,
		doc: {
			view: "lead",
			event: "wrong role (handback)",
			next: "mixups + 1",
			effects: "`relay.mixup`; an error with the correction (the lead is never handed back for)",
		},
		step: (view) => ({
			next: { ...view, mixups: view.mixups + 1 },
			effects: [
				{ type: "append_entry", entry: "relay.mixup", data: { tool: "handback", role: "lead" } },
				{ type: "result", text: "Only the worker hands back. You are the lead.", isError: true },
				{ type: "notify", text: `relay: lead called handback, corrected (${view.mixups + 1})`, level: "warning" },
			],
		}),
	}),

	// ---- The end of a run ----
	row({
		from: "*",
		on: "run_end",
		when: (view) => view.paused,
		diagram: false,
		doc: { view: "any, paused", event: "run ends", next: "unchanged", effects: "none" },
		step: nothing,
	}),
	row({
		// A handover ends the lead's turn (terminate); the worker answers the next request.
		from: "lead",
		on: "run_end",
		when: (view, event) => view.pending === "handover" && event.handoverLanded === false,
		diagram: false,
		doc: {
			view: "lead, run ends with a pending handover whose result did not carry the signal",
			event: "run ends",
			next: "pending voided",
			effects: "`relay.void`; a line; the lead goes on",
		},
		step: (view) => ({
			next: { ...view, pending: undefined },
			effects: [
				{ type: "append_entry", entry: "relay.void", data: { what: "handover" } },
				{
					type: "notify",
					text: "relay: a handover did not take effect (its call was cut off), voided",
					level: "warning",
				},
			],
		}),
	}),
	row({
		from: "lead",
		on: "run_end",
		when: (view) => view.pending === "handover",
		diagram: false,
		doc: {
			view: "lead, run ends with a pending handover",
			event: "run ends",
			next: "unchanged",
			effects: "continue: the worker answers next",
		},
		step: (view) => ({ next: view, effects: [{ type: "continue_with", kind: "worker_starts" }] }),
	}),
	row({
		from: "lead",
		on: "run_end",
		when: (view, event) => event.afterRelayError && view.stalls < MAX_REPAIRS,
		diagram: false,
		doc: {
			view: "lead",
			event: "run ends after a relay error, stalls < 2",
			next: "stalls + 1",
			effects: "`relay.stall`; continue with a role reminder",
		},
		step: (view) => stall(view, "lead"),
	}),
	row({
		from: "lead",
		on: "run_end",
		when: (_view, event) => event.afterRelayError,
		diagram: false,
		doc: {
			view: "lead",
			event: "run ends after a relay error, stalls = 2",
			next: "unchanged",
			effects: "none: the run ends; you see it",
		},
		step: nothing,
	}),
	row({
		from: "worker",
		on: "run_end",
		when: (view) => view.pending === "handback" && skipsAcceptance(view),
		to: "lead",
		label: "run ends, blocked or asked by the user, the record",
		doc: {
			view: "worker, a blocked hand back or one the user asked for",
			event: "run ends with a pending hand back",
			next: "lead, mixups 0, stalls 0",
			effects: "compact to the record; `relay.transition` (no acceptance commands)",
		},
		step: (view) => endWorkerRun(view),
	}),
	row({
		from: "worker",
		on: "run_end",
		when: (view) => view.pending === "handback",
		label: "run ends, run the acceptance commands",
		doc: {
			view: "worker",
			event: "run ends with a pending hand back",
			next: "acceptance",
			effects: "run the acceptance commands",
		},
		step: (view) => endWorkerRun(view),
	}),
	row({
		from: "worker",
		on: "run_end",
		when: (view, event) => stallReason(view, event) !== undefined && view.stalls < MAX_REPAIRS,
		diagram: false,
		doc: {
			view: "worker",
			event: "run ends after a relay error, or with no tool call since the handover and no hand back (text only); stalls < 2",
			next: "stalls + 1",
			effects:
				"`relay.stall` (reason `error` or `idle`); continue with a role reminder (`idle`: that the handover happened)",
		},
		step: (view, event) => stall(view, "worker", stallReason(view, event)),
	}),
	row({
		from: "worker",
		on: "run_end",
		when: (view, event) => stallReason(view, event) !== undefined,
		to: "lead",
		label: "run ends after repeated stalls, blocked hand back and the record",
		doc: {
			view: "worker",
			event: "the same, stalls = 2",
			next: "hand back, blocked",
			effects:
				'a blocked hand back ("The worker stopped after relay errors" or "...without doing any work") and the record',
		},
		step: (view, event) => {
			const reason = stallReason(view, event) as StallReason;
			const blocked = handBackBlocked(view, BLOCKED_BY_STALL[reason]);
			const ended = endWorkerRun(blocked.next);
			return {
				next: ended.next,
				effects: [
					...blocked.effects,
					{
						type: "notify",
						text:
							reason === "idle"
								? "relay: worker stopped without working, handed back as blocked"
								: "relay: worker stopped after errors, handed back as blocked",
						level: "warning",
					},
					...ended.effects,
				],
			};
		},
	}),
	row({
		from: "worker",
		on: "run_end",
		when: (view) => skipsAcceptance(view),
		to: "lead",
		label: "run ends, blocked or asked by the user, the record",
		doc: {
			view: "worker, blocked or the user asked",
			event: "run ends (otherwise)",
			next: "lead, mixups 0, stalls 0",
			effects: "compact to the record; `relay.transition` (no acceptance commands)",
		},
		step: (view) => endWorkerRun(view),
	}),
	row({
		from: "worker",
		on: "run_end",
		label: "run ends, run the acceptance commands",
		doc: {
			view: "worker",
			event: "run ends (otherwise)",
			next: "acceptance",
			effects: "run the acceptance commands",
		},
		step: (view) => endWorkerRun(view),
	}),

	// ---- The acceptance commands ran ----
	row({
		from: "worker",
		on: "acceptance",
		when: (view, event, config) => !view.paused && !event.passed && event.attempt < config.maxRounds,
		label: "acceptance failed, below maxRounds, back to the worker",
		doc: {
			view: "worker",
			event: "acceptance failed, failures so far < `maxRounds`",
			next: "unchanged",
			effects: "`relay.verify`; continue with the failure output",
		},
		step: (view, event, config) => ({
			next: view,
			effects: [
				{ type: "append_entry", entry: "relay.verify", data: { attempt: event.attempt + 1 } },
				{
					type: "notify",
					text: `relay: acceptance failed (${event.attempt + 1} of ${config.maxRounds}), back to the worker`,
					level: "warning",
				},
				{ type: "continue_with", kind: "acceptance_failure" },
			],
		}),
	}),
	row({
		from: "worker",
		on: "acceptance",
		when: (view) => !view.paused,
		to: "lead",
		label: "acceptance passed, or no retries left, the record",
		doc: {
			view: "worker",
			event: "acceptance passed, failed at `maxRounds`, or nothing to run",
			next: "lead, mixups 0, stalls 0",
			effects: "compact to the record; `relay.transition`",
		},
		step: (view) => ({
			next: leadAgain(view),
			effects: [{ type: "compact_record" }, transitionEntry("worker", "lead", "handback", view.round)],
		}),
	}),

	// ---- The stuck guard of a context limit ----
	row({
		from: "worker",
		on: "limit_reached",
		when: (_view, event) => event.to === "asked",
		label: "limit reached, the worker is asked to hand back",
		doc: {
			view: "worker",
			event: "stuck guard: the worker's context limit compacted `maxCompactions` times, `whenStuck` is `handback`",
			next: "limit asked (the limit stays; lifted after two more summaries)",
			effects:
				"`relay.limit` entry (`handback`); notification; steer: ask the worker to hand back `blocked` with what is done and left",
		},
		step: (view, event) => ({
			next: { ...view, limit: "asked" },
			effects: [
				{
					type: "append_entry",
					entry: "relay.limit",
					data: { action: "handback", compactions: event.compactions },
				},
				{
					type: "notify",
					text: `relay: worker compacted ${event.compactions} times in round ${view.round}, asked to hand back`,
					level: "warning",
				},
				{ type: "steer", kind: "limit" },
			],
		}),
	}),
	row({
		from: "*",
		on: "limit_reached",
		label: "limit reached, the limit is lifted",
		doc: {
			view: "any",
			event: "stuck guard: `maxCompactions` summaries under the limit (worker: `whenStuck` is `lift`, or two more after the ask)",
			next: "limit lifted until the next handover",
			effects: "`relay.limit` entry (`lifted`); notification",
		},
		step: (view, event) => ({
			next: { ...view, limit: "lifted" },
			effects: [
				{ type: "append_entry", entry: "relay.limit", data: { action: "lifted", compactions: event.compactions } },
				{
					type: "notify",
					text: `relay: ${view.phase} compacted ${event.compactions} times in round ${view.round}, limit lifted`,
					level: "warning",
				},
			],
		}),
	}),

	// ---- The selected model changes ----
	row({
		from: "worker",
		on: "model_away",
		when: (view) => !view.paused,
		diagram: false,
		doc: {
			view: "worker",
			event: "another model selected",
			next: "paused",
			effects: "`relay.pause`; notification",
		},
		step: (view) => ({
			next: { ...view, paused: true },
			effects: [
				{ type: "append_entry", entry: "relay.pause", data: { round: view.round } },
				{ type: "notify", text: `relay paused (worker phase, round ${view.round})`, level: "warning" },
			],
		}),
	}),
	row({
		from: "*",
		on: "model_back",
		when: (view) => view.paused,
		diagram: false,
		doc: { view: "paused", event: "`relay/auto` selected", next: "worker", effects: "`relay.resume`; notification" },
		step: (view) => ({
			next: { ...view, paused: false },
			effects: [
				{ type: "append_entry", entry: "relay.resume", data: { round: view.round } },
				{ type: "notify", text: `relay resumed (worker phase, round ${view.round})` },
			],
		}),
	}),
];

/**
 * The relay's graph. A pair that no row names changes nothing and answers with a refusal (a tool call) or no effects.
 * The pending, paused, blocked, user-asked, mixup and stall flags of the view are not states: the rows read them.
 */
export const relayGraph = defineGraph<RelayView, RelayEvent, Effect, MachineConfig>({
	name: "relay",
	stateOf: (view) => view.phase,
	states: ["lead", "worker"],
	events: ["handover", "handback", "run_end", "acceptance", "model_away", "model_back", "wrong_role", "limit_reached"],
	rows: ROWS,
	otherwise: {
		// `handover` and `handback` are answered by a row in every phase, so those two are never reached. The rest:
		// `wrong_role` (a tool that is not the role's own) is refused; `run_end` (a lead run that needs nothing),
		// `acceptance` (the lead's phase), `model_away` (the lead's phase, or already paused) and `model_back` (not
		// paused) change nothing.
		handover: nothing,
		handback: nothing,
		wrong_role: (view) => refuse(view, "Not your tool."),
		run_end: nothing,
		acceptance: nothing,
		model_away: nothing,
		model_back: nothing,
		limit_reached: nothing,
	},
});

/** What `event` does to `view`, and the effects that follow. */
export function transition(view: RelayView, event: RelayEvent, config: MachineConfig): Transition {
	const { next, effects } = graphTransition(relayGraph, view, event, config);
	return { next, effects };
}
