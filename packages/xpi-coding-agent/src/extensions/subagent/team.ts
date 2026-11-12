// Agent teams in the lead process (spec .scratch/agent-teams/01-agent-teams.md): the team and its `config.json`, the
// members' states, and the deliverer, the only part that reads the mailboxes. Teammates are ordinary subagents (registry,
// exchanges); a team adds names that reach each other through files, and this module's bookkeeping of who is running,
// idle or stopped.

import { existsSync, readdirSync, readFileSync, rmSync, statSync, watch } from "node:fs";
import { basename, dirname, join } from "node:path";
import { getAgentDir } from "../../config.ts";
import type { EventBus } from "../../core/event-bus.ts";
import { registry } from "./registry.ts";
import type { ParentContext, TeamLaunch } from "./resolve.ts";
import type { ChildHandle, RunResult } from "./runner.ts";
import { capText } from "./sessions.ts";
import type { TeamSettings } from "./team-config.ts";
import {
	appendEntry,
	ensureDir,
	type InboxEntry,
	inboxFile,
	newEntryId,
	peekEntries,
	pidAlive,
	putBack,
	takeEntries,
	withLock,
	writeAtomic,
} from "./team-files.ts";
import { emitHook, type Verdict as HookVerdict } from "./team-hooks.ts";
import { releaseTasks, sweepTasks } from "./team-tasks.ts";
import { heldText, idleText, joinEnvelopes, LEAD, teamLabel } from "./team-text.ts";

export type MemberStatus = "running" | "queued" | "idle" | "stopping" | "stopped";

export interface Member {
	name: string;
	agentId: string;
	agentType: string;
	status: MemberStatus;
	since: number;
	shutdownRequested?: number; // when the lead asked it to shut down and it has not answered: a response needs this
}

// The file teammates read (only the lead writes it).
export interface TeamConfigFile {
	team: string;
	leadSessionId: string;
	leadPid: number;
	members: Member[];
}

// What the team needs of the session around it (src/index.ts supplies it).
export interface TeamHost {
	settings: TeamSettings;
	events?: EventBus; // pi.events: the agent-teams:* events go through it (team-hooks.ts)
	holdTimeoutMs?: number; // how long a hook's `hold` is awaited (tests shorten it)
	parent(): ParentContext;
	toLead(content: string): boolean; // a custom message with triggerTurn; false when the session is ending
	warn(message: string): void;
	wake(member: Member, prompt: () => string, signal: AbortSignal): Promise<void>; // a new exchange for an idle teammate; settles when it ends
}

export const MAX_WAKES = 5;
export const MAX_IDLE_BLOCKS = 3; // teammate_idle hooks block a teammate going idle this many times in a row
const POLL_MS = 1000;
const WATCH_DEBOUNCE_MS = 50;
const SELF_WRITE_MS = 200;
const STRAY_CONFIG_GRACE_MS = 60_000;

export const teamsRoot = (): string => join(getAgentDir(), "teams");

// What a user message looked like to the child: the text of a `message_end` event's message.
function messageText(message: { content?: unknown } | undefined): string {
	const c = message?.content;
	if (typeof c === "string") return c;
	if (!Array.isArray(c)) return "";
	return c.map((b: { type?: string; text?: string }) => (b.type === "text" ? (b.text ?? "") : "")).join("");
}

interface Steer {
	entries: InboxEntry[];
	user?: string; // set when the user typed it: it never was a mailbox entry, so an untaken one is kept in memory
	text: string;
	taken: boolean;
}

// Something about the members changed (the panel and the screens redraw). In-process: no file is involved.
const changeListeners = new Set<() => void>();
export function onTeamChange(fn: () => void): () => void {
	changeListeners.add(fn);
	return () => changeListeners.delete(fn);
}
const changed = (): void => {
	for (const fn of [...changeListeners]) fn();
};

// An idle teammate's new exchange that has not started yet (it waits for a slot): messages that come meanwhile join it.
interface PendingWake {
	entries: InboxEntry[];
	user: string[]; // what the user typed meanwhile, which comes first (it is not an agent message)
	text?: string; // set once the exchange began: the prompt is then fixed
}

export type Delivery = "steered" | "queued" | "started";

export type Verdict = "idle" | "stopped";

