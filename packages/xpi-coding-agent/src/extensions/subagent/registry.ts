// The subagent registry (v2 spec, "Subagent registry"): every subagent this pi process knows, live from runs and
// rebuilt from the agent meta files on session start. The panel, the subagent screen and `/subagents` read it and
// subscribe to changes; stop, steer and set_model reach a running child through its handle.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyEvent, type LiveMessage } from "./live.ts";
import type { ParentContext } from "./resolve.ts";
import {
	addUsage,
	type ChildEvent,
	type ChildHandle,
	emptyUsage,
	type Progress,
	type RunResult,
	type Status,
	type Usage,
} from "./runner.ts";
import { subagentSessionDir } from "./sessions.ts";
import type { WorktreeRef } from "./worktree.ts";

export type SubagentStatus = Status | "running" | "stopped";

// How a status is drawn (panel and subagent screen). A new status is a type error until it has both.
export const ICONS: Record<SubagentStatus, string> = {
	running: "●",
	completed: "✓",
	partial: "◐",
	failed: "✗",
	stopped: "■",
};
export const COLORS: Record<SubagentStatus, "accent" | "success" | "warning" | "error"> = {
	running: "accent",
	completed: "success",
	partial: "warning",
	failed: "error",
	stopped: "warning",
};

export interface SubagentRecord {
	id: string; // the agentId
	parentSessionId: string;
	type: string;
	name?: string; // given by the `Agent` call that started it; unique in the parent session
	description: string;
	status: SubagentStatus;
	turns: number; // all exchanges together
	lastTool?: string;
	usage: Usage; // all exchanges together
	startedAt: number; // first start, ms since epoch
	endedAt?: number; // end of the latest exchange; unset while running
	model: string; // as resolved for the latest exchange ("" for v1 meta files)
	thinking: string;
	color?: string; // the agent definition's colour name, if any
	sessionDir?: string; // where the child session and meta file live; unset for an in-memory parent
	worktree?: WorktreeRef; // set when the subagent is isolated: where it runs and the commit it started from
}

// "type(description)", or the type alone; a named subagent is "type(name) description".
export const label = (r: Pick<SubagentRecord, "type" | "description" | "name">): string =>
	r.name
		? `${r.type}(${r.name})${r.description ? ` ${r.description}` : ""}`
		: r.description
			? `${r.type}(${r.description})`
			: r.type;

export const AGENT_NAME = /^[A-Za-z0-9_-]{1,64}$/;

// "model · effort", leaving out what the record does not have (older meta files have no model).
export const modelInfo = (r: Pick<SubagentRecord, "model" | "thinking">): string =>
	[r.model, r.thinking].filter((s) => s !== "").join(" · ");

export interface SubagentStart {
	id: string;
	type: string;
	name?: string; // omit the key for a resume or a talk: the subagent keeps its name
	description: string;
	model: string;
	thinking: string;
	color?: string;
	worktree?: WorktreeRef; // omit the key (not undefined) for a non-isolated exchange: a resume keeps the stored one
}

// The file keeps v1's `agentType` key so older versions still read it.
type MetaFile = { agentType: string } & Partial<Omit<SubagentRecord, "id" | "parentSessionId" | "type" | "sessionDir">>;

class Registry {
	private records = new Map<string, SubagentRecord>();
	private handles = new Map<string, ChildHandle>();
	private prior = new Map<string, { turns: number; usage: Usage }>(); // totals before the exchange in progress
	private tails = new Map<string, Promise<void>>(); // per subagent: resolves when the last queued turn has ended
	private queued = new Map<string, number>(); // per subagent: turns running or waiting
	private stopping = new Set<string>(); // stop requested for the exchange in progress
	private restarting = new Set<string>(); // restart requested for the exchange in progress
	private firstRun = new Set<string>(); // running its first exchange (not a resume): the only one that can restart
	private ranHere = new Set<string>(); // started an exchange in this process; only these linger in the panel
	private listeners = new Set<() => void>();
	private lives = new Map<string, LiveMessage>(); // the message each running child is writing
	private watchers = new Map<string, Set<(event: ChildEvent) => void>>();
	private claims = new Map<string, string>(); // "<session id>\0<name>" -> the agent id starting under that name

	// The parent session's subagents, newest first.
	list(parentSessionId: string): SubagentRecord[] {
		return [...this.records.values()]
			.filter((r) => r.parentSessionId === parentSessionId)
			.sort((a, b) => b.startedAt - a.startedAt);
	}

