// Background scripts (v3a policy): a codemode script that starts a subagent moves to the background. The mechanism (the
// early return, the detached script, stop, the nested-call bookkeeping) is the codemode built-in's `codemodeScripts`;
// this file keeps the policy: when to move, the registry rows the panel shows, and the end message handed to main.

import { type CodemodeScriptEnd, codemodeScripts } from "../codemode/scripts.ts";
import { registry } from "./registry.ts";
import { runs } from "./runs.ts";
import { capText } from "./sessions.ts";
import { workflowOf } from "./workflow-run.ts";

export type ScriptState = "foreground" | "background" | "completed" | "failed" | "stopped";

export interface ScriptRecord {
	id: string; // S1, S2, ... (the controller's script id)
	callId: string; // the codemode tool call id; the script's Agent calls have ids "<callId>/<n>"
	workflow?: string; // the saved workflow it runs, when a /name command started it
	run?: string; // the workflow run's id (R1, R2, ...): its results are saved for a relaunch
	saved?: number; // Agent calls answered from a relaunched run's saved results
	paused?: boolean; // it starts no new agent: its Agent calls wait (`gate`) until it is resumed
	sessionId: string; // the main session the script belongs to
	state: ScriptState;
	stopRequested: boolean; // stopped through the registry (the panel x, or the session ending)
	pinned: boolean; // an Agent call said run_in_background: false: the script stays in the foreground
	agents: string[]; // agentIds in start order
	phases: Record<string, string>; // agentId -> the `phase()` title it was started in
	phase?: string; // the latest `phase()` title
	log?: string; // the latest `log()` line
	startedAt: number;
	endedAt?: number;
}

/** What the registry needs from the extension instance it follows. */
export interface ScriptLink {
	sessionId(): string | undefined; // the session this extension instance belongs to
	enabled(): boolean;
	deliver(content: string): void;
	parent(): { sessionFile: string | undefined; sessionId: string };
}

const BACKGROUND_TEXT = (id: string) =>
	`Script moved to the background (id ${id}) and keeps running. Its result arrives as a message when it ends. Do not wait or poll; end your turn or do other work.`;

const textOf = (result: { content?: { type: string; text?: string }[] } | undefined) =>
	(result?.content ?? []).map((c) => c.text ?? "").join("");

class ScriptRegistry {
	private scripts = new Map<string, ScriptRecord>();
	private listeners = new Set<() => void>();
	private keepEnded = 50; // ended scripts kept for the panel's linger; older ones are dropped

	list(sessionId: string): ScriptRecord[] {
		return [...this.scripts.values()].filter((s) => s.sessionId === sessionId);
	}

	get(id: string): ScriptRecord | undefined {
		return this.scripts.get(id);
	}