export class Team {
	readonly name: string;
	readonly label: string;
	readonly dir: string;
	readonly members = new Map<string, Member>();
	private readonly host: TeamHost;
	private readonly sessionId: string;
	private readonly wakes = new Map<string, number>(); // woken in a row by teammates' messages
	private readonly approved = new Set<string>(); // members whose shutdown the lead has seen approved
	private readonly steers = new Map<string, Steer[]>();
	private readonly pending = new Map<string, PendingWake>();
	private readonly unwatch = new Map<string, () => void>();
	private readonly held = new Map<string, string>(); // idle teammate -> the senders the lead was told are waiting
	private saving: Promise<void> = Promise.resolve();
	private chain: Promise<unknown> = Promise.resolve();
	private queuedPass = false;
	private passCount = 0;
	private kickTimer: NodeJS.Timeout | undefined;
	private readonly selfWrites = new Map<string, number>(); // mailbox name -> when a pass last rewrote it
	private readonly steerRefused = new Map<string, ChildHandle>(); // the child handle that refused a steer, per member: left alone while it is the current one
	private readonly exchanges = new Map<string, number>(); // exchanges begun, per member: a hold's verdict is for one
	private readonly idleBlocks = new Map<string, number>(); // teammate_idle blocks in a row, per teammate
	private readonly userQueue = new Map<string, string[]>(); // what the user typed that no running child has taken yet
	private readonly wakeControllers = new Map<string, AbortController>(); // a woken teammate's exchange waiting for a slot
	private readonly userStops = new Set<string>(); // the user stopped these while their exchange was still waiting
	private closing = false;
	private readonly wakeSignal = new AbortController(); // wakes waiting for a slot at session end must not start a child
	private timer: NodeJS.Timeout | undefined;
	private watcher: ReturnType<typeof watch> | undefined;

	private readonly root: string;

	constructor(sessionId: string, host: TeamHost, root = teamsRoot()) {
		this.root = root;
		this.sessionId = sessionId;
		this.host = host;
		this.name = `session-${sessionId}`;
		this.label = teamLabel(this.name);
		this.dir = join(root, this.name);
		// A directory left by a lead that is gone (a crash, then /resume of the same session): its mailboxes were written for a
		// run that no longer exists, and must not be delivered as new.
		let old: Partial<TeamConfigFile> | undefined;
		try {
			old = JSON.parse(readFileSync(this.configPath, "utf8")) as Partial<TeamConfigFile>;
		} catch {
			// no config.json: nothing was left
		}
		if (old && old.leadPid !== process.pid) {
			if (Number.isInteger(old.leadPid) && pidAlive(old.leadPid!)) {
				throw new Error(
					`team ${this.label} belongs to a lead that is still running (pid ${old.leadPid}): the same session is open in another xpi process, which agent teams do not support. Close it, or remove ${this.dir} if that process is not a lead of this session`,
				);
			}
			rmSync(join(this.dir, "inboxes"), { recursive: true, force: true });
		}
		ensureDir(join(this.dir, "inboxes"));
		this.members.set(LEAD, {
			name: LEAD,
			agentId: sessionId,
			agentType: "team-lead",
			status: "running",
			since: Date.now(),
		});
		writeAtomic(this.configPath, JSON.stringify(this.configFile()));
	}

	// How many passes over the mailboxes have run (a test checks that nothing makes them run away).
	get passes(): number {
		return this.passCount;
	}

	// The team's task list, next to `teams/` (it stays after the team ends).
	get tasksDir(): string {
		return join(dirname(this.root), "tasks", this.name);
	}

	get configPath(): string {
		return join(this.dir, "config.json");
	}

	private configFile(): TeamConfigFile {
		return {
			team: this.name,
			leadSessionId: this.sessionId,
			leadPid: process.pid,
			members: [...this.members.values()],
		};
	}

	// Write config.json (queued: the writes keep their order).
	private save(): void {
		this.saving = this.saving
			.then(() => withLock(this.configPath, () => writeAtomic(this.configPath, JSON.stringify(this.configFile()))))
			.catch((err: Error) => this.host.warn(`could not write the team's config.json: ${err.message}`));
	}

	// Queued after the config writes. Failing here only leaves the tasks as they were: another member's claim treats a
	// task whose owner is not live as free.
	private releaseTasks(name: string): void {
		this.saving = this.saving
			.then(() => releaseTasks(this.tasksDir, name).then(() => {}))
			.catch((err: Error) => this.host.warn(`could not release ${name}'s tasks: ${err.message}`));
	}

	// Resolves when the config.json and task-release writes queued so far are done.
	flush(): Promise<void> {
		return this.saving;
	}

