// Background scripts (v3a policy): a codemode script that starts a subagent moves to the background. The mechanism (the
// early return, the detached script, stop, the nested-call bookkeeping) is the codemode built-in's `codemodeScripts`;
// this file keeps the policy: when to move, the registry rows the panel shows, and the end message handed to main.
//
// Groups (spec 09): `Agent` calls still running when a script's code ends are left running (the add-on's `outlives`),
// and the codemode host keeps the script (`codemodeScripts.keep`). The agents the script leaves running form its group:
// the script row stays open (state "ended"), and main gets one message when every agent of the group has ended, after
// which the script is released (`codemodeScripts.release`) and ends as any script does.

import type {
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	ToolExecutionUpdateEvent,
} from "../../core/extensions/types.ts";
import {
	type CodemodeKeptCall,
	type CodemodeScriptEnd,
	type CodemodeScriptKept,
	codemodeScripts,
} from "../codemode/scripts.ts";
import { registry, stalledLabel } from "./registry.ts";
import type { Status } from "./runner.ts";
import { runs } from "./runs.ts";
import { capText } from "./sessions.ts";
import { workflowOf } from "./workflow-run.ts";

// "ended": its code is over and the agents it left running (its group) still run.
export type ScriptState = "foreground" | "background" | "ended" | "completed" | "failed" | "stopped";

// A script still runs: its code, or its group.
export const scriptRunning = (s: ScriptRecord): boolean =>
	s.state === "foreground" || s.state === "background" || s.state === "ended";

export type ScriptCallStatus = "running" | "done" | "error";

// A tool call the script made (`tools.bash(...)`), kept in memory for the script screen. `output` is the text the call
// reported so far (its partial results, then its result), cut to the last OUTPUT_LINES lines.
export interface ScriptCall {
	id: string; // "<callId>/<n>"
	name: string; // the tool: bash, Agent, read, ...
	label: string; // its main argument, first line, cut (the bash command, an Agent's description, a path)
	status: ScriptCallStatus;
	startedAt: number;
	endedAt?: number;
	output: string;
}

export const OUTPUT_LINES = 200; // output lines kept per call
const LOG_LINES = 200; // log() lines kept per script
const RESULT_CHARS = 20_000; // the end text kept for the screen
const LABEL_CHARS = 80;
const LABEL_ARGS = ["command", "description", "file_path", "path", "pattern", "url", "query", "prompt"];

const lastLines = (text: string, n: number): string => {
	const lines = text.split("\n");
	return lines.length <= n ? text : lines.slice(-n).join("\n");
};

// The main argument of a call, first line, cut: what the panel and the screen say it is doing.
export function callLabel(args: Record<string, unknown> | undefined): string {
	const value = LABEL_ARGS.map((k) => args?.[k]).find((v) => typeof v === "string" && v.trim() !== "") as
		| string
		| undefined;
	const line = (value ?? "").trim().split("\n")[0]!;
	return line.length > LABEL_CHARS ? `${line.slice(0, LABEL_CHARS - 1)}…` : line;
}

// What a script row and the end message call the script: its description, else its first bash command, else nothing.
export function scriptLabel(script: ScriptRecord): string | undefined {
	return script.description ?? script.calls.find((c) => c.name === "bash" && c.label)?.label;
}

export interface ScriptRecord {
	id: string; // S1, S2, ... (the controller's script id)
	callId: string; // the codemode tool call id; the script's Agent calls have ids "<callId>/<n>"
	description?: string; // the codemode call's `description`: a few words naming the script
	code?: string; // the script's source
	calls: ScriptCall[]; // the tool calls it made, in order
	logs: string[]; // its log() lines
	result?: string; // when it ended: the return value or output, or the error text (with state "failed")
	workflow?: string; // the saved workflow it runs, when a /name command started it
	run?: string; // the workflow run's id (R1, R2, ...): its results are saved for a relaunch
	saved?: number; // Agent calls answered from a relaunched run's saved results
	paused?: boolean; // it starts no new agent: its Agent calls wait (`gate`) until it is resumed
	sessionId: string; // the main session the script belongs to
	state: ScriptState;
	stopRequested: boolean; // stopped through the registry (the panel x, or the session ending)
	pinned: boolean; // an Agent call said run_in_background: false: the script stays in the foreground
	agents: string[]; // agentIds in start order
	members: AgentCall[]; // every Agent execute the script started, in start order (spec 09)
	group?: Group; // set when its code ended with agents left running
	phases: Record<string, string>; // agentId -> the `phase()` title it was started in
	phase?: string; // the latest `phase()` title
	log?: string; // the latest `log()` line
	startedAt: number;
	endedAt?: number;
}