	// What the panel shows: running subagents, and those that ended in this process less than `lingerMs` ago. Oldest
	// first, so rows do not jump. Records rebuilt from the meta files are never shown.
	visible(parentSessionId: string, lingerMs: number): SubagentRecord[] {
		const now = Date.now();
		// list() is newest first and keeps insertion order among equal start times (calls in one tick)
		return this.list(parentSessionId)
			.map((r, i) => ({ r, i }))
			.filter(({ r }) => this.ranHere.has(r.id) && (r.endedAt === undefined || now - r.endedAt < lingerMs))
			.sort((a, b) => a.r.startedAt - b.r.startedAt || a.i - b.i)
			.map(({ r }) => r);
	}

	get(id: string): SubagentRecord | undefined {
		return this.records.get(id);
	}

	// The id of the session's subagent with this name: a known one, or one that claimed the name and has not started yet.
	named(parentSessionId: string, name: string): string | undefined {
		for (const r of this.records.values()) if (r.parentSessionId === parentSessionId && r.name === name) return r.id;
		return this.claims.get(`${parentSessionId}\0${name}`);
	}

	// What `resume` or `SendMessage` names: an id of the session, else a name. Undefined when it is neither.
	find(parentSessionId: string, ref: string): string | undefined {
		const byId = this.records.get(ref);
		if (byId?.parentSessionId === parentSessionId) return ref;
		return this.named(parentSessionId, ref);
	}

	// Take a name for an agent that is about to start, so two calls in one tick cannot both have it. Throws when another
	// subagent of the session has it. `release` gives it back if the agent never started.
	claim(parentSessionId: string, name: string, id: string): () => void {
		const owner = this.named(parentSessionId, name);
		if (owner !== undefined && owner !== id) {
			throw new Error(`the name "${name}" is already used by agent ${owner} of this session`);
		}
		const key = `${parentSessionId}\0${name}`;
		this.claims.set(key, id);
		return () => {
			if (this.claims.get(key) === id && !this.records.has(id)) this.claims.delete(key);
		};
	}

	// The live child of a running subagent; undefined when it is not running.
	handle(id: string): ChildHandle | undefined {
		return this.handles.get(id);
	}