	member(name: string): Member | undefined {
		return name === LEAD ? undefined : this.members.get(name);
	}

	// Teammates that are not stopped: running, queued, idle (and stopping until it is).
	live(): Member[] {
		return [...this.members.values()].filter((m) => m.name !== LEAD && m.status !== "stopped");
	}

	roster(): string[] {
		return [LEAD, ...[...this.members.keys()].filter((n) => n !== LEAD)];
	}

	addMember(name: string, agentId: string, agentType: string, status: MemberStatus): Member {
		const member: Member = { name, agentId, agentType, status, since: Date.now() };
		this.members.set(name, member);
		this.save();
		changed();
		return member;
	}

	private setStatus(name: string, status: MemberStatus): void {
		const m = this.members.get(name);
		if (!m || m.status === status) return;
		m.status = status;
		m.since = Date.now();
		// The request stays while the teammate wakes and runs; it ends when answered (below) or when it has stopped.
		if (status === "stopped") {
			delete m.shutdownRequested;
			this.releaseTasks(name); // a stopped member keeps no work: its in_progress tasks go back to pending
			this.userQueue.delete(name);
		}
		this.save();
		changed();
	}

	// The lead asks a teammate to shut down: the teammate's response needs this mark.
	// Returns what was marked before, for `restoreShutdownRequested` when the request could not be sent.
	markShutdownRequested(name: string): number | undefined {
		const m = this.members.get(name);
		if (!m) return undefined;
		const before = m.shutdownRequested;
		m.shutdownRequested = Date.now();
		this.save();
		return before;
	}

	restoreShutdownRequested(name: string, before: number | undefined): void {
		const m = this.members.get(name);
		if (!m) return;
		if (before === undefined) delete m.shutdownRequested;
		else m.shutdownRequested = before;
		this.save();
	}

	// --- the deliverer

	start(): void {
		try {
			// Only a mailbox changing matters. Taking one writes lock files and temporary files in this very directory: reacting
			// to those made every pass cause the next (inotify reports each create and remove at once; found on Linux, where
			// it spun at full speed). A rename onto `<name>.json` is the change.
			this.watcher = watch(join(this.dir, "inboxes"), { persistent: false }, (_event, name) => {
				if (typeof name === "string") {
					if (name.startsWith(".") || !name.endsWith(".json")) return;
					// A mailbox a pass rewrote itself is not news: reacting would let passes chain on their own writes. If
					// something else wrote it in that moment, the poll finds it within a second.
					const wrote = this.selfWrites.get(name);
					if (wrote !== undefined && Date.now() - wrote < SELF_WRITE_MS) return;
				}
				// Events come in bursts (a write is a create and a rename): one pass for the burst. Whatever writes
				// without being noted above still cannot make passes run faster than this.
				if (this.kickTimer) return;
				this.kickTimer = setTimeout(() => {
					this.kickTimer = undefined;
					this.kick();
				}, WATCH_DEBOUNCE_MS);
				this.kickTimer.unref();
			});
			this.watcher.on("error", () => {}); // the poll below still runs
		} catch {
			// no watch here (a limit was reached): the poll alone delivers, a second later
		}
		this.timer = setInterval(() => this.kick(), POLL_MS);
		this.timer.unref();
	}

	// Ask for a pass over the mailboxes. Passes run one at a time; asking while one is waiting adds nothing.
	kick(): void {
		if (this.closing || this.queuedPass) return;
		this.queuedPass = true;
		void this.enqueue(async () => {
			this.queuedPass = false;
			await this.pass();
		});
	}

	// One pass now; resolves when it is done.
	deliverNow(): Promise<void> {
		return this.enqueue(() => this.pass());
	}

