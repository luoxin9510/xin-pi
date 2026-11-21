// wait extension entry: waits that do not hold a process (docs/wait.md, spec .scratch/xpi-durable/02-waits.md). The
// model calls `tools.wait` from codemode to end its run until a time, or until a shell check passes (with a deadline).
// The wait is written when the run ends (`xpi.wait`); while the session is open this file keeps a timer and runs the
// check through the session's tools (`ctx.runTool`, so blockers apply); when the wait ends it writes `xpi.wake` and the
// note the model reads (`xpi.woke`), and starts a run. In roost the worker lets go of its process meanwhile (milestone 2).
//
// Not in subagents: a child is not a session anyone wakes.

import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { AgentToolCallOutcome } from "xpi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import {
	nextCheckAt,
	pendingWait,
	WAIT_CUSTOM_TYPE,
	WAKE_CUSTOM_TYPE,
	type WaitData,
	type WakeWhy,
	WOKE_CUSTOM_TYPE,
} from "../../core/waits.ts";
import { clockTime, type ParsedWait, parseWait, shortDuration, tail, type WaitParams } from "./parse.ts";

export const WAIT_TOOL = "wait";

/** Timers, injectable for tests. */
export interface WaitClock {
	now(): number;
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

const realClock: WaitClock = {
	now: () => Date.now(),
	setTimeout: (fn, ms) => {
		const handle = setTimeout(fn, ms);
		// A timer never keeps a process up on its own (print mode exits at the end of its run).
		handle.unref?.();
		return handle;
	},
	clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/** setTimeout's limit: a longer wait is armed again when this one fires. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** How often a wake that found the session busy (a run, a compaction) tries again, besides the next settle. */
const RETRY_MS = 5_000;

const DESCRIPTION = [
	"Wait without holding a process: end this run and be woken later, at a time (after or at), or when a shell check passes",
	"(check, run every `every`; after or at is then the deadline). Use it instead of sleep or polling loops in bash, for",
	"example to wait for CI. Call it alone, as the last thing a script does: the script stops at this call and the run",
	"ends. When the wait ends you get an [xpi] note saying why (time reached, check passed, deadline, or the user came",
	"in), with the check's last output. At most 7 days; every is at least 30s (default 2m); each check run is limited to",
	"2 minutes and exit code 0 means the condition holds.",
].join(" ");

export function createWaitExtension(clock: WaitClock = realClock) {
	return function wait(pi: ExtensionAPI) {
		if (process.env.XPI_SUBAGENT_DEPTH) return;

		/** The wait this run asked for, written when the run ends. */
		let requested: ParsedWait | undefined;
		/** The session's current context, for timers. */
		let current: ExtensionContext | undefined;
		let timer: unknown;
		/** The retry of a deferred wake. */
		let retry: unknown;
		/** The check in progress: aborted by a user message, a wake, a shutdown. */
		let checking: AbortController | undefined;
		let checkCount = 0;
		/** The last output of a check (the note at the deadline says it). */
		let lastOutput: string | undefined;
		/** A wake that came while a run was active: done when the run settles. */
		let deferred: { id: string; why: WakeWhy; output?: string } | undefined;
		/** The wait written at this run's end: cancelled if the run still ends aborted (Esc during its end). */
		let writtenThisRun: string | undefined;

		/**
		 * Bumped when a session opens or closes: timers and checks outlive a session replacement or a shutdown, and one
		 * of an older session does nothing. (Not the context object: each event hands a new one for the same session.)
		 */
		let generation = 0;
		/** Run `fn` with the session's latest context for a timer or a check, if that session is still open. */
		const guarded = (gen: number, fn: (ctx: ExtensionContext) => void | Promise<void>) => {
			const ctx = current;
			if (gen !== generation || !ctx) return;
			try {
				const result = fn(ctx);
				if (result) void result.catch(() => {});
			} catch {
				// the session went away meanwhile
			}
		};

		const pending = (ctx: ExtensionContext): WaitData | undefined =>
			pendingWait(ctx.sessionManager.getBranch(), ctx.sessionManager.getEntries());
		const arms = (ctx: ExtensionContext) => ctx.mode === "tui" || ctx.mode === "rpc";

		const stop = () => {
			if (timer !== undefined) clock.clearTimeout(timer);
			timer = undefined;
			if (retry !== undefined) clock.clearTimeout(retry);
			retry = undefined;
			checking?.abort();
			checking = undefined;
		};

		const whyText = (wait: WaitData, why: WakeWhy, output: string | undefined): string => {
			const command = wait.check ? ` (${wait.check.command})` : "";
			switch (why) {
				case "due":
					return "its time came";
				case "check":
					return `the check passed${command}`;
				case "deadline":
					return `the deadline came and the check never passed${command}`;
				case "user":
					return "a user message came in";
				case "continue":
					return "the user woke it early with /continue";
				case "blocked":
					return `the check was blocked${command}: ${output ?? "a protection refused it"}`;
				case "cancel":
					return "it was cancelled";
			}
		};

		const noteText = (wait: WaitData, why: WakeWhy, output: string | undefined): string => {
			const now = clock.now();
			const until = wait.check
				? `planned until ${clockTime(wait.wakeAt, now)}`
				: `planned ${clockTime(wait.wakeAt, now)}`;
			const late = (why === "due" || why === "deadline") && now - wait.wakeAt > 60_000;
			const lines = [
				`[xpi] The wait you asked for ended: ${whyText(wait, why, output)}. Reason: ${wait.reason}. Waited ${clockTime(wait.at, now)}–${clockTime(now, now)} (${late ? `planned ${clockTime(wait.wakeAt, now)}, woke ${clockTime(now, now)}` : until}).`,
			];
			if (output && why !== "blocked") lines.push(`Last check output:\n${output}`);
			return lines.join("\n");
		};

		/**
		 * End the pending wait `wait`. A run starts with the note, except for `cancel` and a wake by a user message
		 * (`withInput`: that message's run takes the note). Nothing happens if it is no longer pending (another process
		 * woke it).
		 */
		const wake = (
			ctx: ExtensionContext,
			wait: WaitData,
			why: WakeWhy,
			output?: string,
			withInput = false,
		): boolean => {
			if (pending(ctx)?.id !== wait.id) return false;
			stop();
			deferred = undefined;
			pi.appendEntry(WAKE_CUSTOM_TYPE, { id: wait.id, at: clock.now(), why, ...(output ? { output } : {}) });
			if (why === "cancel") return true;
			const note = {
				customType: WOKE_CUSTOM_TYPE,
				content: noteText(wait, why, output),
				display: true,
				details: { id: wait.id, why },
			};
			if (withInput) {
				pi.sendMessage(note, ctx.isIdle() ? {} : { deliverAs: "steer" });
			} else {
				pi.sendMessage(note, { triggerTurn: true });
			}
			return true;
		};

		/**
		 * A wake the timer or a check found: at once if idle, else after the session's run or compaction ends (never
		 * steered into a run): at the next settle, or the retry, whichever comes first.
		 */
		function fire(ctx: ExtensionContext, wait: WaitData, why: WakeWhy, output?: string): void {
			if (retry !== undefined) clock.clearTimeout(retry);
			retry = undefined;
			if (!ctx.isIdle()) {
				deferred = { id: wait.id, why, ...(output ? { output } : {}) };
				retry = clock.setTimeout(() => guarded(generation, retryDeferred), RETRY_MS);
				return;
			}
			deferred = undefined;
			wake(ctx, wait, why, output);
		}

		/** Do the deferred wake if it still stands (fire defers it again while the session is busy). */
		function retryDeferred(ctx: ExtensionContext): void {
			retry = undefined;
			const wait = pending(ctx);
			const left = deferred;
			if (!left || wait?.id !== left.id) {
				deferred = undefined;
				return;
			}
			fire(ctx, wait, left.why, left.output);
		}

		const runCheck = async (ctx: ExtensionContext, wait: WaitData) => {
			if (!wait.check || checking) return;
			const gen = generation;
			const controller = new AbortController();
			checking = controller;
			const outcome = await ctx.runTool(
				"bash",
				{ command: wait.check.command, timeout: Math.round(wait.check.timeoutMs / 1000) },
				{ id: `wait:${wait.id}:${++checkCount}`, signal: controller.signal },
			);
			if (checking === controller) checking = undefined;
			if (controller.signal.aborted) return;
			// With the session's latest context: `ctx` is the one the check started with.
			guarded(gen, (latest) => afterCheck(latest, wait, outcome));
		};

		const afterCheck = (ctx: ExtensionContext, wait: WaitData, outcome: AgentToolCallOutcome) => {
			if (pending(ctx)?.id !== wait.id) return;
			const text = outcome.result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
			if (outcome.blocked) return fire(ctx, wait, "blocked", text.trim() || undefined);
			// No bash tool in this session (`--no-tools`, say): the check can never run.
			if (outcome.isError && text.startsWith("Tool bash not found")) {
				return fire(ctx, wait, "blocked", "this session has no bash tool to run it");
			}
			const structured = outcome.result.structuredContent as { exit_code?: number; output?: string } | undefined;
			const output = tail(structured?.output ?? text);
			lastOutput = output || undefined;
			if (!outcome.isError && structured?.exit_code === 0) return fire(ctx, wait, "check", lastOutput);
			if (clock.now() >= wait.wakeAt) return fire(ctx, wait, "deadline", lastOutput);
			arm(ctx);
		};

		/** Arm the timer for the pending wait, or act at once when it is due (W13). */
		function arm(ctx: ExtensionContext, opening = false): void {
			if (timer !== undefined) clock.clearTimeout(timer);
			timer = undefined;
			const wait = pending(ctx);
			if (!wait || !arms(ctx)) return;
			const now = clock.now();
			if (!wait.check) {
				if (now >= wait.wakeAt) {
					fire(ctx, wait, "due");
					return;
				}
				timer = clock.setTimeout(
					() => guarded(generation, (latest) => arm(latest)),
					Math.min(wait.wakeAt - now, MAX_TIMER_MS),
				);
				return;
			}
			// Reopened after a check time passed (or the deadline): one check runs at once.
			if (opening && now >= wait.at + wait.check.everyMs) {
				guarded(generation, (latest) => runCheck(latest, wait));
				return;
			}
			const next = nextCheckAt(wait, now);
			timer = clock.setTimeout(
				() =>
					guarded(generation, (latest) => {
						timer = undefined;
						const still = pending(latest);
						if (!still || still.id !== wait.id) return;
						// Busy: the run's settle arms again; a compaction has no settle, so look again shortly.
						if (!latest.isIdle()) {
							timer = clock.setTimeout(() => guarded(generation, (again) => arm(again)), RETRY_MS);
							return;
						}
						return runCheck(latest, wait);
					}),
				Math.min(Math.max(0, next - now), MAX_TIMER_MS),
			);
		}

		const describe = (wait: WaitData): string => {
			const now = clock.now();
			if (!wait.check) return `Waiting until ${clockTime(wait.wakeAt, now)}: ${wait.reason}`;
			return `Waiting for a check every ${shortDuration(wait.check.everyMs)}, until ${clockTime(wait.wakeAt, now)}: ${wait.reason} (${wait.check.command})`;
		};

		/** A codemode script of the branch's latest assistant message made the call (graph's rule for `next`). */
		const calledByLatestRequest = (ctx: ExtensionContext, toolCallId: string): boolean => {
			const parent = toolCallId.slice(0, toolCallId.lastIndexOf("/"));
			const branch = ctx.sessionManager.getBranch();
			const latest = branch.findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
			if (latest?.type !== "message" || latest.message.role !== "assistant") return false;
			return latest.message.content.some((block) => block.type === "toolCall" && block.id === parent);
		};

		pi.registerTool({
			name: WAIT_TOOL,
			label: "Wait",
			effect: "read",
			// Called from a script only (it ends the script); codemode lists it.
			exposure: "codemode",
			description: DESCRIPTION,
			parameters: Type.Object({
				after: Type.Optional(Type.String({ description: 'How long to wait: "90s", "20m", "2h", "3d".' })),
				at: Type.Optional(
					Type.String({ description: 'When to wake: "HH:MM" (the next such local time) or an ISO time.' }),
				),
				reason: Type.String({ description: "One line: what you wait for." }),
				check: Type.Optional(
					Type.String({
						description: "A shell command; exit code 0 ends the wait. after/at is then the deadline.",
					}),
				),
				every: Type.Optional(
					Type.String({ description: 'How often the check runs (default "2m", at least "30s").' }),
				),
			}),
			async execute(toolCallId, params, _signal, _onUpdate, ctx) {
				if (!toolCallId.includes("/")) {
					throw new Error("wait is called from a codemode script: tools.wait({ after, reason }).");
				}
				if (ctx.isIdle() || !calledByLatestRequest(ctx, toolCallId)) {
					throw new Error("A wait is asked for by a script of the current request, not by a background script.");
				}
				const parsed = parseWait(params as WaitParams, clock.now());
				requested = parsed;
				const when = parsed.check
					? `checks every ${shortDuration(parsed.check.everyMs)} until ${clockTime(parsed.wakeAt)}`
					: `until ${clockTime(parsed.wakeAt)}`;
				return {
					content: [
						{
							type: "text",
							text: `Wait recorded (${when}). The run ends now; you will get a note when it ends.`,
						},
					],
					details: { wakeAt: parsed.wakeAt, ...(parsed.check ? { check: parsed.check } : {}) },
					terminate: true,
				};
			},
		});

		pi.registerCommand("wait", {
			description: "Show the pending wait, or end it: /wait cancel",
			handler: async (args, ctx) => {
				const word = args.trim();
				const wait = pending(ctx);
				if (word === "") {
					if (!wait) return ctx.ui.notify("No wait is pending.", "info");
					const last = lastOutput ? `\nLast check output:\n${lastOutput}` : "";
					return ctx.ui.notify(`${describe(wait)}${last}`, "info");
				}
				if (word === "cancel") {
					if (!wait) return ctx.ui.notify("No wait is pending.", "info");
					wake(ctx, wait, "cancel");
					return ctx.ui.notify("The wait was cancelled.", "info");
				}
				ctx.ui.notify("Usage: /wait, or /wait cancel", "warning");
			},
		});

		pi.on("session_start", (_event, ctx) => {
			generation++;
			current = ctx;
			stop();
			deferred = undefined;
			lastOutput = undefined;
			requested = undefined;
			const wait = pending(ctx);
			if (!wait) return;
			const due = clock.now() >= (wait.check ? wait.at + wait.check.everyMs : wait.wakeAt);
			if (!due && ctx.hasUI)
				ctx.ui.notify(`${describe(wait)} (/wait cancel to stop, /continue to wake now).`, "info");
			// After the session has opened (its first prompt, if any, comes through `input` first).
			const gen = generation;
			setImmediate(() => guarded(gen, (latest) => arm(latest, true)));
		});

		pi.on("session_shutdown", () => {
			generation++;
			stop();
			current = undefined;
		});

		// The wait is written with the run's other end-of-run entries; graph (loaded after) sees it in `event.entries`.
		pi.on("agent_before_settle", (event) => {
			const asked = requested;
			if (!asked || event.outcome !== "completed") return undefined;
			requested = undefined;
			const data: WaitData = {
				id: randomUUID(),
				at: clock.now(),
				wakeAt: asked.wakeAt,
				reason: asked.reason,
				...(asked.check ? { check: asked.check } : {}),
			};
			writtenThisRun = data.id;
			return { entries: [...event.entries, { type: "custom", customType: WAIT_CUSTOM_TYPE, data }] };
		});

		pi.on("agent_settled", (event, ctx) => {
			current = ctx;
			const written = writtenThisRun;
			writtenThisRun = undefined;
			if (requested) {
				requested = undefined;
				if (ctx.hasUI) ctx.ui.notify("The wait was not recorded: the run did not end normally.", "warning");
			}
			// Stopped while it ended (Esc at its end boundary): the run did not end as asked, so neither does its wait.
			if (event.aborted && written && pending(ctx)?.id === written) {
				pi.appendEntry(WAKE_CUSTOM_TYPE, { id: written, at: clock.now(), why: "cancel" });
				if (ctx.hasUI) ctx.ui.notify("The wait was cancelled: the run was stopped.", "warning");
			}
			const wait = pending(ctx);
			if (wait && (ctx.mode === "print" || ctx.mode === "json")) {
				process.stderr.write(`${describe(wait)}. Reopen the session to wake it when it is due.\n`);
				return;
			}
			// After the settle (a run cannot start inside it). A deferred wake goes through `fire`: another extension may
			// have started a run meanwhile (a deferred `triggerTurn`), which it must not be steered into.
			const gen = generation;
			setImmediate(() =>
				guarded(gen, (latest) => {
					const now = pending(latest);
					if (deferred && now?.id === deferred.id) {
						const { why, output } = deferred;
						fire(latest, now, why, output);
						return;
					}
					deferred = undefined;
					arm(latest);
				}),
			);
		});

		// A user message ends a pending wait (W6): the wake and the note go before the message. A wait without a check
		// whose time has already come ends as `due` (print mode never armed it: `xpi -p -c "..."`). A wait this run asked
		// for and has not written yet is dropped: the model sees the user's message.
		pi.on("input", (event, ctx) => {
			if (requested && event.streamingBehavior) requested = undefined;
			const wait = pending(ctx);
			if (wait) {
				const why: WakeWhy = !wait.check && clock.now() >= wait.wakeAt ? "due" : "user";
				wake(ctx, wait, why, undefined, true);
			}
			return { action: "continue" };
		});

		// `/continue` with nothing for the core to continue: a pending wait wakes now, no check (W14).
		pi.on("continue_request", (_event, ctx) => {
			const wait = pending(ctx);
			if (!wait) return undefined;
			return { handled: wake(ctx, wait, "continue") };
		});
	};
}

export default createWaitExtension();