	// Run `fn` when every earlier turn of this subagent has ended: one process per subagent, in arrival order. A caller
	// that aborts while waiting leaves the queue without running.
	async turn<T>(id: string, signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
		const prev = this.tails.get(id) ?? Promise.resolve();
		let release!: () => void;
		const tail = prev.then(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		this.tails.set(id, tail);
		this.queued.set(id, (this.queued.get(id) ?? 0) + 1);
		void tail.then(() => this.tails.get(id) === tail && this.tails.delete(id));
		try {
			await new Promise<void>((resolve, reject) => {
				if (signal?.aborted) return reject(new Error("aborted"));
				const onAbort = () => reject(new Error("aborted"));
				signal?.addEventListener("abort", onAbort, { once: true });
				void prev.then(() => {
					signal?.removeEventListener("abort", onAbort);
					resolve();
				});
			});
			return await fn();
		} finally {
			const left = this.queued.get(id)! - 1;
			if (left === 0) this.queued.delete(id);
			else this.queued.set(id, left);
			// `release` is set once prev has resolved; an abort while waiting must still free the place in line
			void prev.then(() => release());
		}
	}

	// Ask a running subagent to stop (rpc abort). False when it is not running. Whether the exchange ended stopped is
	// decided by how the run ends (exchange.ts): it may finish by itself before the abort lands.
	stop(id: string): boolean {
		if (!this.handles.get(id)?.send({ type: "abort" })) return false;
		this.stopping.add(id);
		return true;
	}

	// Why this subagent cannot be restarted; undefined when it can. A restart starts the agent over with the prompt of
	// the exchange in progress, so only a first run qualifies: a continued agent would lose its earlier conversation, and
	// a fork's start is a copy of main taken once.
	restartRefusal(id: string): string | undefined {
		const r = this.records.get(id);
		if (!r || r.status !== "running" || !this.handles.has(id)) return "the subagent is not running";
		if (r.type === "fork") return "a fork cannot be restarted: it starts from a copy of the conversation";
		if (!this.firstRun.has(id)) return "only an agent's first run can be restarted; this one was continued";
		return undefined;
	}

	// Restart a running subagent: its child is stopped and the exchange starts it over (exchange.ts). Returns why not,
	// when it cannot.
	restart(id: string): string | undefined {
		const refusal = this.restartRefusal(id);
		if (refusal !== undefined) return refusal;
		if (!this.handles.get(id)?.send({ type: "abort" })) return "the subagent is not running";
		this.restarting.add(id);
		return undefined;
	}

	// True once, if a restart was requested for the run that just ended.
	restartRequested(id: string): boolean {
		return this.restarting.delete(id);
	}

	// A run ended because of a restart: its turns and usage stay counted, and the child is gone until the next attach.
	carry(id: string, run: RunResult): void {
		const prior = this.prior.get(id)!;
		const usage = structuredClone(prior.usage);
		addUsage(usage, run.usage);
		this.prior.set(id, { turns: prior.turns + run.turns, usage });
		this.handles.delete(id);
		this.lives.delete(id);
		this.stopping.delete(id);
		this.update(id, { turns: prior.turns + run.turns, usage, lastTool: undefined });
	}

	// Stop these subagents (those not running are skipped) and resolve when every one has ended. Each ends failed /
	// "stopped by user" as with `stop`.
	async stopAll(ids: string[]): Promise<void> {
		this.abortQueued(ids);
		const stopped = ids.filter((id) => this.stop(id));
		if (stopped.length === 0) return;
		await new Promise<void>((resolve) => {
			const check = () => {
				if (stopped.some((id) => this.records.get(id)?.status === "running")) return;
				unsubscribe();
				resolve();
			};
			const unsubscribe = this.subscribe(check);
			check();
		});
	}

	// Detached (run_in_background) agents run on their own signal; this keeps it so a stop reaches one that is still
	// waiting for its turn or a slot (it has no child to abort yet).
	private detached = new Map<string, { controller: AbortController; sessionId: string }>();

	detach(id: string, sessionId: string, controller: AbortController): void {
		this.detached.set(id, { controller, sessionId });
	}

	forget(id: string): void {
		this.detached.delete(id);
	}

	// Abort these detached agents if they have not started a child; a running one is stopped through its child instead.
	abortQueued(ids: string[]): void {
		for (const id of ids) {
			const d = this.detached.get(id);
			if (d && !this.handles.has(id) && this.records.get(id)?.status !== "running") d.controller.abort();
		}
	}

	// Every detached agent of the session still waiting (session end, stop all).
	abortQueuedOf(sessionId: string): void {
		this.abortQueued([...this.detached].filter(([, d]) => d.sessionId === sessionId).map(([id]) => id));
	}

	// True once, if a stop was requested for the exchange that just ended.
	stopRequested(id: string): boolean {
		return this.stopping.delete(id);
	}

	// Use this model (provider/id) for the subagent's later exchanges, and switch the running child now. Returns why
	// not, if pi refuses; then nothing is stored.
	async setModel(id: string, model: string): Promise<string | undefined> {
		const handle = this.handles.get(id);
		if (handle) {
			const slash = model.indexOf("/");
			const error = await handle.setModel(model.slice(0, slash), model.slice(slash + 1));
			if (error !== undefined) return error;
		}
		const record = this.update(id, { model });
		this.writeMeta(record);
		return undefined;
	}

	// True while a turn runs or waits for this subagent.
	busy(id: string): boolean {
		return this.queued.has(id);
	}

	// The running child's events (runner.ts), in order. Not a record change: no `subscribe` listener is called.
	event(id: string, event: ChildEvent): void {
		const live = applyEvent(this.lives.get(id), event);
		if (live) this.lives.set(id, live);
		else this.lives.delete(id);
		for (const w of this.watchers.get(id) ?? []) w(event);
	}

	// The assistant message a running subagent is writing right now; undefined between messages and when not running.
	streaming(id: string): LiveMessage | undefined {
		return this.lives.get(id);
	}

	// Call `watcher` with each event of this subagent's running child. Returns the unsubscribe function.
	watch(id: string, watcher: (event: ChildEvent) => void): () => void {
		const set = this.watchers.get(id) ?? new Set();
		set.add(watcher);
		this.watchers.set(id, set);
		return () => set.delete(watcher);
	}

	// Resolves when every turn queued so far has ended.
	async drained(id: string): Promise<void> {
		await this.tails.get(id);
	}

	// Called after any record changes. Returns the unsubscribe function.
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	// Load the parent session's meta files. Ids already known (live, or loaded before) are kept as they are. A file that
	// cannot be read is skipped; the returned warnings say which and why.
	rebuild(parent: ParentContext): string[] {
		const warnings: string[] = [];
		if (!parent.sessionFile) return warnings;
		const dir = subagentSessionDir(parent);
		if (!existsSync(dir)) return warnings;
		for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
			const id = file.slice(0, -".json".length);
			if (this.records.has(id)) continue;
			const path = join(dir, file);
			let meta: MetaFile;
			try {
				meta = JSON.parse(readFileSync(path, "utf8"));
				if (typeof meta?.agentType !== "string") throw new Error("no agentType");
			} catch (err) {
				warnings.push(`skipped subagent meta file ${path}: ${(err as Error).message}`);
				continue;
			}
			const mtime = statSync(path).mtimeMs;
			// A v1 file has no status: its run finished. A "running" status with no live child is a run that died.
			const ended = meta.status === undefined || meta.status === "running";
			this.records.set(id, {
				id,
				parentSessionId: parent.sessionId,
				type: meta.agentType,
				...(typeof meta.name === "string" ? { name: meta.name } : {}),
				description: meta.description ?? "",
				status: meta.status === undefined ? "completed" : meta.status === "running" ? "stopped" : meta.status,
				turns: meta.turns ?? 0,
				lastTool: meta.lastTool,
				usage: meta.usage ?? emptyUsage(),
				startedAt: meta.startedAt ?? mtime,
				endedAt: ended ? mtime : meta.endedAt,
				model: meta.model ?? "",
				thinking: meta.thinking ?? "",
				color: meta.color,
				sessionDir: dir,
				...(meta.worktree ? { worktree: meta.worktree } : {}),
			});
		}
		this.emit();
		return warnings;
	}

