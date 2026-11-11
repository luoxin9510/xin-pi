/**
 * AT-5: on attach, one line in the transcript (not in the model's context) about what happened while nobody watched:
 * turns, tools, the last question. The deterministic list only; the summary model's rewrite is not ported (decision 6).
 *
 * The host writes `attached.json` in the job's directory and then sends the session SIGUSR2. Without a handler SIGUSR2
 * ends a Node process, so the session reports `attachSignal: true` (the host signals it) only once the handler is in
 * (`sigusr2Handled`).
 */

import { join } from "node:path";
import { type AwayLog, awayIsEmpty, emptyAway, readJobEnv, readJson, recapList } from "xpi-roost";
import { Text } from "xpi-tui";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";

export const RECAP_ENTRY = "roost-recap";

const GUARD = Symbol.for("xpi-roost.sigusr2-guard");

/** Whether this process has a SIGUSR2 handler for the whole of its life (installed by `registerRecap`). */
export function sigusr2Handled(): boolean {
	return (globalThis as { [GUARD]?: true })[GUARD] === true;
}

/** What the host last wrote about this session's terminal. */
export function attachedNow(env: NodeJS.ProcessEnv = process.env): boolean {
	const dir = readJobEnv(env, "dir");
	if (!dir) return false;
	return readJson<{ attached?: unknown }>(join(dir, "attached.json"))?.attached === true;
}

interface RecapDeps {
	/** The worker's view of the last run, read after its own handler for the same event. */
	report: () => { state: string; waitingFor: string | null; question: string | null };
	ctx: () => ExtensionContext | undefined;
	attached?: () => boolean;
}

export function registerRecap(pi: ExtensionAPI, d: RecapDeps): void {
	const attachedFlag = d.attached ?? (() => attachedNow());
	// One handler for the process's whole life: between /new's two sessions no session listens, and SIGUSR2 would end
	// the process.
	const g = globalThis as { [GUARD]?: true };
	if (!g[GUARD]) {
		g[GUARD] = true;
		process.on("SIGUSR2", () => {});
	}
	let away: AwayLog = emptyAway();
	let attached = false;
	let onSignal: (() => void) | undefined;

	pi.registerEntryRenderer<{ text?: string }>(RECAP_ENTRY, (entry, _opts, theme) => {
		const text = typeof entry.data?.text === "string" ? entry.data.text : "";
		return text ? new Text(theme.fg("dim", `↺ While you were away: ${text}`), 1, 0) : undefined;
	});

	pi.on("tool_execution_start", (event) => {
		if (attached || event.parentToolCallId) return;
		away.tools[event.toolName] = (away.tools[event.toolName] ?? 0) + 1;
	});
	pi.on("agent_settled", () => {
		if (attached) return;
		away.turns++;
		const r = d.report();
		if (r.state === "failed") away.failures++;
		if (r.waitingFor === "question" && r.question) away.questions.push(r.question);
	});

	pi.on("session_start", (event, ctx) => {
		attached = attachedFlag();
		if (event.reason !== "reload") away = emptyAway();
		if (onSignal) process.off("SIGUSR2", onSignal);
		onSignal = () => {
			const now = attachedFlag();
			if (now && !attached && !awayIsEmpty(away) && d.ctx() === ctx)
				pi.appendEntry(RECAP_ENTRY, { text: recapList(away) });
			if (now !== attached) away = emptyAway();
			attached = now;
		};
		process.on("SIGUSR2", onSignal);
	});
	pi.on("session_shutdown", () => {
		if (onSignal) process.off("SIGUSR2", onSignal);
		onSignal = undefined;
	});
}
