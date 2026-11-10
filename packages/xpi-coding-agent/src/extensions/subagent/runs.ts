// Workflow runs and their saved results (spec .scratch/xin-pi-workflows/07-relaunch-and-pause.md). Every run of a saved
// workflow records its Agent calls, in the order the script makes them, with what each asked and what it returned. A
// relaunch of a run that stopped or failed executes the script again from the top and answers calls from that record
// for as long as they ask the same thing and completed last time; from the first one that does not, everything runs.
//
// A run is found from a tool call id: its script's calls have ids "<the run's call id>/<n>".

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { codemodeScripts } from "../codemode/scripts.ts";
import type { AgentResult } from "./agent-tool.ts";
import { subagentSessionDir } from "./sessions.ts";

export type RunState = "running" | "completed" | "failed" | "stopped";

export interface RunCall {
	key: string; // what was asked: the fields a relaunch compares
	description: string;
	background: boolean; // run_in_background: true: never answered from saved results, and not compared
	status: "running" | "completed" | "partial" | "failed";
	result?: AgentResult; // of a call that returned one
	error?: string; // of a call that threw
	saved?: string; // answered from this run's saved results (a run id), not run
}

export interface Run {
	id: string; // R1, R2, ... per session
	workflow: string;
	args?: unknown;
	relaunchOf?: string;
	state: RunState;
	calls: RunCall[];
	startedAt: number;
	endedAt?: number;
}

interface Session {
	sessionFile: string | undefined;
	sessionId: string;
}

// What a relaunch still has to compare: the earlier run's calls, and whether a call has already differed.
interface Live {
	run: Run;
	session: Session;
	earlier?: RunCall[]; // the relaunched run's calls that take part (not the background ones)
	position: number; // how many such calls this run has made
	diverged: boolean;
	earlierAgents: Set<string>; // agent ids of the relaunched run: a rerun call may take a name one of them holds
	pending?: ReturnType<typeof setTimeout>; // a write of the run file is due
}

const WRITE_DELAY_MS = 250;

// What an Agent call asks, as far as a relaunch compares it. `description` (the label) and `name` are not part of it.
export function callKey(params: Record<string, unknown>): string {
	return JSON.stringify([
		params.prompt,
		params.subagent_type ?? null,
		params.model ?? null,
		params.effort ?? null,
		params.schema ?? null,
		params.isolation ?? null,
		params.resume ?? null,
	]);
}

class Runs {
	private bySession = new Map<string, Map<string, Run>>(); // session id -> run id -> run
	private loaded = new Set<string>();
	private live = new Map<string, Live>(); // the run's codemode call id -> its bookkeeping
	private subscribed = false;

	private dir(session: Session): string | undefined {
		return session.sessionFile ? join(subagentSessionDir(session), "runs") : undefined;
	}