	// The running script whose codemode call id prefixes this tool call id (nested ids are "<codemode id>/<n>"). A
	// provider may reuse call ids: the controller picks the newest.
	owner(toolCallId: string): ScriptRecord | undefined {
		const info = codemodeScripts.owner(toolCallId);
		const script = info && this.scripts.get(info.id);
		return script && (script.state === "foreground" || script.state === "background") ? script : undefined;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	// Follow the codemode controller for one session: track its scripts, and hand main the end of each background script
	// through `link.deliver`. With `enabled()` false (subagent.backgroundScripts: false, or no UI: print mode exits at the
	// turn's end, so a background result would be lost) scripts are neither tracked nor moved. Returns the disposer.
	connect(link: ScriptLink): () => void {
		// The controller is process-wide: only the scripts this instance saw start (in its own session) are its own. Events of
		// anything else (another session in the process, an older session) are ignored, never delivered here.
		const own = new Set<string>();
		let live = true;
		const off = codemodeScripts.subscribe({
			onStart: (info) => {
				if (!live || info.sessionId !== link.sessionId() || !link.enabled()) return;
				own.add(info.id);
				this.scripts.set(info.id, {
					id: info.id,
					callId: info.toolCallId,
					...(workflowOf(info.toolCallId) ? { workflow: workflowOf(info.toolCallId) } : {}),
					...(runs.ofScript(info.toolCallId) ? { run: runs.ofScript(info.toolCallId)!.id } : {}),
					sessionId: info.sessionId,
					state: "foreground",
					stopRequested: false,
					pinned: false,
					agents: [],
					phases: {},
					startedAt: info.startedAt,
				});
				this.changed();
			},
			onBackground: (info) => {
				const script = live && own.has(info.id) ? this.scripts.get(info.id) : undefined;
				if (script) this.setState(script, "background");
			},
			onEnd: (info, outcome) => {
				if (!live || !own.delete(info.id)) return;
				const script = this.scripts.get(info.id);
				if (script) this.ended(script, outcome, link);
			},
		});
		return () => {
			// Disconnected (session shutdown or a new connect): scripts still running here end unseen, so their rows are
			// closed now and nothing of them is delivered later.
			live = false;
			off();
			for (const id of own) {
				const script = this.scripts.get(id);
				if (script && (script.state === "foreground" || script.state === "background"))
					this.setState(script, "stopped");
			}
			own.clear();
		};
	}

	// How the script ended: stopped; failed (an error result, a throw, or every agent it ran failed or was stopped);
	// else completed. A background script's end goes to main as a message.
	private ended(script: ScriptRecord, outcome: CodemodeScriptEnd, link: ScriptLink): void {
		const everyAgentFailed =
			script.agents.length > 0 &&
			script.agents.every((a) => ["failed", "stopped"].includes(registry.get(a)?.status ?? ""));
		const state: ScriptState =
			script.stopRequested || outcome.stopped
				? "stopped"
				: outcome.error || outcome.result?.isError || everyAgentFailed
					? "failed"
					: "completed";
		this.setState(script, state);
		if (!outcome.background) return;
		try {
			// `text` is what an end message shows: the error, or the return value. `allFailed`: it returned normally but
			// every agent it ran failed or was stopped.
			const allFailed = !outcome.error && !outcome.result?.isError && state === "failed";
			const text = outcome.error ? outcome.error.message : textOf(outcome.result);
			link.deliver(endMessage(script, state, text, link.parent(), allFailed));
		} catch (e) {
			console.error(`subagent: could not deliver the end of script ${script.id}: ${(e as Error).message}`); // never crash pi
		}
	}

	// An Agent call is about to start. `false` pins its foreground script (later calls do not move it); `true` leaves the
	// script alone (only that agent runs in the background); otherwise the first call moves a foreground script.
	agentStarting(toolCallId: string, runInBackground?: boolean): void {
		const script = this.owner(toolCallId);
		if (!script) return;
		if (script.stopRequested) throw new Error(`script ${script.id} is being stopped`);
		if (runInBackground === false) script.pinned = true;
		else if (runInBackground === undefined && script.state === "foreground" && !script.pinned)
			codemodeScripts.background(script.id, BACKGROUND_TEXT(script.id));
	}

	addAgent(toolCallId: string, agentId: string, phase?: string): void {
		const script = this.owner(toolCallId);
		if (!script) return;
		script.agents.push(agentId);
		// `agent()` carries its phase; a plain tools.Agent call belongs to the script's current one.
		const title = phase ?? script.phase;
		if (title !== undefined) script.phases[agentId] = title;
		this.changed();
	}

	// An Agent call of the script was answered from a relaunched run's saved results (runs.ts).
	addSaved(toolCallId: string): void {
		const script = this.owner(toolCallId);
		if (!script) return;
		script.saved = (script.saved ?? 0) + 1;
		this.changed();
	}

	// --- pause: a paused script starts no new agent. Its Agent calls wait here; agents already running finish.

	private waiting = new Map<string, { resume: () => void; stop: (reason: Error) => void }[]>();

	// Pause or resume a running script. Returns the new state, or undefined when the script is not running.
	togglePause(id: string): boolean | undefined {
		const script = this.scripts.get(id);
		if (!script || (script.state !== "foreground" && script.state !== "background")) return undefined;
		script.paused = !script.paused;
		if (!script.paused) this.releaseWaiting(id, undefined);
		this.changed();
		return script.paused;
	}

	// Resume the waiting calls in the order they arrived, or (with `reason`) reject them all.
	private releaseWaiting(id: string, reason: Error | undefined): void {
		const waiting = this.waiting.get(id) ?? [];
		this.waiting.delete(id);
		for (const w of waiting) reason ? w.stop(reason) : w.resume();
	}

	// Called by an Agent call before it starts anything: resolves at once unless its script is paused, then when the
	// script is resumed. Rejects when the script is stopped, or the caller aborts, while it waits.
	gate(toolCallId: string, signal: AbortSignal | undefined): Promise<void> {
		const script = this.owner(toolCallId);
		if (!script?.paused) return Promise.resolve();
		return new Promise<void>((resolve, reject) => {
			const onAbort = () => reject(new Error("aborted"));
			signal?.addEventListener("abort", onAbort, { once: true });
			const settle = (fn: () => void) => () => {
				signal?.removeEventListener("abort", onAbort);
				fn();
			};
			const list = this.waiting.get(script.id) ?? [];
			list.push({ resume: settle(resolve), stop: (reason) => settle(() => reject(reason))() });
			this.waiting.set(script.id, list);
		});
	}

	// A `phase()` or `log()` call of the script (script-helpers.ts).
	note(script: ScriptRecord, note: { phase: string } | { log: string }): void {
		if ("phase" in note) script.phase = note.phase;
		else script.log = note.log;
		this.changed();
	}

	setState(script: ScriptRecord, state: ScriptState): void {
		script.state = state;
		if (state !== "foreground" && state !== "background") {
			script.paused = false;
			this.releaseWaiting(script.id, new Error(`script ${script.id} ended while this call waited for it to resume`));
			script.endedAt = Date.now();
			const ended = [...this.scripts.values()].filter((x) => x.endedAt !== undefined);
			for (const old of ended.slice(0, Math.max(0, ended.length - this.keepEnded))) this.scripts.delete(old.id);
		}
		this.changed();
	}

	// Move every foreground script of the session this extension tracks to the background (ctrl+b); true when there was
	// one. Nothing is tracked with subagent.backgroundScripts: false.
	backgroundAll(sessionId: string): boolean {
		let any = false;
		for (const s of this.list(sessionId)) {
			if (s.state === "foreground") any = codemodeScripts.background(s.id, BACKGROUND_TEXT(s.id)) || any;
		}
		return any;
	}

	// Stop a running script (the panel's `x` calls this): its running agents stop (failed / "stopped by user"), then the
	// script is aborted and ends `stopped`; main gets the usual end message. False when the script is not running.
	async stop(id: string): Promise<boolean> {
		const script = this.scripts.get(id);
		if (!script || (script.state !== "foreground" && script.state !== "background")) return false;
		script.stopRequested = true; // from here on the script's Agent calls throw (agentStarting)
		this.releaseWaiting(id, new Error(`script ${script.id} is being stopped`)); // calls held by a pause
		await registry.stopAll(script.agents); // each running agent ends failed / "stopped by user"
		return codemodeScripts.stop(id); // the script itself, and any agent still waiting for a slot
	}

	// Stop every running script of the session (session end, reload).
	async stopAll(sessionId: string): Promise<void> {
		await Promise.all(this.list(sessionId).map((s) => this.stop(s.id)));
	}

	private changed(): void {
		for (const l of this.listeners) l();
	}
}

export const scripts = new ScriptRegistry();

// `allFailed`: the script returned normally (text is its return value) but every agent it ran failed or was stopped.
export function endMessage(
	script: ScriptRecord,
	state: ScriptState,
	text: string,
	parent: { sessionFile: string | undefined; sessionId: string },
	allFailed = false,
): string {
	text = capText(text, parent, `script-${script.id}`);
	const agents = script.agents.map((id) => {
		const r = registry.get(id);
		return r ? `- ${id} ${r.type} ${r.status} $${r.usage.cost.total.toFixed(4)}` : `- ${id}`;
	});
	const what = script.workflow ? ` (workflow ${script.workflow}${script.run ? `, run ${script.run}` : ""})` : "";
	// A workflow run that did not complete can be started again without redoing what finished.
	const relaunch =
		script.workflow && script.run && (state === "stopped" || state === "failed")
			? [
					`Relaunch it with Workflow({ name: "${script.workflow}", relaunch: "${script.run}" }): agents that completed are answered from saved results.`,
				]
			: [];
	return [
		`Background script ${script.id}${what} ${state}.`,
		allFailed
			? `Error: every agent failed\nReturn value:\n${text}`
			: state === "failed"
				? `Error: ${text}`
				: `Return value:\n${text}`,
		agents.length > 0 ? `Agents:\n${agents.join("\n")}` : "Agents: none",
		...(script.saved ? [`Answered from saved results: ${script.saved}`] : []),
		...relaunch,
	].join("\n");
}
