// checks extension entry: after a turn that changed something, run the commands named in the `checks.commands` setting
// once and tell the model the errors that are new since the last check, before its next request. Off without commands.
// The runner and the parsers are plain modules; `createChecksExtension` takes the runner so tests can fake it.

import type {
	CustomMessageEntryDraft,
	ExtensionAPI,
	ExtensionContext,
	TurnEndEvent,
	TurnEndEventResult,
} from "../../core/extensions/types.ts";
import { SETTINGS_DEFAULTS } from "../../core/settings-defaults.ts";
import { type CheckError, formatError, newErrors, parseCheckOutput } from "./parse.ts";
import { CHECKS_MESSAGE_TYPE, type ChecksDetails, renderChecksMessage } from "./render.ts";
import { type CheckRunner, runCheckCommand } from "./runner.ts";

interface ChecksConfig {
	commands: string[];
	timeoutMs: number;
	maxErrors: number;
}

// Read at each use, never cached: a settings reload or a trust change takes effect at the next check. An untrusted
// project's settings are not loaded by the settings manager, so its commands never show up here.
function readConfig(pi: ExtensionAPI): ChecksConfig {
	const settings = pi.getSettings().checks;
	return {
		commands: (settings?.commands ?? []).filter((command) => command.trim() !== ""),
		timeoutMs: settings?.timeoutMs ?? SETTINGS_DEFAULTS.checks.timeoutMs,
		maxErrors: settings?.maxErrors ?? SETTINGS_DEFAULTS.checks.maxErrors,
	};
}

export function createChecksExtension(runner: CheckRunner) {
	return function checks(pi: ExtensionAPI) {
		// The last result of each command; a command without an entry has no baseline.
		const baseline = new Map<string, CheckError[]>();
		let baselineRun: Promise<void> | undefined;
		// Kills a baseline or check still running when the session ends.
		const shutdown = new AbortController();
		let baselineAbort: AbortController | undefined;
		// Calls noted at tool_call that may change things, by id; counted when their tool_result arrives.
		const noted = new Set<string>();
		let changed = false;

		pi.registerMessageRenderer(CHECKS_MESSAGE_TYPE, renderChecksMessage);

		async function takeBaseline(cwd: string, config: ChecksConfig): Promise<void> {
			const controller = new AbortController();
			baselineAbort = controller;
			const signal = AbortSignal.any([controller.signal, shutdown.signal]);
			// Only commands without a baseline: a reload starts the extension again mid-session.
			for (const command of config.commands.filter((command) => !baseline.has(command))) {
				if (signal.aborted) return;
				const result = await runner(command, { cwd, timeoutMs: config.timeoutMs, signal });
				if (result.timedOut || result.aborted) continue;
				baseline.set(command, parseCheckOutput(result, cwd));
			}
		}

		pi.on("session_start", (_event, ctx) => {
			const config = readConfig(pi);
			if (config.commands.length === 0 || baselineRun) return;
			baselineRun = takeBaseline(ctx.cwd, config).catch(() => {});
		});

		pi.on("session_shutdown", () => {
			shutdown.abort();
		});

		pi.on("tool_call", async (event, ctx) => {
			if (event.effect === "read") return;
			noted.add(event.toolCallId);
			// Tool calls of one assistant message are prepared one by one before any runs, so waiting here means
			// nothing of this batch has run yet. Bounded by the commands' timeouts and the run's signal.
			if (!baselineRun) return;
			const run = baselineRun;
			baselineRun = undefined;
			await waitForBaseline(run, readConfig(pi), ctx);
		});

		async function waitForBaseline(run: Promise<void>, config: ChecksConfig, ctx: ExtensionContext): Promise<void> {
			const limit = config.commands.length * config.timeoutMs;
			let timer: ReturnType<typeof setTimeout> | undefined;
			let onAbort: (() => void) | undefined;
			const cut = new Promise<"cut">((resolve) => {
				timer = setTimeout(() => resolve("cut"), limit);
				onAbort = () => resolve("cut");
				ctx.signal?.addEventListener("abort", onAbort, { once: true });
			});
			const outcome = await Promise.race([run.then(() => "done" as const), cut]);
			clearTimeout(timer);
			if (onAbort) ctx.signal?.removeEventListener("abort", onAbort);
			// Cut short: stop the baseline so it cannot land after the first change; commands without one report nothing once.
			if (outcome === "cut") baselineAbort?.abort();
		}

		pi.on("tool_result", (event) => {
			if (noted.delete(event.toolCallId)) changed = true;
		});

		pi.on("turn_end", async (event, ctx): Promise<TurnEndEventResult | undefined> => {
			// "This turn" is by time: what ran since the previous turn_end.
			const ran = changed;
			changed = false;
			noted.clear();
			if (!ran || event.terminated || event.outcome !== "completed" || ctx.signal?.aborted) return undefined;
			const config = readConfig(pi);
			if (config.commands.length === 0) return undefined;
			return await check(event, ctx, config);
		});

		async function check(
			event: TurnEndEvent,
			ctx: ExtensionContext,
			config: ChecksConfig,
		): Promise<TurnEndEventResult | undefined> {
			const signal = ctx.signal ? AbortSignal.any([ctx.signal, shutdown.signal]) : shutdown.signal;
			const fresh: CheckError[] = [];
			const timedOut: string[] = [];
			try {
				for (const command of config.commands) {
					if (signal.aborted) return undefined;
					if (ctx.hasUI) ctx.ui.setStatus("checks", `checks: running ${command}…`);
					const result = await runner(command, { cwd: ctx.cwd, timeoutMs: config.timeoutMs, signal });
					if (result.aborted || signal.aborted) return undefined;
					if (result.timedOut) {
						timedOut.push(command);
						continue;
					}
					const errors = parseCheckOutput(result, ctx.cwd);
					const before = baseline.get(command);
					// Without a baseline this result only becomes one.
					if (before) fresh.push(...newErrors(before, errors));
					baseline.set(command, errors);
				}
			} finally {
				if (ctx.hasUI) ctx.ui.setStatus("checks", undefined);
			}
			if (fresh.length === 0 && timedOut.length === 0) return undefined;
			return { entries: [...event.entries, buildMessage(fresh, timedOut, config)] };
		}
	};
}

function buildMessage(fresh: CheckError[], timedOut: string[], config: ChecksConfig): CustomMessageEntryDraft {
	const shown = fresh.slice(0, config.maxErrors);
	const more = fresh.length - shown.length;
	const lines: string[] = [];
	if (fresh.length > 0) {
		lines.push(`Checks after this turn: ${fresh.length} new error${fresh.length === 1 ? "" : "s"}.`);
		lines.push(...shown.map(formatError));
		if (more > 0) lines.push(`and ${more} more`);
	} else {
		lines.push("Checks after this turn:");
	}
	for (const command of timedOut)
		lines.push(`${command}: timed out after ${Math.round(timedOutSeconds(config))} s (skipped)`);
	const details: ChecksDetails = { errors: shown, more, timedOut };
	return {
		type: "custom_message",
		customType: CHECKS_MESSAGE_TYPE,
		content: lines.join("\n"),
		display: true,
		details,
	};
}

function timedOutSeconds(config: ChecksConfig): number {
	return config.timeoutMs / 1000;
}

export default createChecksExtension(runCheckCommand);