	// The session's runs, read from its run files once (an in-memory session has only this process's).
	private runsOf(session: Session): Map<string, Run> {
		let runs = this.bySession.get(session.sessionId);
		if (!runs) {
			runs = new Map();
			this.bySession.set(session.sessionId, runs);
		}
		const dir = this.dir(session);
		if (dir && !this.loaded.has(session.sessionId)) {
			this.loaded.add(session.sessionId);
			if (existsSync(dir)) {
				for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
					try {
						const run = JSON.parse(readFileSync(join(dir, file), "utf8")) as Run;
						// A run file left "running" belongs to a process that is gone.
						if (typeof run.id === "string" && !runs.has(run.id)) {
							runs.set(run.id, run.state === "running" ? { ...run, state: "stopped" } : run);
						}
					} catch {
						// an unreadable run file is no run
					}
				}
			}
		}
		return runs;
	}

	private write(live: Live): void {
		clearTimeout(live.pending);
		live.pending = undefined;
		const dir = this.dir(live.session);
		if (!dir) return;
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, `${live.run.id}.json`), JSON.stringify(live.run));
	}

	// The file holds every result of the run, so it is not rewritten for each call: changes within WRITE_DELAY_MS go
	// out together. The run's start and end are written at once. A process killed in between loses at most that much
	// of the record, and a relaunch then runs those calls again.
	private writeSoon(live: Live): void {
		if (live.pending) return;
		live.pending = setTimeout(() => this.write(live), WRITE_DELAY_MS);
		live.pending.unref();
	}

	// The session's runs, newest first.
	list(session: Session): Run[] {
		return [...this.runsOf(session).values()].sort((a, b) => b.startedAt - a.startedAt);
	}

	get(session: Session, id: string): Run | undefined {
		return this.runsOf(session).get(id);
	}

	// Why this run cannot be relaunched; undefined when it can.
	relaunchRefusal(session: Session, id: string, running: (agentId: string) => boolean): string | undefined {
		const run = this.get(session, id);
		if (!run) return `nothing to resume: no saved results for run ${id}`;
		if (run.state === "running") return `run ${id} is still running`;
		const agents = run.calls.flatMap((c) => (c.result?.agentId ? [c.result.agentId] : []));
		if (agents.some(running)) return `agents of run ${id} are still running: wait for them, or stop them`;
		const unfinished = run.calls.some((c) => !c.background && c.status !== "completed");
		if (run.state === "completed" && !unfinished) return `run ${id} completed: nothing to relaunch`;
		return undefined;
	}

	// A run begins: the script that is about to start under `callId` runs `workflow`. Call it before the script starts.
	begin(session: Session, callId: string, workflow: string, args: unknown, relaunchOf?: Run): Run {
		this.follow();
		const runs = this.runsOf(session);
		const n = Math.max(0, ...[...runs.keys()].map((id) => Number(id.slice(1)) || 0)) + 1;
		const run: Run = {
			id: `R${n}`,
			workflow,
			...(args === undefined ? {} : { args }),
			...(relaunchOf ? { relaunchOf: relaunchOf.id } : {}),
			state: "running",
			calls: [],
			startedAt: Date.now(),
		};
		runs.set(run.id, run);
		const live: Live = {
			run,
			session,
			...(relaunchOf ? { earlier: relaunchOf.calls.filter((c) => !c.background) } : {}),
			position: 0,
			diverged: false,
			earlierAgents: new Set(
				(relaunchOf?.calls ?? []).flatMap((c) => (c.result?.agentId ? [c.result.agentId] : [])),
			),
		};
		this.live.set(callId, live);
		this.write(live);
		return run;
	}

	private liveOf(toolCallId: string): Live | undefined {
		for (const [callId, live] of this.live) if (toolCallId.startsWith(`${callId}/`)) return live;
		return undefined;
	}

	// The run whose script made this tool call, if a workflow run did.
	of(toolCallId: string): Run | undefined {
		return this.liveOf(toolCallId)?.run;
	}

	// The run a script runs, from the script's own codemode call id.
	ofScript(callId: string): Run | undefined {
		return this.live.get(callId)?.run;
	}

	// Whether an agent belongs to the run this call's run relaunches (a rerun call may take over its name).
	isEarlierAgent(toolCallId: string, agentId: string): boolean {
		return this.liveOf(toolCallId)?.earlierAgents.has(agentId) ?? false;
	}

	// An Agent call of a run's script. Returns the saved result when the call is answered from the relaunched run, and
	// `done`, to report how a call that ran ended. Calls outside a run get neither.
	call(
		toolCallId: string,
		params: Record<string, unknown>,
	): { saved?: AgentResult; from?: string; done?: (outcome: { result?: AgentResult; error?: string }) => void } {
		const live = this.liveOf(toolCallId);
		if (!live) return {};
		const background = params.run_in_background === true;
		const call: RunCall = {
			key: callKey(params),
			description: typeof params.description === "string" ? params.description : "",
			background,
			status: "running",
		};
		live.run.calls.push(call);
		if (!background) {
			const before = live.earlier?.[live.position++];
			if (!live.diverged && before?.status === "completed" && before.result && before.key === call.key) {
				call.status = "completed";
				call.result = before.result;
				call.saved = live.run.relaunchOf;
				this.writeSoon(live);
				return { saved: before.result, from: live.run.relaunchOf };
			}
			live.diverged = true; // this call runs, and so does every one after it
		}
		this.writeSoon(live);
		return {
			done: ({ result, error }) => {
				// A background call returns "running" at once; what it does later is not part of the script's flow.
				call.status = result ? (result.status === "running" ? "completed" : result.status) : "failed";
				if (result) call.result = result;
				if (error !== undefined) call.error = error;
				this.writeSoon(live);
			},
		};
	}

	// Follow the codemode controller: a run ends when its script does.
	private follow(): void {
		if (this.subscribed) return;
		this.subscribed = true;
		codemodeScripts.subscribe({
			onEnd: (info, outcome) => {
				const live = this.live.get(info.toolCallId);
				if (!live) return;
				this.live.delete(info.toolCallId);
				live.run.state = outcome.stopped
					? "stopped"
					: outcome.error || outcome.result?.isError
						? "failed"
						: "completed";
				live.run.endedAt = Date.now();
				// Calls cut off by the end never returned.
				for (const call of live.run.calls) if (call.status === "running") call.status = "failed";
				this.write(live);
			},
		});
	}

	// For tests that simulate a fresh process.
	clear(): void {
		this.bySession.clear();
		this.loaded.clear();
		this.live.clear();
	}
}

export const runs = new Runs();

// How many of a run's calls were answered from saved results.
export const savedCalls = (run: Run): number => run.calls.filter((c) => c.saved !== undefined).length;
