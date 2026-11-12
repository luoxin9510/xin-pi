/**
 * Running codemode scripts, and the first-class way to move one to the background: the `codemode` call
 * returns to the model at once, and the script keeps running detached from the turn's abort signal.
 *
 * Mechanism only. Policy (when to move a script, what to tell the model, how to show it) belongs to the
 * caller, for example the subagent extension. A script nobody moves behaves exactly as before.
 *
 * A script that ends while some of its calls keep running (add-ons' `outlives`) is kept: its record stays, marked
 * `ended`, so those calls still find their script (`owner`), until the extension that let them run on calls `release`.
 * Only then is `onEnd` emitted.
 *
 * `codemodeScripts` is a process-wide singleton: the built-in codemode extension and the extensions that
 * use it share one module instance.
 */

import type { AgentToolResult } from "xpi-agent-core";

/** `ended`: its code is over; a kept script stays listed in this state until it is released. */
export type CodemodeScriptState = "foreground" | "background" | "ended";

/** How a kept script's code ended: it returned (or called `exit()`), threw, ran out of time, or its sandbox failed. */
export type CodemodeEndReason = "returned" | "threw" | "timed out" | "sandbox failed";

/** How a call the script left running settled. */
export interface CodemodeKeptSettlement {
	/** The nested tool call id (`<codemode call id>/<n>`); `<codemode call id>/?` when it never got one. */
	toolCallId: string;
	/** Set when the call failed: its error text. */
	error?: string;
}

/** A call still running when the script ended, left running because an add-on's `outlives` said so. */
export interface CodemodeKeptCall {
	/** The tool. */
	name: string;
	/** The arguments the script passed. */
	args: unknown;
	/** Settles (never rejects) when the call has. */
	settled: Promise<CodemodeKeptSettlement>;
}

/** What `keep()` records. */
export interface CodemodeKept {
	reason: CodemodeEndReason;
	calls: CodemodeKeptCall[];
	/** Called by `release()`, before `onEnd` is emitted. */
	onRelease?: () => void;
}

/** What `onKeep` reports: the kept calls and the outcome `onEnd` will carry. */
export interface CodemodeScriptKept {
	reason: CodemodeEndReason;
	calls: CodemodeKeptCall[];
	result?: AgentToolResult<unknown>;
	error?: Error;
	/** The script was in the background when its code ended. */
	background: boolean;
}

export interface CodemodeScriptInfo {
	/** S1, S2, ... unique in this process. */
	id: string;
	/** The `codemode` tool call id. Nested calls of the script have ids `<toolCallId>/<n>`. */
	toolCallId: string;
	sessionId: string;
	startedAt: number;
	state: CodemodeScriptState;
	/** The `description` the model gave the call (a few words), when it did. */
	description?: string;
	/** The script's source, as the call gave it. */
	code?: string;
	/** Set while a kept script waits to be released: how its code ended. */
	ended?: CodemodeEndReason;
}

/** What begins a script: the optional label and source the script screen shows. */
export interface CodemodeScriptStart {
	description?: string;
	code?: string;
}

/**
 * Whoever can take a script into the background and bring its result back (the subagent extension). `codemode` calls
 * with `run_in_background` only move when one of these allows it for their session; otherwise they wait.
 */
export interface CodemodeBackgroundProvider {
	/** The session this provider serves, undefined while it has none. */
	sessionId(): string | undefined;
	/** False while background scripts are off (a setting, or print mode). */
	enabled(): boolean;
}

export interface CodemodeScriptEnd {
	/** The script's result. Missing when it threw (`error` is set). */
	result?: AgentToolResult<unknown>;
	error?: Error;
	/** Ended because `stop()` / `stopAll()` was called, or because the turn's abort signal fired while it was in front. */
	stopped: boolean;
	/** The script was in the background when it ended (its result goes to a message, not to the tool call). */
	background: boolean;
}

export interface CodemodeScriptListener {
	onStart?(script: CodemodeScriptInfo): void;
	/** The script moved to the background (its codemode call is returning early). */
	onBackground?(script: CodemodeScriptInfo): void;
	/** The script's code ended with kept calls: its record stays until `release()`, which emits `onEnd`. */
	onKeep?(script: CodemodeScriptInfo, kept: CodemodeScriptKept): void;
	onEnd?(script: CodemodeScriptInfo, outcome: CodemodeScriptEnd): void;
}

