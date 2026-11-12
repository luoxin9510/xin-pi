// Agent teams: the three extension events (spec .scratch/agent-teams/01-agent-teams.md, "Hooks"). They go through `pi.events`
// as `agent-teams:<event>`. A handler answers during `emit`, before its first `await`, with `block(feedback)` or
// `hold(promise)`; `emit` calls handlers synchronously and does not wait for them, so this module collects the answers
// and, for holds, waits for them (up to HOLD_TIMEOUT_MS: then the step is allowed and a warning is logged).

import type { EventBus } from "../../core/event-bus.ts";

export const HOLD_TIMEOUT_MS = 5 * 60_000;

export type HookEvent = "teammate_idle" | "task_created" | "task_completed";
export const hookChannel = (event: HookEvent): string => `agent-teams:${event}`;

// The two functions every payload carries.
export interface HookAnswers {
	block(feedback: string): void;
	hold(decision: Promise<string | undefined>): void;
}

export type Verdict = { blocked: false } | { blocked: true; feedback: string };
const ALLOW: Verdict = { blocked: false };

export interface HookEnv {
	bus: EventBus | undefined;
	warn(message: string): void;
	holdTimeoutMs?: number;
	// The hold's timer does not keep the process alive (a decision nobody waits for in a tool call, e.g. at shutdown). A tool
	// call awaiting a hold keeps it: if only an unref'd timer were left the process could exit, or the event loop drain,
	// with the call pending.
	backgroundHold?: boolean;
}

const blockedWith = (feedback: string): Verdict => ({ blocked: true, feedback: feedback || "blocked by a hook" });

// Emit the event. `sync` is the verdict when it is known at once (no handler, an answer given with `block`, no hold);
// else `later` settles when the holds have. `observeOnly`: handlers see the event but their answers count for nothing.
export function emitHook(
	env: HookEnv,
	event: HookEvent,
	payload: object,
	observeOnly = false,
): { sync: Verdict } | { sync?: undefined; later: Promise<Verdict> } {
	if (!env.bus) return { sync: ALLOW };
	const blocks: string[] = [];
	const holds: Promise<string | undefined>[] = [];
	// Answers are collected only while `emit` runs: the handlers are called synchronously (core/event-bus.ts), and the
	// verdict is read right after it returns, so an answer after a handler's first `await` cannot count. This relies on
	// that bus; a bus that calls handlers later would need the verdict to wait.
	const open = !observeOnly; // observers see the event; their answers count for nothing
	const answers: HookAnswers = {
		block: (feedback) => {
			if (open) blocks.push(String(feedback));
		},
		hold: (decision) => {
			if (open) holds.push(Promise.resolve(decision));
		},
	};
	try {
		env.bus.emit(hookChannel(event), { ...payload, ...answers });
	} catch (err) {
		env.warn(`${hookChannel(event)}: a handler failed: ${(err as Error).message}`);
	}
	// (an answer given after a handler's first await finds the verdict decided below, and counts for nothing)
	if (blocks.length > 0) return { sync: blockedWith(blocks[0]!) };
	if (holds.length === 0) return { sync: ALLOW };
	return { later: settleHolds(env, event, holds) };
}

async function settleHolds(env: HookEnv, event: HookEvent, holds: Promise<string | undefined>[]): Promise<Verdict> {
	const ms = env.holdTimeoutMs ?? HOLD_TIMEOUT_MS;
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<"timeout">((resolve) => {
		timer = setTimeout(() => resolve("timeout"), ms);
		if (env.backgroundHold) timer.unref();
	});
	try {
		const settled = await Promise.race([Promise.allSettled(holds), timeout]);
		if (settled === "timeout") {
			env.warn(`${hookChannel(event)}: a handler's hold did not answer in ${Math.round(ms / 1000)} s: allowed`);
			return ALLOW;
		}
		let verdict: Verdict = ALLOW;
		for (const r of settled) {
			if (r.status === "rejected")
				env.warn(`${hookChannel(event)}: a handler's hold failed: ${String(r.reason)}: allowed`);
			else if (typeof r.value === "string" && !verdict.blocked) verdict = blockedWith(r.value);
		}
		return verdict;
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export async function runHook(env: HookEnv, event: HookEvent, payload: object): Promise<Verdict> {
	const r = emitHook(env, event, payload);
	return r.sync ?? (await r.later);
}