	private enqueue<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.chain.then(fn, fn);
		this.chain = run.catch((err: Error) => this.host.warn(`team ${this.label}: ${err.message}`));
		return run;
	}

	// One pass over the lead's mailbox and each teammate's. Awaits no exchange: a pass that waited for one could not
	// let that exchange end.
	private async pass(): Promise<void> {
		if (this.closing) return;
		this.passCount++;
		await this.drainLead();
		for (const m of [...this.members.values()])
			if (m.name !== LEAD) {
				this.flushUser(m);
				await this.drainTeammate(m);
			}
		await this.drainStrays();
	}

	private drop(inbox: string, dropped: string[]): void {
		for (const reason of dropped) this.host.warn(`team ${this.label}: dropped from ${inbox}'s mailbox: ${reason}`);
	}

	private async drainLead(): Promise<void> {
		const file = inboxFile(this.dir, LEAD);
		const { taken, dropped } = await this.take(LEAD, file);
		this.drop(LEAD, dropped);
		if (taken.length === 0) return;
		for (const e of taken) if (e.kind === "shutdown_response") this.shutdownResponse(e);
		this.host.toLead(joinEnvelopes(taken, this.name));
	}

	// A teammate answered the lead's shutdown request. With no request pending the answer is ignored.
	private shutdownResponse(e: InboxEntry): void {
		const m = this.members.get(e.from);
		if (!m || m.shutdownRequested === undefined) return;
		if (e.approve === true) {
			this.approved.add(m.name);
			this.setStatus(m.name, "stopping");
		} else {
			delete m.shutdownRequested;
			this.save();
		}
	}

	private async drainTeammate(m: Member): Promise<void> {
		const file = inboxFile(this.dir, m.name);
		if (!existsSync(file)) return;
		switch (m.status) {
			case "stopping":
				return; // it is going away: what comes is dropped once it has stopped
			case "stopped": {
				const { taken, dropped } = await this.take(m.name, file);
				this.drop(m.name, dropped);
				for (const e of taken)
					this.host.warn(
						`team ${this.label}: dropped a message from ${e.from} to ${m.name}: ${m.name} is stopped`,
					);
				return;
			}
			case "running":
				return this.steer(m, file);
			case "queued": {
				const wake = this.pending.get(m.name);
				if (!wake) return; // its first start: the entries wait until it runs
				const { taken, dropped } = await this.take(m.name, file);
				this.drop(m.name, dropped);
				wake.entries.push(...taken);
				return;
			}
			case "idle":
				return this.wake(m, file);
		}
	}

	// takeEntries, noting that this pass rewrote the mailbox.
	private async take(name: string, file: string, select?: (e: InboxEntry) => boolean) {
		const result = await takeEntries(file, select);
		if (result.taken.length > 0 || result.dropped.length > 0) this.selfWrites.set(`${name}.json`, Date.now());
		return result;
	}

	private async steer(m: Member, file: string): Promise<void> {
		// Its child refused a steer (it settled and is on its way out): the messages wait for its next exchange, which
		// takes them. Taking them again would only put them back.
		const handle = registry.handle(m.agentId);
		if (!handle) return; // its child is not up yet, or just gone: the next pass, or its next exchange
		// (a restarted run attaches a new child to the same exchange: that one is asked again)
		if (this.steerRefused.get(m.name) === handle) return;
		const { taken, dropped } = await this.take(m.name, file);
		this.drop(m.name, dropped);
		if (taken.length === 0) return;
		if (taken.some((e) => e.from === LEAD)) this.wakes.delete(m.name);
		const text = joinEnvelopes(taken, this.name);
		if (!handle.send({ type: "steer", message: text })) {
			this.steerRefused.set(m.name, handle);
			this.selfWrites.set(`${m.name}.json`, Date.now());
			await putBack(file, taken); // the child settled meanwhile: its next exchange takes them
			return;
		}
		this.steers.set(m.name, [...(this.steers.get(m.name) ?? []), { entries: taken, text, taken: false }]);
	}

	private async wake(m: Member, file: string): Promise<void> {
		const waiting = peekEntries(file);
		if (waiting.length === 0) {
			// nothing valid; bad entries, if any, are dropped
			this.drop(m.name, (await takeEntries(file, () => false)).dropped);
			return;
		}
		const fromLead = waiting.some((e) => e.from === LEAD);
		if (!fromLead && (this.wakes.get(m.name) ?? 0) >= MAX_WAKES) {
			await this.hold(m, waiting);
			return;
		}
		const { taken, dropped } = await this.take(m.name, file);
		this.drop(m.name, dropped);
		if (taken.length === 0) return;
		if (taken.some((e) => e.from === LEAD)) this.wakes.set(m.name, 0);
		else this.wakes.set(m.name, (this.wakes.get(m.name) ?? 0) + 1);
		this.held.delete(m.name);
		this.startWake(m, { entries: taken, user: [] });
	}

	// A new exchange for an idle teammate with this prompt material.
	private startWake(m: Member, wake: PendingWake): void {
		this.pending.set(m.name, wake);
		this.setStatus(m.name, "queued");
		const controller = new AbortController(); // the user's `x` on this wait
		this.wakeControllers.set(m.name, controller);
		this.host
			.wake(
				m,
				() => wake.text ?? this.wakePrompt(wake),
				AbortSignal.any([this.wakeSignal.signal, controller.signal]),
			)
			.catch((err: Error) => {
				// It failed before its exchange began (an exchange that began handles its own end): the messages were not taken
				// by anyone. They are dropped, loudly, because a mailbox that kept them would try again every second.
				if (this.pending.get(m.name) === wake) this.wakeFailed(m.name, err);
			})
			.finally(() => {
				if (this.wakeControllers.get(m.name) === controller) this.wakeControllers.delete(m.name);
			});
	}

	// What the user typed comes first, as typed (it carries the user's authority); agent messages follow in envelopes.
	private wakePrompt(wake: PendingWake): string {
		return [...wake.user, ...(wake.entries.length > 0 ? [joinEnvelopes(wake.entries, this.name)] : [])].join("\n\n");
	}

	// --- the user (the teammate's screen): never through a mailbox file

	// The user typed `text` to a teammate: a steer while it runs, a new exchange when it is idle. It is the user's own
	// words, so it resets the loop count. Throws when the teammate takes nothing (stopped, stopping).
	say(name: string, text: string): Delivery {
		const m = this.member(name);
		if (!m) throw new Error(`no teammate "${name}"`);
		if (this.closing || m.status === "stopping" || m.status === "stopped")
			throw new Error(`${name} is ${this.closing ? "closing" : m.status}: it takes no messages`);
		this.wakes.delete(name);
		if (m.status === "idle") {
			this.held.delete(name);
			this.startWake(m, { entries: [], user: [text] });
			return "started";
		}
		if (m.status === "queued") {
			const wake = this.pending.get(name);
			if (wake && wake.text === undefined)
				wake.user.push(text); // its exchange has not begun: the text joins it
			else this.queueUser(name, text); // its first start: the text waits until it runs
			return "queued";
		}
		const handle = registry.handle(m.agentId);
		if (handle && this.steerRefused.get(name) !== handle && this.steerUser(m, text)) return "steered";
		this.queueUser(name, text); // its child is not up yet, or settling: the next pass, or its next exchange
		return "queued";
	}

	private queueUser(name: string, text: string): void {
		this.userQueue.set(name, [...(this.userQueue.get(name) ?? []), text]);
		this.kick();
	}

	private steerUser(m: Member, text: string): boolean {
		if (!registry.handle(m.agentId)?.send({ type: "steer", message: text })) return false;
		this.steers.set(m.name, [...(this.steers.get(m.name) ?? []), { entries: [], user: text, text, taken: false }]);
		return true;
	}

	// Texts the user typed before the child could take them: steered once it is up.
	private flushUser(m: Member): void {
		const queue = this.userQueue.get(m.name);
		if (!queue || queue.length === 0 || m.status !== "running") return;
		const handle = registry.handle(m.agentId);
		if (!handle || this.steerRefused.get(m.name) === handle) return;
		this.userQueue.delete(m.name);
		const rest = [...queue];
		while (rest.length > 0) {
			if (!this.steerUser(m, rest[0]!)) {
				this.steerRefused.set(m.name, handle);
				this.userQueue.set(m.name, rest);
				return;
			}
			rest.shift();
		}
	}

	// A new exchange for what the user typed that nobody took (its child settled first).
	private startQueuedUser(name: string): void {
		const m = this.members.get(name);
		const texts = this.userQueue.get(name);
		if (!m || m.status !== "idle" || !texts || texts.length === 0 || this.closing) return;
		this.userQueue.delete(name);
		this.startWake(m, { entries: [], user: texts });
	}

	// Stop a teammate in any state (the user's `x`), with no process needed for an idle or queued one. Returns false when
	// there is nothing to stop (already stopping or stopped, unknown) or a running child cannot be reached yet.
	stop(name: string): boolean {
		const m = this.member(name);
		if (!m || this.closing || m.status === "stopped" || m.status === "stopping") return false;
		this.userQueue.delete(name);
		switch (m.status) {
			case "running":
				if (!registry.stop(m.agentId)) return false;
				this.setStatus(name, "stopping"); // it ends stopped (exchangeEnded)
				return true;
			case "queued": {
				// Waiting for its turn or a slot: aborting its signal ends the wait; exchangeAbandoned makes it stopped.
				const controller = this.wakeControllers.get(name);
				this.userStops.add(name);
				if (controller) controller.abort();
				else registry.abortQueued([m.agentId]); // its first start
				return true;
			}
			case "idle":
				this.pending.delete(name);
				this.held.delete(name);
				this.setStatus(name, "stopped");
				registry.markStopped(m.agentId);
				this.host.toLead(`Teammate "${name}" was stopped.`);
				return true;
		}
	}

	// The user's Esc on a running teammate's screen: its turn ends, it stays a member and becomes idle (exchangeEnded).
	interrupt(name: string): boolean {
		const m = this.member(name);
		if (!m || m.status !== "running") return false;
		return registry.interrupt(m.agentId);
	}

	// An idle teammate that woke 5 times in a row on other teammates' messages waits; the lead is told once.
	private async hold(m: Member, waiting: InboxEntry[]): Promise<void> {
		const senders = [...new Set(waiting.map((e) => e.from))].sort();
		const key = senders.join(",");
		if (this.held.get(m.name) === key) return;
		this.held.set(m.name, key);
		await appendEntry(inboxFile(this.dir, LEAD), {
			id: newEntryId(),
			from: m.name,
			to: LEAD,
			text: heldText(m.name, senders),
			kind: "held",
			at: Date.now(),
		});
		this.kick();
	}

	// A mailbox of no member (a file left by a name that is gone): dropped with a warning.
	private async drainStrays(): Promise<void> {
		const dir = join(this.dir, "inboxes");
		let files: string[];
		try {
			files = readdirSync(dir);
		} catch {
			return;
		}
		for (const f of files) {
			if (f.startsWith(".") || !f.endsWith(".json")) continue;
			const name = basename(f, ".json");
			if (name === LEAD || this.members.has(name)) continue;
			const { taken, dropped } = await takeEntries(join(dir, f));
			this.drop(name, dropped);
			for (const e of taken)
				this.host.warn(`team ${this.label}: dropped a message from ${e.from} to ${name}: no such member`);
		}
	}

	// --- the life of an exchange (exchange.ts calls these)

	// An exchange for this teammate is waiting for its turn and a slot.
	exchangeQueued(name: string): void {
		if (!this.closing && this.members.get(name)?.status !== "stopping") this.setStatus(name, "queued");
	}

	// Its child is about to start.
	exchangeBegan(name: string): void {
		this.exchanges.set(name, (this.exchanges.get(name) ?? 0) + 1);
		this.userStops.delete(name); // a stop that came too late to end the wait
		this.steerRefused.delete(name);
		const m = this.members.get(name);
		if (!m) return;
		const wake = this.pending.get(name);
		if (wake) {
			wake.text = this.wakePrompt(wake); // the prompt is fixed from here
			this.pending.delete(name);
		}
		if (!this.closing && m.status !== "stopping") this.setStatus(name, "running");
		this.unwatch.get(name)?.();
		this.steers.delete(name);
		this.unwatch.set(
			name,
			registry.watch(m.agentId, (event) => {
				const message = event.message as { role?: string; content?: unknown } | undefined;
				if (event.type !== "message_end" || message?.role !== "user") return;
				const text = messageText(message).trim();
				for (const s of this.steers.get(name) ?? []) if (s.text.trim() === text) s.taken = true;
			}),
		);
		this.kick();
	}

	// A wake that failed before its child started (the agent type is gone, a worktree could not be made): the teammate is
	// idle as before, since a failed exchange leaves it live. The messages were taken by nobody; they are dropped, loudly,
	// because a mailbox that kept them would try again every second.
	private wakeFailed(name: string, err: Error): void {
		const wake = this.pending.get(name);
		this.pending.delete(name);
		if (this.closing) return;
		if (this.userStops.delete(name)) {
			this.stoppedWhileQueued(name);
			return;
		}
		if (this.members.get(name)?.status === "queued") this.setStatus(name, "idle");
		const why = `could not wake ${name}: ${err.message}; ${wake?.entries.length ?? 0} message(s) dropped`;
		this.host.warn(`team ${this.label}: ${why}`);
		this.host.toLead(`Team ${this.label}: ${why}`);
	}

	// The user stopped a teammate whose exchange was waiting: it ends stopped, with no warning (it is what they asked).
	private stoppedWhileQueued(name: string): void {
		const m = this.members.get(name);
		if (!m || m.status === "stopped") return;
		this.setStatus(name, "stopped");
		const id = m.agentId;
		if (registry.get(id)) registry.markStopped(id);
		this.host.toLead(`Teammate "${name}" was stopped.`);
	}

	// The exchange did not begin: it was aborted while it waited for its turn or a slot, or it could not start. A teammate
	// that never ran is stopped; one that was woken stays idle, with a warning.
	exchangeAbandoned(name: string, err: Error): void {
		if (this.pending.has(name)) {
			this.wakeFailed(name, err);
			return;
		}
		if (this.closing) return;
		if (this.userStops.delete(name)) {
			this.stoppedWhileQueued(name);
			return;
		}
		const m = this.members.get(name);
		if (m?.status === "queued" && registry.get(m.agentId)) {
			// it has run before (the user continued it, say): a failed exchange leaves it idle
			this.setStatus(name, "idle");
			this.host.warn(`team ${this.label}: could not continue ${name}: ${err.message}`);
		} else this.setStatus(name, "stopped");
	}

	// The exchange ended. Decides what the teammate is now: `stopped` after an approved shutdown, a stop, or the session's
	// end; else `idle` (a failed exchange too), and the lead gets one idle notice. Messages a steer did not reach go back to
	// the mailbox, so the next exchange takes them.
	async exchangeEnded(
		name: string,
		outcome: { run?: RunResult; aborted?: boolean; userStopped?: boolean; interrupted?: boolean },
	): Promise<Verdict> {
		this.unwatch.get(name)?.();
		this.unwatch.delete(name);
		this.steerRefused.delete(name);
		const m = this.members.get(name);
		const notTaken = (this.steers.get(name) ?? []).filter((s) => !s.taken);
		const untaken = notTaken.flatMap((s) => s.entries);
		const untakenUser = notTaken.flatMap((s) => (s.user === undefined ? [] : [s.user]));
		this.steers.delete(name);
		if (this.closing || !m) return "stopped";
		// A shutdown response may still be in the lead's mailbox: read it before deciding, so an approved shutdown is never
		// taken for a failure.
		await this.enqueue(() => this.drainLead());
		this.steerRefused.delete(name);
		if (this.closing) return "stopped";
		if (this.approved.delete(name)) {
			this.setStatus(name, "stopped");
			return "stopped";
		}
		if (outcome.userStopped || outcome.aborted || m.status === "stopped") {
			this.setStatus(name, "stopped");
			this.host.toLead(`Teammate "${name}" was stopped.`);
			return "stopped";
		}
		if (untaken.length > 0) await putBack(inboxFile(this.dir, name), untaken);
		// Only now: while the end was being decided a pass must not steer them into the child that has settled.
		if (untakenUser.length > 0) this.userQueue.set(name, [...untakenUser, ...(this.userQueue.get(name) ?? [])]);
		this.setStatus(name, "idle");
		// The user's Esc: no idle notice and no teammate_idle (a hook could wake it again at once). It is still woken by messages.
		if (outcome.run && !outcome.interrupted) await this.idleNotice(name, outcome.run);
		this.startQueuedUser(name);
		this.kick();
		return "idle";
	}

	// The teammate_idle event, then (unless a hook blocked) the lead's idle notice. A hook that blocks sends its feedback
	// to the teammate instead, so it keeps working: at most MAX_IDLE_BLOCKS times in a row, then the notice goes whatever
	// the hooks say. A hook that `hold`s is waited for in the background: the exchange must not keep its slot meanwhile.
	private async idleNotice(name: string, run: RunResult): Promise<void> {
		const m = this.members.get(name);
		if (!m) return;
		const capped = (this.idleBlocks.get(name) ?? 0) >= MAX_IDLE_BLOCKS;
		const payload = {
			team: this.name,
			name,
			agentId: m.agentId,
			...(run.status === "failed" ? { error: run.error ?? "no error given" } : { result: run.output }),
		};
		const hooks = {
			bus: this.host.events,
			warn: (msg: string) => this.host.warn(msg),
			holdTimeoutMs: this.host.holdTimeoutMs,
			backgroundHold: true, // nobody waits on this hold: it must not keep the process alive
		};
		const seq = this.exchanges.get(name) ?? 0;
		const decided = emitHook(hooks, "teammate_idle", payload, capped);
		if (decided.sync) return this.finishIdle(name, run, decided.sync, seq);
		void decided.later
			.then((verdict) => (this.closing ? undefined : this.finishIdle(name, run, verdict, seq)))
			.catch((err: Error) => this.host.warn(`team ${this.label}: ${err.message}`));
	}

	private async finishIdle(name: string, run: RunResult, verdict: HookVerdict, seq: number): Promise<void> {
		const m = this.members.get(name);
		// The verdict is for the exchange that ended. If the teammate went away, or was woken (a new exchange began or is
		// queued) while a hold decided, it is stale: neither the old notice nor feedback for a turn that is over.
		if (!m || m.status !== "idle" || (this.exchanges.get(name) ?? 0) !== seq) return;
		if (verdict.blocked) {
			this.idleBlocks.set(name, (this.idleBlocks.get(name) ?? 0) + 1);
			await appendEntry(inboxFile(this.dir, name), {
				id: newEntryId(),
				from: LEAD,
				to: name,
				text: verdict.feedback,
				summary: "feedback from a teammate_idle hook",
				kind: "message",
				at: Date.now(),
			});
			this.kick();
			return;
		}
		this.idleBlocks.delete(name);
		const answer = capText(run.output, this.host.parent(), `${m.agentId}-output`);
		await appendEntry(inboxFile(this.dir, LEAD), {
			id: newEntryId(),
			from: name,
			to: LEAD,
			text: idleText(name, run, answer),
			kind: "idle",
			at: Date.now(),
		});
		this.kick();
	}

	// --- ending

	// Stop delivering. Running teammates are stopped by the caller (they are subagents), which then calls `finishClose`.
	beginClose(): void {
		this.closing = true;
		this.wakeSignal.abort();
		if (this.kickTimer) clearTimeout(this.kickTimer);
		this.kickTimer = undefined;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.watcher?.close();
		this.watcher = undefined;
		for (const off of this.unwatch.values()) off();
		this.unwatch.clear();
	}

	// Remove the team's files (config.json and the mailboxes). The tasks are not here, and stay.
	async finishClose(): Promise<void> {
		this.closing = true;
		await this.chain;
		await this.saving;
		rmSync(this.dir, { recursive: true, force: true });
	}
}