export interface CodemodeScripts {
	/** The running or kept script whose codemode call id prefixes this (nested) tool call id. */
	owner(nestedToolCallId: string): CodemodeScriptInfo | undefined;
	/** Running and kept scripts, optionally of one session. */
	list(sessionId?: string): CodemodeScriptInfo[];
	/**
	 * Move a foreground script to the background: its codemode call returns now with `result` (default: a short
	 * text), and it keeps running. False when it is not in the foreground.
	 */
	background(scriptId: string, result?: string): boolean;
	/** `background()` for every foreground script of the session (ctrl+b). True when there was one. */
	backgroundAll(sessionId: string): boolean;
	/**
	 * Abort a running script (foreground or background). A kept script is marked stopped (its calls are the keeping
	 * extension's to stop). False when it is neither.
	 */
	stop(scriptId: string): Promise<boolean>;
	/** Stop every running or kept script of the session (session shutdown). */
	stopAll(sessionId: string): Promise<void>;
	/**
	 * Called by the codemode host when this script (by script id, S1, S2, ...) ends with calls still running: its record
	 * stays (state `ended`) and its end emits `onKeep` instead of `onEnd`. False when the script is not running. Script
	 * ids, not call ids: a provider may reuse call ids, and a kept script lives on for minutes.
	 */
	keep(scriptId: string, kept: CodemodeKept): boolean;
	/** End a kept script (by script id): `onRelease`, then `onEnd`. False when it is not a kept script whose code ended. */
	release(scriptId: string): boolean;
	subscribe(listener: CodemodeScriptListener): () => void;
	/** Register a provider that takes scripts to the background. Returns the disposer. */
	provideBackground(provider: CodemodeBackgroundProvider): () => void;
	/** Whether a provider serves the session and is enabled: a `run_in_background` call is honoured. */
	canBackground(sessionId: string): boolean;
}

const DEFAULT_BACKGROUND_TEXT = (id: string) =>
	`Script ${id} moved to the background and keeps running. Do not wait for it.`;

/** What `executeCodemode` holds for one script. */
export interface CodemodeScriptRun {
	info: CodemodeScriptInfo;
	/** The script's own abort signal: main's signal only while foreground, or `stop()`. */
	signal: AbortSignal;
	/** Resolves with the text of the early result when the script is moved to the background. */
	moved: Promise<string>;
	/** True when the script is in the foreground. */
	isForeground(): boolean;
	/** The script's own code has finished (its result is about to be returned or reported): `background()` is refused from now on. */
	settle(): void;
	/** The script is over; notifies listeners (`onKeep` for a kept script, else `onEnd`). */
	end(outcome: { result?: AgentToolResult<unknown>; error?: Error }): void;
}

interface Entry {
	info: CodemodeScriptInfo;
	move: (text?: string) => void;
	abort: () => void;
	stopped: () => boolean;
	settled: boolean;
	kept?: CodemodeKept;
	/** Set by `end()` of a kept script: what `release()` reports. */
	outcome?: { result?: AgentToolResult<unknown>; error?: Error; background: boolean };
}

class CodemodeScriptRegistry implements CodemodeScripts {
	private readonly runs = new Map<string, Entry>();
	private readonly listeners = new Set<CodemodeScriptListener>();
	private readonly providers = new Set<CodemodeBackgroundProvider>();
	private counter = 0;

	provideBackground(provider: CodemodeBackgroundProvider): () => void {
		this.providers.add(provider);
		return () => this.providers.delete(provider);
	}

	canBackground(sessionId: string): boolean {
		return [...this.providers].some((p) => {
			try {
				return p.sessionId() === sessionId && p.enabled();
			} catch {
				return false; // a provider of a session that is gone
			}
		});
	}

	owner(nestedToolCallId: string): CodemodeScriptInfo | undefined {
		return [...this.runs.values()].reverse().find((run) => nestedToolCallId.startsWith(`${run.info.toolCallId}/`))
			?.info;
	}

	list(sessionId?: string): CodemodeScriptInfo[] {
		return [...this.runs.values()].map((run) => run.info).filter((s) => !sessionId || s.sessionId === sessionId);
	}

	background(scriptId: string, result?: string): boolean {
		const run = this.runs.get(scriptId);
		if (!run || run.info.state !== "foreground" || run.settled) return false; // already over: its result goes to the tool call
		run.move(result);
		return true;
	}

	backgroundAll(sessionId: string): boolean {
		let any = false;
		for (const info of this.list(sessionId)) any = this.background(info.id) || any;
		return any;
	}

