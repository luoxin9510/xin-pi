// The relay's control flow as one table: `transition(view, event, config)` says what an event does to the view and
// which effects follow. It is pure: it reads nothing and writes nothing, so every (view, event) pair can be tested.
// `index.ts` builds the view from the session branch, calls this, and carries the effects out. See docs/relay.md.

import { handoverMarker, type RelayState } from "./router.ts";

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
	return { phase: view.phase, round: view.round };
}

export type RelayEvent =
	/** The `handover` tool, or `/handover`. */
	| { type: "handover"; byUser: boolean }
	/** The `handback` tool, or `/handback`. */
	| { type: "handback"; status: "done" | "blocked"; byUser: boolean }
	/** A run settles. `afterRelayError`: its last turn ended right after a `relay.mixup`. */
	| { type: "run_end"; afterRelayError: boolean }
	/** The acceptance commands ran. `attempt`: how many times they failed before this run. */
	| { type: "acceptance"; passed: boolean; attempt: number }
	| { type: "model_away" }
	| { type: "model_back" }
	/** A tool of the other role was called. */
	| { type: "wrong_role"; tool: "handover" | "handback" };

export type EntryKind =
	| "relay.handover"
	| "relay.handback"
	| "relay.mixup"
	| "relay.stall"
	| "relay.pause"
	| "relay.resume"
	| "relay.transition"
	| "relay.verify";

export type Effect =
	/** The tool call's result. `terminate` ends the script and the turn. */
	| { type: "result"; text: string; isError?: boolean; terminate?: boolean }
	/** A custom entry on the branch. Without `data` the executor supplies it (the call's own arguments). */
	| { type: "append_entry"; entry: EntryKind; data?: Record<string, unknown> }
	| { type: "run_acceptance" }
	/** Compact the conversation to the hand-back record, and wake the lead. */
	| { type: "compact_record" }
	/** Go on with the same role: after a relay error (`role_reminder`) or a failed acceptance run (`acceptance_failure`). */
	| { type: "continue_with"; kind: "role_reminder" | "acceptance_failure" | "worker_starts" }
	/** Tell the user: a line in the TUI. */
	| { type: "notify"; text: string; level?: "info" | "warning" }
	/** `/handback`: ask the worker to stop and report. */
	| { type: "steer"; kind: "report" };

export interface MachineConfig {
	/** Times failed acceptance commands go back to the worker. */
	maxRounds: number;
}

export interface Transition {
	next: RelayView;
	effects: Effect[];
}

const BLOCKED_BY_MIXUP = "The worker mixed up its role twice";
const BLOCKED_BY_STALL = "The worker stopped after relay errors";

function refuse(view: RelayView, text: string): Transition {
	return { next: view, effects: [{ type: "result", text, isError: true }] };
}

function already(view: RelayView, what: "over" | "back"): Transition {
	return { next: view, effects: [{ type: "result", text: `Already handed ${what}.` }] };
}

function transitionEntry(from: string, to: string, event: string, round: number): Effect {
	return { type: "append_entry", entry: "relay.transition", data: { from, to, event, round } };
}

/** The lead has the work again: the view after a hand back is processed. */
function leadAgain(view: RelayView): RelayView {
	return { ...view, phase: "lead", pending: undefined, blocked: false, mixups: 0, stalls: 0, userAsked: false };
}

function handBackBlocked(view: RelayView, report: string): Transition {
	return {
		next: { ...view, pending: "handback", blocked: true },
		effects: [{ type: "append_entry", entry: "relay.handback", data: { status: "blocked", report } }],
	};
}

/** The worker's run ended: verify (or skip it) and hand back. */
function endWorkerRun(view: RelayView, event: RelayEvent): Transition {
	const skip = view.blocked || view.userAsked;
	if (skip) {
		return {
			next: leadAgain(view),
			effects: [{ type: "compact_record" }, transitionEntry("worker", "lead", event.type, view.round)],
		};
	}
	return { next: view, effects: [{ type: "run_acceptance" }] };
}

/**
 * Rows, in order; where two match the earlier one wins. A pair that no row names changes nothing and answers with a
 * refusal (a tool call) or no effects.
 */