// One Agent execute a script started. A member of the script's group unless it said `wake: "each"`.
export interface AgentCall {
	callId: string; // the nested tool call id of the Agent execute
	description: string;
	type: string; // the subagent_type asked for, then the one that ran
	agentId?: string; // once the agent is resolved
	member: boolean; // false: `wake: "each"`, it reports on its own
	background: boolean; // run_in_background: ended when its run ends, not when the call returned
	status: "running" | Status | "stopped";
	error?: string;
	output?: string;
	cost: number;
	startedAt: number;
	endedAt?: number;
	runningAtEnd: boolean; // still running when the script's code ended
	controller: AbortController; // the agent's own signal (a run_in_background agent has its own)
	detached: boolean; // registered with registry.detach (forgotten when it ends)
	unforward: () => void; // stop forwarding the call's signal to the agent
}

// What the script's end left running.
interface Group {
	kept: boolean; // the codemode host kept the script (it ended with calls still running): release it at the end
	background: boolean; // the script was in the background when its code ended: its outcome is part of the message
	outcome: { result?: CodemodeScriptEnd["result"]; error?: Error }; // the script's own end
	pending: number; // kept calls that hold the group's message: not settled, and not joined as `wake: "each"`
	each: number; // kept calls joined as `wake: "each"`, not settled: they hold only the release
	joined: Set<string>; // call ids of those calls
	reported: boolean; // the group's message went out (or had nothing to say)
	failed: { description: string; error: string }[]; // kept calls that failed before they became an agent
	pausedAtEnd: boolean; // it was paused when its code ended: its late calls do not start
	finish?: (outcome: CodemodeScriptEnd) => void; // the group's end, through the session-ownership check (a kept script: only when its release waits for `wake: "each"` calls)
	done: boolean;
}

/** The handle an Agent execute in a script gets (`scripts.join`). */
export interface AgentCallHandle {
	readonly call: AgentCall;
	/** The signal the agent runs on, for a call that is not `run_in_background`. */
	signal: AbortSignal;
	/** Its agent is resolved. */
	started(agentId: string): void;
	/** It runs in the background (`run_in_background`): it ends when its run ends. */
	runsDetached(): void;
	/** It ended: its result, or the error it threw. */
	end(
		result?: {
			status: AgentCall["status"];
			agentType: string;
			output: string;
			error?: string;
			usage: { cost: { total: number } };
		},
		error?: string,
	): void;
	/** Its script's code had ended (a group is running): it reports through the group, or on its own when not a member. */
	afterScriptEnd(): boolean;
}