	keep(scriptId: string, kept: CodemodeKept): boolean {
		const run = this.runs.get(scriptId);
		if (!run || run.info.state === "ended") return false;
		run.kept = kept;
		return true;
	}

	release(scriptId: string): boolean {
		const run = this.runs.get(scriptId);
		if (!run?.outcome) return false;
		this.runs.delete(run.info.id);
		try {
			run.kept?.onRelease?.();
		} catch (error) {
			console.error(`codemode scripts: releasing ${run.info.id} failed: ${(error as Error).message}`); // never crash pi
		}
		const { result, error, background } = run.outcome;
		this.emit("onEnd", run.info, {
			...(result ? { result } : {}),
			...(error ? { error } : {}),
			stopped: run.stopped(),
			background,
		});
		return true;
	}

	async stop(scriptId: string): Promise<boolean> {
		const run = this.runs.get(scriptId);
		if (!run) return false;
		run.abort();
		return true;
	}

	async stopAll(sessionId: string): Promise<void> {
		await Promise.all(this.list(sessionId).map((s) => this.stop(s.id)));
	}

	subscribe(listener: CodemodeScriptListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Called by `executeCodemode`: register a script that starts now. */
	begin(
		toolCallId: string,
		sessionId: string,
		mainSignal: AbortSignal | undefined,
		start: CodemodeScriptStart = {},
	): CodemodeScriptRun {
		const own = new AbortController();
		const info: CodemodeScriptInfo = {
			id: `S${++this.counter}`,
			toolCallId,
			sessionId,
			startedAt: Date.now(),
			state: "foreground",
			...(start.description ? { description: start.description } : {}),
			...(start.code === undefined ? {} : { code: start.code }),
		};
		const abortOwn = () => own.abort(mainSignal?.reason);
		let resolveMoved!: (text: string) => void;
		const moved = new Promise<string>((r) => {
			resolveMoved = r;
		});
		const move = (text?: string) => {
			info.state = "background";
			mainSignal?.removeEventListener("abort", abortOwn);
			this.emit("onBackground", info);
			resolveMoved(text ?? DEFAULT_BACKGROUND_TEXT(info.id));
		};
		const entry: Entry = {
			info,
			move,
			abort: () => own.abort(new Error("Script stopped")),
			stopped: () => own.signal.aborted,
			settled: false,
		};
		this.runs.set(info.id, entry);
		if (mainSignal?.aborted) abortOwn();
		else mainSignal?.addEventListener("abort", abortOwn, { once: true });
		this.emit("onStart", info);
		return {
			info,
			signal: own.signal,
			moved,
			isForeground: () => info.state === "foreground",
			settle: () => {
				entry.settled = true;
			},
			end: ({ result, error }) => {
				mainSignal?.removeEventListener("abort", abortOwn);
				const background = info.state === "background";
				info.state = "ended";
				entry.settled = true;
				if (entry.kept) {
					// Kept: the record stays until release(), which emits onEnd with this outcome.
					info.ended = entry.kept.reason;
					entry.outcome = { ...(result ? { result } : {}), ...(error ? { error } : {}), background };
					this.emit("onKeep", info, {
						reason: entry.kept.reason,
						calls: entry.kept.calls,
						...(result ? { result } : {}),
						...(error ? { error } : {}),
						background,
					});
					return;
				}
				this.runs.delete(info.id);
				this.emit("onEnd", info, {
					...(result ? { result } : {}),
					...(error ? { error } : {}),
					stopped: own.signal.aborted,
					background,
				});
			},
		};
	}

	private emit<K extends keyof CodemodeScriptListener>(
		key: K,
		...args: Parameters<NonNullable<CodemodeScriptListener[K]>>
	): void {
		for (const listener of [...this.listeners]) {
			try {
				(listener[key] as ((...a: unknown[]) => void) | undefined)?.(...args);
			} catch (error) {
				console.error(`codemode scripts: a listener failed in ${key}: ${(error as Error).message}`); // never crash pi
			}
		}
	}
}

const registry = new CodemodeScriptRegistry();

export const codemodeScripts: CodemodeScripts = registry;

/** For `executeCodemode` only. */
export function beginCodemodeScript(
	toolCallId: string,
	sessionId: string,
	mainSignal: AbortSignal | undefined,
	start?: CodemodeScriptStart,
): CodemodeScriptRun {
	return registry.begin(toolCallId, sessionId, mainSignal, start);
}