export function transition(view: RelayView, event: RelayEvent, config: MachineConfig): Transition {
	switch (event.type) {
		case "handover":
		case "handback": {
			// A second call in the same response, including a parallel codemode call: one hand-off.
			if (view.pending) return already(view, event.type === "handover" ? "over" : "back");
			if (view.paused) return refuse(view, "The relay is paused: select relay/auto again.");
			if (event.type === "handover") {
				if (view.phase !== "lead") return refuse(view, "The worker already has the work.");
				const next: RelayView = {
					...view,
					pending: "handover",
					blocked: false,
					mixups: 0,
					stalls: 0,
					userAsked: false,
				};
				return {
					next,
					effects: [
						{ type: "append_entry", entry: "relay.handover" },
						...(event.byUser
							? []
							: [{ type: "result", text: handoverMarker(view.round + 1), terminate: true } as const]),
					],
				};
			}
			if (view.phase !== "worker") return refuse(view, "The lead already has the work.");
			if (event.byUser) {
				// The worker reports with its own handback; this flag only skips the acceptance commands.
				return {
					next: { ...view, userAsked: true },
					effects: [{ type: "steer", kind: "report" }],
				};
			}
			return {
				next: { ...view, pending: "handback", blocked: event.status === "blocked" },
				effects: [
					{ type: "append_entry", entry: "relay.handback" },
					{ type: "result", text: "Handed back.", terminate: true },
				],
			};
		}

		case "wrong_role": {
			if (view.paused || view.pending) return refuse(view, "Not now.");
			if (event.tool === "handover" && view.phase === "worker") {
				const entry = {
					type: "append_entry",
					entry: "relay.mixup",
					data: { tool: "handover", role: "worker" },
				} as const;
				if (view.mixups === 0) {
					return {
						next: { ...view, mixups: 1 },
						effects: [
							entry,
							{ type: "result", text: "Only the lead hands over. You are the worker.", isError: true },
							{ type: "notify", text: "relay: worker called handover, corrected (1 of 2)", level: "warning" },
						],
					};
				}
				const blocked = handBackBlocked({ ...view, mixups: view.mixups + 1 }, BLOCKED_BY_MIXUP);
				return {
					next: blocked.next,
					effects: [
						entry,
						...blocked.effects,
						{ type: "result", text: "Handed back as blocked: the roles were mixed up.", terminate: true },
						{ type: "notify", text: "relay: roles mixed up twice, handed back as blocked", level: "warning" },
					],
				};
			}
			if (event.tool === "handback" && view.phase === "lead") {
				return {
					next: { ...view, mixups: view.mixups + 1 },
					effects: [
						{ type: "append_entry", entry: "relay.mixup", data: { tool: "handback", role: "lead" } },
						{ type: "result", text: "Only the worker hands back. You are the lead.", isError: true },
						{
							type: "notify",
							text: `relay: lead called handback, corrected (${view.mixups + 1})`,
							level: "warning",
						},
					],
				};
			}
			return refuse(view, "Not your tool.");
		}

		case "run_end": {
			if (view.paused) return { next: view, effects: [] };
			if (view.phase === "lead") {
				// A handover ends the lead's turn (terminate); the worker answers the next request.
				if (view.pending === "handover") {
					return { next: view, effects: [{ type: "continue_with", kind: "worker_starts" }] };
				}
				if (event.afterRelayError && view.stalls < MAX_REPAIRS) {
					return stall(view, "lead");
				}
				return { next: view, effects: [] };
			}
			// The worker's run.
			if (view.pending === "handback") return endWorkerRun(view, event);
			if (event.afterRelayError) {
				if (view.stalls < MAX_REPAIRS) return stall(view, "worker");
				const blocked = handBackBlocked(view, BLOCKED_BY_STALL);
				const ended = endWorkerRun(blocked.next, event);
				return {
					next: ended.next,
					effects: [
						...blocked.effects,
						{
							type: "notify",
							text: "relay: worker stopped after errors, handed back as blocked",
							level: "warning",
						},
						...ended.effects,
					],
				};
			}
			return endWorkerRun(view, event);
		}

		case "acceptance": {
			if (view.paused || view.phase !== "worker") return { next: view, effects: [] };
			if (!event.passed && event.attempt < config.maxRounds) {
				return {
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
				};
			}
			return {
				next: leadAgain(view),
				effects: [{ type: "compact_record" }, transitionEntry("worker", "lead", "handback", view.round)],
			};
		}

		case "model_away": {
			if (view.paused || view.phase !== "worker") return { next: view, effects: [] };
			return {
				next: { ...view, paused: true },
				effects: [
					{ type: "append_entry", entry: "relay.pause", data: { round: view.round } },
					{ type: "notify", text: `relay paused (worker phase, round ${view.round})`, level: "warning" },
				],
			};
		}

		case "model_back": {
			if (!view.paused) return { next: view, effects: [] };
			return {
				next: { ...view, paused: false },
				effects: [
					{ type: "append_entry", entry: "relay.resume", data: { round: view.round } },
					{ type: "notify", text: `relay resumed (worker phase, round ${view.round})` },
				],
			};
		}
	}
}

function stall(view: RelayView, role: "lead" | "worker"): Transition {
	return {
		next: { ...view, stalls: view.stalls + 1 },
		effects: [
			{ type: "append_entry", entry: "relay.stall", data: { role } },
			{
				type: "notify",
				text: `relay: ${role} stopped after an error, continued (${view.stalls + 1} of ${MAX_REPAIRS})`,
				level: "warning",
			},
			{ type: "continue_with", kind: "role_reminder" },
		],
	};
}