	// An exchange starts: a new subagent, or a resumed one (known from the meta files or from earlier runs).
	begin(parent: ParentContext, start: SubagentStart): void {
		this.rebuild(parent); // its warnings were shown at session start
		const old = this.records.get(start.id);
		this.prior.set(start.id, { turns: old?.turns ?? 0, usage: old?.usage ?? emptyUsage() });
		this.ranHere.add(start.id);
		if (old) this.firstRun.delete(start.id);
		else this.firstRun.add(start.id);
		const record: SubagentRecord = {
			...old,
			...start,
			parentSessionId: parent.sessionId,
			status: "running",
			turns: old?.turns ?? 0,
			usage: old?.usage ?? emptyUsage(),
			startedAt: old?.startedAt ?? Date.now(),
			endedAt: undefined,
			sessionDir: parent.sessionFile ? subagentSessionDir(parent) : undefined,
		};
		this.records.set(start.id, record);
		this.writeMeta(record);
		this.emit();
	}

	// `/subagents worktrees` removed the subagent's worktree and branch: a resume must not recreate it.
	markWorktreeRemoved(id: string): void {
		const old = this.records.get(id);
		if (!old?.worktree) return;
		const record = this.update(id, { worktree: { ...old.worktree, removed: "user" } });
		this.writeMeta(record);
	}

	attach(id: string, handle: ChildHandle): void {
		this.handles.set(id, handle);
		this.emit();
	}

	progress(id: string, p: Progress): void {
		this.update(id, { turns: this.prior.get(id)!.turns + p.turns, lastTool: p.lastTool });
	}

	// The exchange ended. `run` is absent when it ended without a result (the caller aborted).
	finish(id: string, status: SubagentStatus, run?: RunResult): void {
		const prior = this.prior.get(id)!;
		const usage = structuredClone(prior.usage);
		if (run) addUsage(usage, run.usage);
		this.prior.delete(id);
		this.handles.delete(id);
		this.lives.delete(id);
		this.stopping.delete(id);
		this.restarting.delete(id);
		this.firstRun.delete(id);
		const record = this.update(id, {
			status,
			endedAt: Date.now(),
			...(run ? { turns: prior.turns + run.turns, usage } : {}),
		});
		this.writeMeta(record);
	}

	// For tests that simulate a fresh pi process (/reload).
	clear(): void {
		this.records.clear();
		this.handles.clear();
		this.prior.clear();
		this.lives.clear();
		this.ranHere.clear();
		this.restarting.clear();
		this.firstRun.clear();
		this.claims.clear();
		this.listeners.clear(); // a fresh process has no screens or panels yet
		this.watchers.clear();
	}

	private update(id: string, patch: Partial<SubagentRecord>): SubagentRecord {
		const record = { ...this.records.get(id)!, ...patch };
		this.records.set(id, record);
		this.emit();
		return record;
	}

	private writeMeta(r: SubagentRecord): void {
		if (!r.sessionDir) return;
		const { id, parentSessionId: _parent, type, sessionDir, ...rest } = r;
		mkdirSync(sessionDir, { recursive: true });
		writeFileSync(join(sessionDir, `${id}.json`), JSON.stringify({ agentType: type, ...rest }));
	}

	private emit(): void {
		for (const l of this.listeners) l();
	}
}

export const registry = new Registry();
