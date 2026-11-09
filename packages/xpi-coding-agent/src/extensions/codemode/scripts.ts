/**
 * Running codemode scripts, and the first-class way to move one to the background: the `codemode` call
 * returns to the model at once, and the script keeps running detached from the turn's abort signal.
 *
 * Mechanism only. Policy (when to move a script, what to tell the model, how to show it) belongs to the
 * caller, for example the subagent extension. A script nobody moves behaves exactly as before.
 *
 * `codemodeScripts` is a process-wide singleton: the built-in codemode extension and the extensions that
 * use it share one module instance.
 */

import type { AgentToolResult } from "xpi-agent-core";

export type CodemodeScriptState = "foreground" | "background" | "ended";

export interface CodemodeScriptInfo {
	/** S1, S2, ... unique in this process. */
	id: string;
	/** The `codemode` tool call id. Nested calls of the script have ids `<toolCallId>/<n>`. */
	toolCallId: string;
	sessionId: string;
	startedAt: number;
	state: CodemodeScriptState;
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
	onEnd?(script: CodemodeScriptInfo, outcome: CodemodeScriptEnd): void;
}

export interface CodemodeScripts {
	/** The running script whose codemode call id prefixes this (nested) tool call id. */
	owner(nestedToolCallId: string): CodemodeScriptInfo | undefined;
	/** Running scripts, optionally of one session. */
	list(sessionId?: string): CodemodeScriptInfo[];
	/**
	 * Move a foreground script to the background: its codemode call returns now with `result` (default: a short
	 * text), and it keeps running. False when it is not in the foreground.
	 */
	background(scriptId: string, result?: string): boolean;
	/** `background()` for every foreground script of the session (ctrl+b). True when there was one. */
	backgroundAll(sessionId: string): boolean;
	/** Abort a running script (foreground or background). False when it is not running. */
	stop(scriptId: string): Promise<boolean>;
	/** Stop every running script of the session (session shutdown). */
	stopAll(sessionId: string): Promise<void>;
	subscribe(listener: CodemodeScriptListener): () => void;
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
	/** The script is over; notifies listeners. */
	end(outcome: { result?: AgentToolResult<unknown>; error?: Error }): void;
}

class CodemodeScriptRegistry implements CodemodeScripts {
	private readonly runs = new Map<
		string,
		{ info: CodemodeScriptInfo; move: (text?: string) => void; abort: () => void; settled: boolean }
	>();
	private readonly listeners = new Set<CodemodeScriptListener>();
	private counter = 0;

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
	begin(toolCallId: string, sessionId: string, mainSignal: AbortSignal | undefined): CodemodeScriptRun {
		const own = new AbortController();
		const info: CodemodeScriptInfo = {
			id: `S${++this.counter}`,
			toolCallId,
			sessionId,
			startedAt: Date.now(),
			state: "foreground",
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
		const entry = { info, move, abort: () => own.abort(new Error("Script stopped")), settled: false };
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
): CodemodeScriptRun {
	return registry.begin(toolCallId, sessionId, mainSignal);
}