// The team directories of lead sessions that are gone (the process died before it could clean up).
export function sweepStaleTeams(root: string, keep: string, now = Date.now()): string[] {
	const removed: string[] = [];
	let names: string[];
	try {
		names = readdirSync(root);
	} catch {
		return removed;
	}
	for (const name of names) {
		if (name === keep) continue;
		const dir = join(root, name);
		let alive = false;
		try {
			const config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as Partial<TeamConfigFile>;
			alive = Number.isInteger(config.leadPid) && pidAlive(config.leadPid!);
		} catch {
			// no readable config: a team being created has one within moments; an older directory is debris
			try {
				alive = now - statSync(dir).mtimeMs < STRAY_CONFIG_GRACE_MS;
			} catch {
				continue;
			}
		}
		if (alive) continue;
		rmSync(dir, { recursive: true, force: true });
		removed.push(name);
	}
	return removed;
}

// The process's teams state: whether teams are on for this session, and its team once there is one.
class Teams {
	private host: TeamHost | undefined;
	private team: Team | undefined;

	// Called at session start (and after /reload) with the host, or undefined when teams are off.
	configure(host: TeamHost | undefined): void {
		this.host = host;
		this.team = undefined;
	}

	get on(): boolean {
		return this.host !== undefined;
	}

	get settings(): TeamSettings | undefined {
		return this.host?.settings;
	}

	current(): Team | undefined {
		return this.team;
	}

	// The session's team, created at the first teammate.
	ensure(): Team {
		if (!this.host) throw new Error("agent teams are off");
		if (this.team) return this.team;
		const parent = this.host.parent();
		const team = new Team(parent.sessionId, this.host);
		sweepStaleTeams(teamsRoot(), team.name);
		sweepTasks(join(dirname(teamsRoot()), "tasks"), team.name, this.host.settings.taskRetentionDays, teamsRoot());
		team.start();
		this.team = team;
		return team;
	}

	// How a current member is launched (a continue of an idle teammate); undefined when it is not a member.
	launch(name: string, frozenPrompt?: string): TeamLaunch | undefined {
		const team = this.team;
		if (!team?.member(name)) return undefined;
		return {
			team: team.name,
			dir: team.dir,
			member: name,
			roster: team.roster(),
			...(frozenPrompt !== undefined ? { prompt: frozenPrompt } : {}),
		};
	}

	// Session end: stop delivering, then (once the running teammates have been stopped) remove the files.
	beginClose(): void {
		this.team?.beginClose();
	}

	async finishClose(): Promise<void> {
		const team = this.team;
		this.team = undefined;
		await team?.finishClose();
	}
}

export const teams = new Teams();