export const PAUSED_AT_END = "not started: the script was paused";

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
		return script && scriptRunning(script) ? script : undefined;
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
					...(info.description ? { description: info.description } : {}),
					...(info.code === undefined ? {} : { code: info.code }),
					calls: [],
					logs: [],
					...(workflowOf(info.toolCallId) ? { workflow: workflowOf(info.toolCallId) } : {}),
					...(runs.ofScript(info.toolCallId) ? { run: runs.ofScript(info.toolCallId)!.id } : {}),
					sessionId: info.sessionId,
					state: "foreground",
					stopRequested: false,
					pinned: false,
					agents: [],
					members: [],
					phases: {},
					startedAt: info.startedAt,
				});
				this.changed();
			},
			onBackground: (info) => {
				const script = live && own.has(info.id) ? this.scripts.get(info.id) : undefined;
				if (script) this.setState(script, "background");
			},
			onKeep: (info, kept) => {
				const script = live && own.has(info.id) ? this.scripts.get(info.id) : undefined;
				// Kept for a script of this session that is not tracked: nothing would release it.
				if (!script) {
					if (live && info.sessionId === link.sessionId()) codemodeScripts.release(info.id);
					return;
				}
				this.keep(script, kept, (end) => {
					// The group's message goes out before `wake: "each"` calls have ended; the release follows them.
					if (live && own.delete(info.id)) this.ended(script, end, link);
				});
			},
			onEnd: (info, outcome) => {
				if (!live || !own.has(info.id)) return;
				const script = this.scripts.get(info.id);
				// Not kept, but run_in_background members still run: they form the group, which ends through `finish`. (Other
				// agents still running here were cancelled with their calls: an abort.)
				if (
					script &&
					!script.group &&
					script.members.some((m) => m.member && m.background && m.status === "running")
				) {
					this.formGroup(script, { kept: false, background: outcome.background, outcome });
					script.group!.finish = (end) => {
						if (live && own.delete(info.id)) this.ended(script, end, link);
					};
					this.checkGroup(script);
					return;
				}
				own.delete(info.id);
				if (script) this.ended(script, outcome, link);
			},
		});
		// `codemode` calls with run_in_background move only while this instance is on and serves the session.
		const offBackground = codemodeScripts.provideBackground({
			sessionId: () => link.sessionId(),
			enabled: () => live && link.enabled(),
		});
		return () => {
			// Disconnected (session shutdown or a new connect): scripts still running here end unseen, so their rows are
			// closed now and nothing of them is delivered later.
			live = false;
			off();
			offBackground();
			for (const id of own) {
				const script = this.scripts.get(id);
				if (script && scriptRunning(script)) this.setState(script, "stopped");
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
		// `text` is what an end message shows: the error, or the return value. `allFailed`: it returned normally but
		// every agent it ran failed or was stopped.
		const text = outcome.error ? outcome.error.message : textOf(outcome.result);
		script.result = text.length > RESULT_CHARS ? `${text.slice(0, RESULT_CHARS)}\n[cut]` : text;
		// Calls still running were cut off by the end.
		for (const call of script.calls) {
			if (call.status === "running") {
				call.status = "error";
				call.endedAt = Date.now();
			}
		}
		this.setState(script, state);
		// A group always reports (its agents ran after the script's result); otherwise only a background script does.
		if (!outcome.background && !script.group) return;
		// A foreground script that left only `wake: "each"` calls: they report on their own, nothing to say here.
		if (
			!outcome.background &&
			script.group &&
			!script.members.some((m) => m.member) &&
			script.group.failed.length === 0
		)
			return;
		try {
			const allFailed = !outcome.error && !outcome.result?.isError && state === "failed";
			link.deliver(
				script.group
					? groupMessage(script, state, text, link.parent(), allFailed, outcome.background)
					: endMessage(script, state, text, link.parent(), allFailed),
			);
		} catch (e) {
			console.error(`subagent: could not deliver the end of script ${script.id}: ${(e as Error).message}`); // never crash pi
		}
	}

	// An Agent call is about to start. `false` pins its foreground script (later calls do not move it); `true` leaves the
	// script alone (only that agent runs in the background); otherwise the first call moves a foreground script.
	agentStarting(toolCallId: string, runInBackground?: boolean): void {
		// A call the script left running may arrive after its stop has closed the record (the session's end).
		const info = codemodeScripts.owner(toolCallId);
		const stopping = info && this.scripts.get(info.id);
		if (stopping?.stopRequested) throw new Error(`script ${stopping.id} is being stopped`);
		const script = this.owner(toolCallId);
		if (!script) return;
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

	// --- groups (spec 09)

	// An Agent execute of a tracked script: its handle, which gives the agent its own signal (forwarding the call's until
	// the script's code ends) and records how it ends. Undefined outside a tracked script.
	join(
		toolCallId: string,
		params: { description?: unknown; subagent_type?: unknown; wake?: unknown },
		callSignal: AbortSignal | undefined,
	): AgentCallHandle | undefined {
		const script = this.owner(toolCallId);
		if (!script) return undefined;
		const controller = new AbortController();
		const forward = () => controller.abort(callSignal?.reason);
		let runningAtEnd = false;
		// A call that reaches here after the script's code ended was left running: nothing aborts it but a stop.
		if (script.state === "ended") runningAtEnd = true;
		else {
			if (callSignal?.aborted) controller.abort(callSignal.reason);
			else callSignal?.addEventListener("abort", forward, { once: true });
		}
		const call: AgentCall = {
			callId: toolCallId,
			description: typeof params.description === "string" ? params.description : "",
			type: typeof params.subagent_type === "string" ? params.subagent_type : "general-purpose",
			member: params.wake !== "each",
			background: false,
			status: "running",
			cost: 0,
			startedAt: Date.now(),
			runningAtEnd,
			controller,
			detached: false,
			unforward: () => callSignal?.removeEventListener("abort", forward),
		};
		script.members.push(call);
		if (script.group) this.joinedKept(script.group, call);
		const detach = () => {
			if (call.detached || call.background || call.agentId === undefined) return;
			registry.detach(call.agentId, script.sessionId, controller);
			call.detached = true;
		};
		return {
			call,
			signal: controller.signal,
			started: (agentId) => {
				call.agentId = agentId;
				if (script.group) detach();
				if (script.stopRequested) controller.abort(new Error(`script ${script.id} is being stopped`));
			},
			runsDetached: () => {
				call.background = true;
				call.unforward();
			},
			end: (result, error) => {
				if (call.status !== "running") return;
				call.status = result?.status ?? (call.agentId !== undefined && error ? "stopped" : "failed");
				if (result) {
					call.type = result.agentType;
					call.output = result.output;
					call.cost = result.usage.cost.total;
				}
				const err = result?.error ?? error;
				if (err !== undefined) call.error = err;
				call.endedAt = Date.now();
				call.unforward();
				if (call.detached && call.agentId !== undefined) registry.forget(call.agentId);
				this.changed();
				this.checkGroup(script);
			},
			afterScriptEnd: () => script.group !== undefined,
		};
	}

	// The script's code ended with calls the host left running: they and the agents still running form its group.
	private keep(script: ScriptRecord, kept: CodemodeScriptKept, finish: Group["finish"]): void {
		this.formGroup(script, {
			kept: true,
			background: kept.background,
			outcome: { ...(kept.result ? { result: kept.result } : {}), ...(kept.error ? { error: kept.error } : {}) },
		});
		const group = script.group!;
		group.finish = finish;
		for (const call of kept.calls) this.awaitKept(script, group, call);
		// `wake: "each"` calls that had already reached Agent's execute: they no longer hold the group's message.
		for (const call of script.members)
			if (call.status === "running" && !call.background && !call.member) this.joinedKept(group, call);
		this.checkGroup(script);
	}

	// A kept call reached Agent's execute as `wake: "each"`: it reports on its own, so it no longer holds the group's
	// message. It still holds the script's release, so the usage it reports is counted before the nested-call scope ends.
	private joinedKept(group: Group, call: AgentCall): void {
		if (call.member || !group.kept || group.done || group.pending === 0 || group.joined.has(call.callId)) return;
		group.pending--;
		group.each++;
		group.joined.add(call.callId);
	}

	private formGroup(script: ScriptRecord, group: Pick<Group, "kept" | "background" | "outcome">): void {
		script.group = {
			...group,
			pending: 0,
			each: 0,
			joined: new Set(),
			reported: false,
			failed: [],
			pausedAtEnd: false,
			done: false,
		};
		// A paused script that ends: its waiting calls do not start (they would wait for the group, which waits for them).
		if (script.paused) {
			script.paused = false;
			script.group.pausedAtEnd = true;
			this.releaseWaiting(script.id, new Error(PAUSED_AT_END));
		}
		for (const call of script.members) {
			if (call.status !== "running") continue;
			call.runningAtEnd = true;
			if (call.background) continue;
			// The agent no longer follows the call's signal; a stop reaches it through the registry.
			call.unforward();
			if (call.agentId !== undefined && !call.detached) {
				registry.detach(call.agentId, script.sessionId, call.controller);
				call.detached = true;
			}
		}
		script.state = "ended";
		this.changed();
	}

	// A kept call settles: one that failed before it became an agent is a line of the group.
	private awaitKept(script: ScriptRecord, group: Group, call: CodemodeKeptCall): void {
		group.pending++;
		void call.settled.then((settled) => {
			if (group.joined.delete(settled.toolCallId)) group.each--;
			else group.pending--;
			// It was still running when the script's code ended, whatever its member's status said then.
			const member = script.members.find((m) => m.callId === settled.toolCallId);
			if (member) member.runningAtEnd = true;
			if (settled.error !== undefined && !script.members.some((m) => m.callId === settled.toolCallId)) {
				const args = call.args as { description?: unknown } | undefined;
				const description = typeof args?.description === "string" ? args.description : call.name;
				group.failed.push({ description, error: settled.error });
				this.changed();
			}
			this.checkGroup(script);
		});
	}

	// The group ends when every kept call has settled and every member has ended; checked on each settlement and once
	// when the script ends. A kept script is released then (its end follows); otherwise the group's own end runs.
	private checkGroup(script: ScriptRecord): void {
		const group = script.group;
		if (!group || group.done || group.pending > 0) return;
		if (script.members.some((m) => m.member && m.status === "running")) return;
		const end = () => ({ ...group.outcome, stopped: script.stopRequested, background: group.background });
		// Only `wake: "each"` calls are left: the message goes out now, the release when they have settled.
		if (group.kept && group.each > 0) {
			if (!group.reported) {
				group.reported = true;
				group.finish?.(end());
			}
			return;
		}
		group.done = true;
		if (group.kept) {
			codemodeScripts.release(script.id);
			return;
		}
		group.finish?.(end());
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
		// Paused when its code ended: a call left running does not start either.
		if (script?.group?.pausedAtEnd) return Promise.reject(new Error(PAUSED_AT_END));
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
		else {
			script.log = note.log;
			script.logs.push(note.log);
			if (script.logs.length > LOG_LINES) script.logs.splice(0, script.logs.length - LOG_LINES);
		}
		this.changed();
	}

	// A tool call a script made (`tool_execution_*` with `parentToolCallId`): recorded on the script's record for its
	// screen. Only the script's own calls count, not what those calls call in turn.
	nested(event: ToolExecutionStartEvent | ToolExecutionUpdateEvent | ToolExecutionEndEvent): void {
		const script = this.owner(event.toolCallId);
		if (!script || event.parentToolCallId !== script.callId) return;
		if (event.type === "tool_execution_start") {
			script.calls.push({
				id: event.toolCallId,
				name: event.toolName,
				label: callLabel(event.args),
				status: "running",
				startedAt: Date.now(),
				output: "",
			});
		} else {
			const call = script.calls.find((c) => c.id === event.toolCallId);
			if (!call) return;
			if (event.type === "tool_execution_update") call.output = lastLines(textOf(event.partialResult), OUTPUT_LINES);
			else {
				call.status = event.isError ? "error" : "done";
				call.endedAt = Date.now();
				// A call whose result carries no text keeps what it streamed.
				const text = textOf(event.result);
				if (text) call.output = lastLines(text, OUTPUT_LINES);
			}
		}
		this.changed();
	}

	setState(script: ScriptRecord, state: ScriptState): void {
		script.state = state;
		if (!scriptRunning(script)) {
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
		if (!script || !scriptRunning(script)) return false;
		script.stopRequested = true; // from here on the script's Agent calls throw (agentStarting)
		this.releaseWaiting(id, new Error(`script ${script.id} is being stopped`)); // calls held by a pause
		// A group's agents that are not resolved yet have no record to stop: their own signal stops them.
		if (script.group) {
			for (const call of script.members)
				if (call.status === "running" && call.agentId === undefined && !call.background)
					call.controller.abort(new Error(`script ${script.id} is being stopped`));
		}
		await registry.stopAll(script.agents); // each running agent ends failed / "stopped by user"
		// the script itself, and any agent still waiting for a slot; a group whose script is no longer kept has no script
		return (await codemodeScripts.stop(id)) || script.group !== undefined;
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

const duration = (ms: number) =>
	ms < 60_000
		? `${Math.floor(ms / 1000)}s`
		: `${Math.floor(ms / 60_000)}m${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}s`;

// What main gets when a group ends: the script's outcome when it ran in the background, a line per member, the output
// of the members that were still running when the script's code ended (the script never saw it), and the totals.
// Members that ended before the script's code did were the script's to read: only their line, and their error.
export function groupMessage(
	script: ScriptRecord,
	state: ScriptState,
	text: string,
	parent: { sessionFile: string | undefined; sessionId: string },
	allFailed: boolean,
	background: boolean,
): string {
	const group = script.group!;
	const members = script.members.filter((m) => m.member);
	const now = Date.now();
	const cost = (m: AgentCall) =>
		m.cost > 0 ? m.cost : m.agentId !== undefined ? (registry.get(m.agentId)?.usage.cost.total ?? 0) : 0;
	// Its longest stall (spec 09), when it had one.
	const stall = (m: AgentCall) => {
		const ms = m.agentId !== undefined ? registry.longestStallOf(m.agentId, now) : undefined;
		return ms !== undefined ? ` ${stalledLabel(ms)}` : "";
	};
	const lines = [
		...members.map(
			(m) =>
				`- ${m.agentId ?? "(not started)"} ${m.type} ${JSON.stringify(m.description)} ${m.status} $${cost(m).toFixed(4)} ${duration((m.endedAt ?? now) - m.startedAt)}${stall(m)}${m.error !== undefined ? `\n  Error: ${m.error}` : ""}`,
		),
		...group.failed.map((f) => `- (not started) ${JSON.stringify(f.description)} failed\n  Error: ${f.error}`),
	];
	const outputs = members
		.filter((m) => m.runningAtEnd && m.output !== undefined && m.output !== "")
		.map((m) => `Output of ${m.agentId}:\n${capText(m.output!, parent, `${m.agentId}-output`)}`);
	const total = members.reduce((sum, m) => sum + cost(m), 0);
	const what = script.workflow
		? ` (workflow ${script.workflow}${script.run ? `, run ${script.run}` : ""})`
		: script.description
			? ` (${script.description})`
			: "";
	const head = background
		? endMessage(script, state, text, parent, allFailed, false)
		: `Agents left running by script ${script.id}${what} have ended.`;
	return [
		head,
		lines.length > 0 ? `Agents:\n${lines.join("\n")}` : "Agents: none",
		...outputs,
		`Total: $${total.toFixed(4)}, ${duration(now - script.startedAt)}`,
	].join("\n");
}

// `allFailed`: the script returned normally (text is its return value) but every agent it ran failed or was stopped.
// `agents`: false leaves out the agent list (a group message lists them itself).
export function endMessage(
	script: ScriptRecord,
	state: ScriptState,
	text: string,
	parent: { sessionFile: string | undefined; sessionId: string },
	allFailed = false,
	agentList = true,
): string {
	text = capText(text, parent, `script-${script.id}`);
	const agents = script.agents.map((id) => {
		const r = registry.get(id);
		return r ? `- ${id} ${r.type} ${r.status} $${r.usage.cost.total.toFixed(4)}` : `- ${id}`;
	});
	const what = script.workflow
		? ` (workflow ${script.workflow}${script.run ? `, run ${script.run}` : ""})`
		: script.description
			? ` (${script.description})`
			: "";
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
		...(agentList ? [agents.length > 0 ? `Agents:\n${agents.join("\n")}` : "Agents: none"] : []),
		...(script.saved ? [`Answered from saved results: ${script.saved}`] : []),
		...relaunch,
	].join("\n");
}
