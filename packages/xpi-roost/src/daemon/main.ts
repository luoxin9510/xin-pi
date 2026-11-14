// The roost daemon: one per user and agent directory. It runs and keeps the sessions (each
// in a host process that holds its PTY) and answers the hub, the CLI and the sessions over
// a unix socket (JSON lines, docs/protocol.md). Started on demand by the first client
// (client.ts), with its agent directory, state and runtime directories and the host's
// entry in its environment.
import { spawn } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import type { Server, Socket } from "node:net";
import { createServer } from "node:net";
import { constants as osConstants } from "node:os";
import { isAbsolute, join } from "node:path";
import { deferDurability, durable, readJson, setSyncErrorHandler, writeJsonAtomic } from "../lib/atomic.ts";
import { allow, callerOf } from "../lib/callers.ts";
import { loadUserConfig } from "../lib/config.ts";
import { clipText, EventLog, type RoostEvent, stateMatters } from "../lib/events.ts";
import { hostControl } from "../lib/hostclient.ts";
import { JOB_ENV_NAMES, roostEnv } from "../lib/identity.ts";
import { newJobId, newToken } from "../lib/ids.ts";
import {
	acquireDaemonLock,
	acquireStateLock,
	readWriterLock,
	releaseDaemonLock,
	releaseStateLock,
} from "../lib/locks.ts";
import { OpError, str, taskText } from "../lib/op.ts";
import { followedParent, pidAlive } from "../lib/orphans.ts";
import {
	daemonLogPath,
	daemonSocketPath,
	ensureDirs,
	envAgentDir,
	jobDir as jobDirOf,
	roostHome,
	rosterPath,
	runtimeDir,
} from "../lib/paths.ts";
import { isAlive, parentPid, processStartTokenAsync, sameProcess } from "../lib/proc.ts";
import {
	contextFrom,
	DAEMON_CAPABILITIES,
	type DaemonStatus,
	type DispatchArgs,
	type Event,
	encodeLine,
	type HelloResult,
	type JobRow,
	type JobStateName,
	LineReader,
	PROTOCOL_VERSION,
	type WorkerReport,
} from "../lib/protocol.ts";
import { argsProblem } from "../lib/protocol-schema.ts";
import { createSchedules, type ScheduleRun } from "../lib/schedules.ts";
import {
	clearExit,
	clearWorker,
	createJob,
	type JobRecord,
	type JobState,
	listJobIds,
	readExit,
	readJob,
	readState,
	readWorkerPid,
	removeJob,
	respawnCommand,
	screenPath,
	stateFile,
	updateState,
} from "../lib/store.ts";
import { usageFrom } from "../lib/usage.ts";
import { ROOST_BUILD, ROOST_VERSION } from "../lib/version.ts";

/** How long a stop waits for a host to go before it is killed (ROOST_STOP_WAIT_MS: tests shorten it). */
const WAIT_MS = Number(roostEnv("STOP_WAIT_MS")) || 6000;
const CONTINUE = "Continue where you left off.";
/**
 * DM-5: automatic restarts of a session whose agent process crashed mid-run, in a row, and
 * the pause before each (ROOST_RESUME_DELAYS_MS="1000,5000,15000" changes them; tests
 * shorten them).
 */
const RESUME_DELAYS_MS = (roostEnv("RESUME_DELAYS_MS") ?? "1000,5000,15000")
	.split(",")
	.map(Number)
	.filter((n) => Number.isFinite(n) && n >= 0);
/** DM-7: a run that last made progress within this long ago ended by surprise. */
const RECENT_MS = 48 * 60 * 60 * 1000;
const REAP_CHECK_MS = 30_000;
const CRASH_RESET_MS = 60_000;
/** DI-6: a finished shell job's row stays this long. */
const SHELL_KEEP_MS = Number(roostEnv("SHELL_KEEP_MS")) || 5 * 60_000;

// M35: durable writes are synced in groups, off the loop; answers wait for them (onLine)
deferDurability(true);
setSyncErrorHandler((err) => log("error", "sync failed", { error: String(err) }));

function log(level: "info" | "warn" | "error", msg: string, extra: Record<string, unknown> = {}): void {
	try {
		appendFileSync(daemonLogPath(), `${JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra })}\n`);
	} catch {}
}

process.on("uncaughtException", (err) => log("error", "uncaughtException", { error: String(err?.stack ?? err) }));
process.on("unhandledRejection", (err) => log("error", "unhandledRejection", { error: String(err) }));
process.on("SIGPIPE", () => {});

ensureDirs();
const lock = acquireDaemonLock({ version: ROOST_VERSION, socket: daemonSocketPath() });
if (!lock.ok) process.exit(0);
// one daemon per state directory, whatever its runtime directory (XDG_RUNTIME_DIR set or not)
const stateLock = acquireStateLock({ version: ROOST_VERSION, runtimeDir: runtimeDir() });
if (!stateLock.ok) {
	const message = `a daemon for this agent directory already runs with another runtime directory (${String(stateLock.holder.runtimeDir ?? "unknown")}, pid ${stateLock.holder.pid})`;
	log("error", "state locked", { holder: stateLock.holder });
	console.error(message);
	releaseDaemonLock();
	process.exit(1);
}

const startedAt = Date.now();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Decision 9: the daemon reads the "roost" section of `<agent dir>/settings.json` itself. */
const settings = () => loadUserConfig(envAgentDir());

// Whether node-pty loads here (its native part): status says so, and nothing is started without it.
let ptyError: string | null = null;
try {
	createRequire(import.meta.url)("node-pty");
} catch (err) {
	ptyError = String((err as Error)?.message ?? err);
}

interface HostRef {
	hostPid: number;
	hostToken: string; // "" until the start token could be read
	/** M35: when the pid was last checked to still be this host (in memory only). */
	verifiedAt?: number;
}

/** M35: a live pid is checked to be its host again (one ps) at most this often. */
const HOST_VERIFY_MS = 30_000;

const recs = new Map<string, JobRecord>();
const roster = new Map<string, HostRef>();
const starting = new Set<string>();
const stopping = new Set<string>();
/** DM-4: being stopped for idleness; the row keeps its state. */
const reaping = new Set<string>();
const respawning = new Set<string>();
const conns = new Set<Conn>();
/**
 * M49: the socket's bounds. A request line is at most LINE_MAX_REQUEST characters (a longer
 * one is not a message: the connection ends); at most CONNS_MAX connections are open; a
 * connection with INFLIGHT_MAX requests unanswered is not read until some are; a client
 * that leaves SEND_BACKLOG_MAX bytes unread (a subscriber that stopped reading) is dropped.
 */
const LINE_MAX_REQUEST = 4 * 1024 * 1024;
const CONNS_MAX = 1024;
const INFLIGHT_MAX = 256;
const SEND_BACKLOG_MAX = 16 * 1024 * 1024;
/** The connection each live worker reports on; replies are pushed down it. */
const workerConns = new Map<string, Conn>();

interface Conn {
	sock: Socket;
	subscribed: boolean;
	/** The job whose report this connection sent (a Session, lib/callers.ts). */
	peer?: { id: string };
	/** M31: what the agent on this connection said in its hello. */
	hello?: { name: string; version: string | null; build?: string; capabilities: string[] };
	/** M47: an agent's connection (it said hello or reported): never the hub's, even before its peer is set. */
	agentSide?: boolean;
	/** M49: requests being handled, and lines waiting their turn (the socket is paused while INFLIGHT_MAX are). */
	inflight: number;
	backlog: string[];
	head: number;
	paused?: boolean;
}

/** M9: jobs being removed. */
const removing = new Set<string>();

// ---- M43: the event feed ---------------------------------------------------------------

/** What happened, for the hub's log and `xpi roost log`; in roostHome. */
const eventLog = new EventLog(join(roostHome(), "events.jsonl"), { warn: (msg) => log("warn", msg) });

function record(e: Omit<RoostEvent, "seq" | "at">): void {
	eventLog.append(e);
}

/** The state each job was last seen in: a change into one that matters is recorded. */
const lastSeen = new Map<string, { state: JobStateName; waitingFor: JobRow["waitingFor"]; question: string | null }>();

/** A job's row went out: a state change that matters is an event. */
function noteState(job: JobRow): void {
	// spec 03: the old process ending for a restart is not news (the host's exit shows as stopped meanwhile)
	if (job.restarting) return;
	const prev = lastSeen.get(job.id);
	lastSeen.set(job.id, { state: job.state, waitingFor: job.waitingFor, question: job.question });
	if (!prev) return;
	// what a blocked session waits for changing (a question, then a dialog) matters; a row
	// going quiet (no worker: waitingFor null) or being restored is not a change
	const waits =
		job.state === "blocked" &&
		prev.state === "blocked" &&
		!!prev.waitingFor &&
		!!job.waitingFor &&
		prev.waitingFor !== job.waitingFor;
	if (prev.state === job.state && !waits) return;
	if (stateMatters(prev.state, job.state) || job.state === "blocked") {
		const text =
			job.state === "blocked"
				? job.question
				: job.state === "failed"
					? job.error
					: job.state === "done"
						? job.summary
						: null;
		record({
			kind: "state",
			id: job.id,
			name: job.name,
			state: job.state,
			from: prev.state,
			waitingFor: job.waitingFor,
			text: clipText(text),
		});
	}
}

function persistRoster(): void {
	const obj: Record<string, HostRef> = {};
	for (const [id, ref] of roster) obj[id] = { hostPid: ref.hostPid, hostToken: ref.hostToken };
	try {
		writeJsonAtomic(rosterPath(), obj);
	} catch (err) {
		log("error", "roster write failed", { error: String(err) });
	}
}

function hostGone(ref: HostRef): boolean {
	if (!isAlive(ref.hostPid)) return true;
	if (!ref.hostToken) return false;
	// M35: a ps per job on every check blocked the daemon (50 jobs: 50 ps in a row); a
	// live pid is its host unless a recheck says otherwise (pid reuse is a rare, slow event)
	const now = Date.now();
	if (ref.verifiedAt !== undefined && now - ref.verifiedAt < HOST_VERIFY_MS) return false;
	const same = sameProcess(ref.hostPid, ref.hostToken);
	if (same) ref.verifiedAt = now;
	return !same;
}

// the worker pid each live row was last pushed with: a command that prints nothing, or an
// xpi whose first report is late, still has to show (and attach) once its host is up
const shellPids = new Map<string, number | null>();

/** M48: the task a job was started on, for its row: the argument after `--`, or the command itself. */
function rowTask(rec: JobRecord): string | null {
	const i = rec.command.indexOf("--");
	const text =
		i >= 0 && str(rec.command[i + 1]) ? rec.command[i + 1]! : rec.kind === "shell" ? rec.command.join(" ") : "";
	const line = clipText(text);
	return line ? (line.length > 200 ? `${line.slice(0, 199)}…` : line) : null;
}

function rowOf(id: string): JobRow | undefined {
	const rec = recs.get(id);
	const st = readState(id);
	if (!rec || !st) return undefined;
	const live = roster.has(id);
	// M22: shown as the job that took the session (while that one is there)
	if (!live && hidden(st)) return undefined;
	const text = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);
	const caps = agentCaps(st);
	return {
		id,
		cwd: rec.cwd,
		kind: rec.kind ?? "pi",
		startedAt: st.startedAt,
		state: st.state,
		pid: live ? (readWorkerPid(id) ?? null) : null,
		// status and waitingFor describe a live worker only (PRD §6.8)
		status: live ? ((st.status as JobRow["status"]) ?? null) : null,
		waitingFor: live ? ((st.waitingFor as JobRow["waitingFor"]) ?? null) : null,
		sessionFile: rec.sessionFile,
		name: text(st.displayName) ?? rec.name,
		endedAt: st.endedAt ?? null,
		summary: text(st.summary),
		question: text(st.question),
		choices: Array.isArray(st.choices) ? st.choices.filter((c): c is string => typeof c === "string") : [],
		model: text(st.model) ?? rec.model ?? null,
		thinking: text(st.thinking) ?? rec.thinking ?? null,
		context: rec.kind === "shell" ? null : contextFrom(st.context),
		usage: rec.kind === "shell" ? null : usageFrom(st.usage),
		error: text(st.error),
		stateSince: typeof st.stateSince === "number" ? st.stateSince : (st.endedAt ?? st.startedAt),
		reaped: !live && st.reaped === true,
		pinned: st.pinned === true,
		order: typeof st.order === "number" ? st.order : null,
		orderKey: typeof st.orderKey === "string" ? st.orderKey : null,
		...(caps ? { capabilities: caps } : {}),
		...(st.restarting === true ? { restarting: true } : {}),
		// spec 03: the build its process runs; a session that is not running has none
		...(live && agentBuild(st) ? { build: agentBuild(st) } : {}),
		// M48: the task it was started on, and the user replies waiting for it (the peek shows both)
		task: rowTask(rec),
		queued: pendingReplies(id).length,
		schedule: rec.schedule ?? null,
	};
}

/** M31: the capabilities a job's agent said it has, from state.json. */
function agentCaps(st: JobState): string[] | undefined {
	const c = (st.agentInfo as { capabilities?: unknown } | undefined)?.capabilities;
	return Array.isArray(c) ? c.filter(str) : undefined;
}

/** Spec 03: the build a job's agent said it runs, from state.json (set when its connection is bound). */
function agentBuild(st: JobState): string | undefined {
	const b = (st.agentInfo as { build?: unknown } | undefined)?.build;
	return typeof b === "string" && b ? b : undefined;
}

function send(conn: Conn, value: unknown): void {
	if (conn.sock.destroyed) return;
	// M49: a client that stopped reading (a subscriber gone deaf) is not buffered for without end
	if (conn.sock.writableLength > SEND_BACKLOG_MAX) {
		log("warn", "client stopped reading: dropped", {
			peer: conn.peer?.id ?? null,
			subscribed: conn.subscribed,
			unread: conn.sock.writableLength,
		});
		conn.sock.destroy();
		return;
	}
	conn.sock.write(encodeLine(value));
}

function push(event: Event): void {
	for (const c of conns) if (c.subscribed) send(c, event);
}

function pushJob(id: string): void {
	const job = rowOf(id);
	if (!job) return;
	push({ event: "job", job });
	noteState(job);
}

/** rm: stop the job, then drop its records. */
async function removeRecord(id: string): Promise<{ id: string }> {
	// DM-5: a crash restart waiting is called off
	cancelResume(id);
	if (roster.has(id)) {
		removing.add(id);
		await terminateHost(id);
		if (!(await waitGone([id], WAIT_MS))) {
			killHost(id, "rm");
			await waitGone([id], 2000);
			if (roster.has(id)) finalize(id, "killed by rm");
		}
	}
	const name = rowOf(id)?.name ?? recs.get(id)?.name ?? id;
	record({ kind: "removed", id, name });
	lastSeen.delete(id);
	recs.delete(id);
	shellPids.delete(id);
	stopping.delete(id);
	removing.delete(id);
	removeJob(id);
	log("info", "rm", { id });
	push({ event: "removed", id });
	return { id };
}

const DAY_MS = 24 * 60 * 60 * 1000;
let lastCleanup = 0;

/*
 * M15 (Claude Code's cleanupPeriodDays): remove records of sessions that ended more than
 * cleanupDays ago. The session files stay (xpi's /resume lists them). Kept: pinned ones,
 * ones waiting for an answer, and ones with replies waiting.
 */
let cleaning = false;

/** Whether a record may go now (asked again after every await: anything may have changed). */
function cleanable(id: string, days: number, now: number): boolean {
	const rec = recs.get(id);
	// a command's row expires by itself (DI-6)
	if (
		!rec ||
		rec.kind === "shell" ||
		roster.has(id) ||
		starting.has(id) ||
		respawning.has(id) ||
		stopping.has(id) ||
		removing.has(id)
	)
		return false;
	const st = readState(id);
	if (!st || typeof st.endedAt !== "number" || now - st.endedAt < days * DAY_MS) return false;
	if (typeof st.resumeAt === "number") return false;
	return !(st.pinned === true || st.state === "blocked" || pendingReplies(id).length > 0);
}

async function cleanupOld(): Promise<void> {
	const days = Number(roostEnv("CLEANUP_DAYS") ?? settings().cleanupDays);
	if (!(days > 0) || cleaning) return;
	const now = Date.now();
	if (now - lastCleanup < (Number(roostEnv("CLEANUP_CHECK_MS")) || 60 * 60 * 1000)) return;
	cleaning = true;
	lastCleanup = now;
	try {
		for (const id of [...recs.keys()]) {
			if (!cleanable(id, days, Date.now())) continue;
			const st = readState(id);
			log("info", "cleanup", { id, endedDaysAgo: Math.floor((Date.now() - Number(st?.endedAt)) / DAY_MS) });
			await removeRecord(id).catch((err: unknown) => log("warn", "cleanup failed", { id, error: String(err) }));
		}
	} finally {
		cleaning = false;
	}
}

function finalize(id: string, why: string, opts: { startup?: boolean } = {}): void {
	roster.delete(id);
	workerConns.delete(id);
	starting.delete(id);
	const st = readState(id);
	if (!st) {
		reaping.delete(id);
		persistRoster();
		return;
	}
	const ex = readExit(id);
	const reaped = reaping.has(id);
	reaping.delete(id);
	const stopReq = !reaped && (stopping.has(id) || st.stopRequested === true);
	const now = Date.now();
	const patch: Partial<JobState> = { endedAt: now, status: null, waitingFor: null, tool: null };
	patch.stateSince = now;
	let restart = false;
	if (recs.get(id)?.kind === "shell") {
		// DI-6: stopped, or the command's exit status; the row goes away a while later
		if (stopReq) patch.state = "stopped";
		else {
			patch.state = ex && !crashed(ex) ? "done" : "failed";
			if (patch.state === "failed") patch.error = ex ? exitText(ex, "exited") : "host vanished";
		}
		patch.removeAt = now + SHELL_KEEP_MS;
		// the host flushed its screen on exit: the last output line is the result
		const line = lastScreenLine(id);
		if (line) patch.summary = line;
	} else if (reaped) {
		// DM-4: an idle worker stopped to save resources; the row stays as it was
		patch.state = st.state === "working" ? "done" : st.state;
		patch.reaped = true;
		patch.stateSince = typeof st.stateSince === "number" ? st.stateSince : now;
	} else if (stopReq) {
		patch.state = "stopped";
	} else if (!ex && opts.startup) {
		// DM-7: the machine or the daemon went away under a live worker: the session ends
		if (st.state !== "working")
			patch.state = st.state === "blocked" && st.waitingFor !== "question" ? "done" : st.state;
		else {
			const progress = typeof st.reportedAt === "number" ? st.reportedAt : st.updatedAt;
			if (now - progress < RECENT_MS) {
				patch.state = "failed";
				patch.error =
					"the session ended while it was working (machine restart?); reply or press Enter twice to resume";
			} else {
				patch.state = "stopped";
				patch.error = "ended while the background service was off";
			}
		}
	} else if (!ex) {
		// its host is gone (killed, out of memory): the session ends
		patch.state = "failed";
		patch.error = "host vanished";
	} else if (crashed(ex)) {
		// DM-5: a worker that crashed mid-run restarts, a few times in a row at most
		restart = st.state === "working";
		patch.state = "failed";
		if (!st.error) patch.error = exitText(ex, "worker exited");
	} else if (st.state === "failed" || (st.state === "blocked" && st.waitingFor === "question")) {
		// The worker's last word stands for a failed turn or an open question (answered
		// by restarting the session); a dialog or a missing first prompt dies with it.
		patch.state = st.state;
	} else patch.state = "done";
	// DM-5: the restart budget: a run that keeps crashing stops being restarted
	let resumeIn: number | undefined;
	if (restart) {
		const n = typeof st.crashRestarts === "number" ? st.crashRestarts : 0;
		const why = patch.error ?? st.error ?? "it ended";
		if (n < RESUME_DELAYS_MS.length && !shuttingDown) {
			resumeIn = RESUME_DELAYS_MS[n]!;
			// still the user's run: working, not a failure to be told about
			patch.state = "working";
			patch.resumeAt = now + resumeIn;
			patch.error = `${why}; continuing in ${Math.ceil(resumeIn / 1000)} s (automatic restart ${n + 1} of ${RESUME_DELAYS_MS.length})`;
		} else {
			restart = false;
			if (n >= RESUME_DELAYS_MS.length)
				patch.error = `${why}; not restarted again after ${n} automatic restarts in a row (reply to continue)`;
		}
	}
	try {
		updateState(id, patch);
	} catch (err) {
		log("error", "finalize failed", { id, error: String(err) });
	}
	stopping.delete(id);
	persistRoster();
	log("info", "finalize", { id, why, state: patch.state, exit: ex ?? null, restart });
	pushJob(id);
	if (reaped && pendingReplies(id).length > 0 && !shuttingDown) {
		// a reply arrived while the idle worker was going away: start it again for it
		void respawn(id).catch((err: unknown) => log("error", "wake after reap failed", { id, error: String(err) }));
	}
	if (resumeIn !== undefined) scheduleResume(id, resumeIn, "crash");
}

// ---- DM-5: automatic restarts after a crash ------------------------------------------

const resumeTimers = new Map<string, NodeJS.Timeout>();

/** Start the run again after `ms`, unless the user stopped, removed or restarted it meanwhile. */
function scheduleResume(id: string, ms: number, why: "crash" | "pending"): void {
	clearTimeout(resumeTimers.get(id));
	log("info", "resume scheduled", { id, ms, why });
	record({ kind: "resume", id, name: rowOf(id)?.name ?? id, why, text: clipText(rowOf(id)?.error) });
	const t = setTimeout(() => {
		resumeTimers.delete(id);
		if (shuttingDown || roster.has(id) || !recs.has(id) || typeof readState(id)?.resumeAt !== "number") return;
		void respawn(id, { prompt: CONTINUE, crash: true }).catch((err: unknown) => {
			log("error", "automatic restart failed", { id, error: String(err) });
			// it cannot run (a locked session, its directory gone): say why, stop trying
			if (!roster.has(id) && recs.has(id))
				endWaiting(id, "failed", `could not restart it: ${(err as Error).message}`);
		});
	}, ms);
	t.unref?.();
	resumeTimers.set(id, t);
}

/** A waiting automatic restart is called off (stop, rm, a restart by other means). Whether one was. */
function cancelResume(id: string): boolean {
	const t = resumeTimers.get(id);
	if (t) clearTimeout(t);
	resumeTimers.delete(id);
	return typeof readState(id)?.resumeAt === "number";
}

/** A run waiting for its automatic restart ends here (stopped, or its restart failed). */
function endWaiting(id: string, state: "stopped" | "failed", error: string | null): void {
	cancelResume(id);
	const now = Date.now();
	try {
		updateState(id, { state, resumeAt: undefined, error, stateSince: now, endedAt: readState(id)?.endedAt ?? now });
	} catch (err) {
		log("error", "end of a waiting run failed", { id, error: String(err) });
	}
	pushJob(id);
}

/**
 * M38: an exit that was not the program's own: a non-zero code, or a signal. node-pty
 * gives a process killed by a signal (SIGKILL: the out-of-memory killer, a kill -9) code
 * 0 and the signal's number, which read as a clean end before.
 */
function crashed(ex: { code: number | null; signal: string | null }): boolean {
	return ex.code !== 0 || (!!ex.signal && ex.signal !== "0");
}

function exitText(ex: { code: number | null; signal: string | null }, what: string): string {
	if (ex.signal && ex.signal !== "0") {
		const n = Number(ex.signal);
		const name = Number.isInteger(n) ? Object.entries(osConstants.signals).find(([, v]) => v === n)?.[0] : ex.signal;
		return `${what === "exited" ? "killed" : "worker killed"} by ${name ?? `signal ${ex.signal}`}`;
	}
	return `${what} with code ${ex.code}`;
}

function checkHosts(): void {
	for (const [id, ref] of [...roster]) {
		if (starting.has(id)) continue;
		if (hostGone(ref)) finalize(id, "host gone");
	}
}

function loadJobs(): void {
	for (const id of listJobIds()) {
		const rec = readJob(id);
		if (rec) recs.set(id, rec);
	}
	// M43: what each job was last in, so what changed while the service was off is an event, and no more
	for (const id of recs.keys()) {
		const st = readState(id);
		if (st && !hidden(st))
			lastSeen.set(id, {
				state: st.state,
				waitingFor: st.endedAt === undefined ? ((st.waitingFor as JobRow["waitingFor"]) ?? null) : null,
				question: typeof st.question === "string" && st.question ? st.question : null,
			});
	}
	const saved = readJson<Record<string, HostRef>>(rosterPath()) ?? {};
	for (const [id, ref] of Object.entries(saved)) {
		if (!recs.has(id) || typeof ref?.hostPid !== "number") continue;
		if (ref.hostToken && sameProcess(ref.hostPid, ref.hostToken)) {
			roster.set(id, { hostPid: ref.hostPid, hostToken: ref.hostToken });
			log("info", "re-adopted", { id, hostPid: ref.hostPid });
		} else finalize(id, "host gone at startup", { startup: true });
	}
	for (const id of recs.keys()) {
		let st = readState(id);
		// M35: a state file a machine crash left empty or cut (reports are written without
		// fsync): the job is not lost with it; it shows as failed, to be started again
		if (!st) {
			const rec = recs.get(id)!;
			const now = Date.now();
			try {
				writeJsonAtomic(stateFile(id), {
					state: "failed",
					startedAt: rec.createdAt,
					updatedAt: now,
					endedAt: now,
					stateSince: now,
					jobToken: newToken(),
					error: "its state was lost in a crash; reply or press Enter twice to start it again",
				});
				st = readState(id);
				log("warn", "state recovered", { id });
			} catch (err) {
				log("error", "state recovery failed", { id, error: String(err) });
			}
		}
		// spec 03: a restart the old daemon did not finish is not going on
		if (st?.restarting) {
			try {
				st = updateState(id, { restarting: undefined });
			} catch {}
		}
		if (st && st.endedAt === undefined && !roster.has(id)) finalize(id, "orphaned", { startup: true });
		// DM-5: a crash restart that was waiting when the daemon went down
		else if (st && typeof st.resumeAt === "number" && !roster.has(id)) {
			scheduleResume(id, Math.max(0, Math.min(st.resumeAt - Date.now(), RESUME_DELAYS_MS.at(-1) ?? 0)), "pending");
		}
	}
	persistRoster();
}

async function terminateHost(id: string, reason?: "restart"): Promise<void> {
	const ref = roster.get(id);
	if (!ref) return;
	reaping.delete(id); // a user's stop wins over an idle reap
	stopping.add(id);
	try {
		updateState(id, { stopRequested: true });
	} catch {}
	try {
		await hostControl(id, "terminate", 3000, reason ? { reason } : {});
	} catch (err) {
		log("warn", "host control failed, sending SIGTERM", { id, error: String(err) });
		try {
			process.kill(ref.hostPid, "SIGTERM");
		} catch {}
	}
}

/**
 * SIGKILL a host that did not stop, and its session's process, only when they are still ours: the host by its start
 * token (or, before the token was read, as this daemon's child), the session as that host's child. Pids are reused.
 */
function killHost(id: string, why: string): void {
	const ref = roster.get(id);
	if (!ref || !isAlive(ref.hostPid)) return;
	const ours = ref.hostToken ? sameProcess(ref.hostPid, ref.hostToken) : parentPid(ref.hostPid) === process.pid;
	if (!ours) {
		log("warn", "host did not stop; its pid is another process now, not killed", { id, why, hostPid: ref.hostPid });
		return;
	}
	const worker = readWorkerPid(id);
	const workerPid = worker !== undefined && parentPid(worker) === ref.hostPid ? worker : undefined;
	log("warn", "host did not stop, killing", { id, why, hostPid: ref.hostPid, workerPid: workerPid ?? null });
	for (const pid of [workerPid, ref.hostPid]) {
		if (pid === undefined) continue;
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	}
}

async function waitGone(ids: string[], ms: number): Promise<boolean> {
	const end = Date.now() + ms;
	for (;;) {
		checkHosts();
		if (ids.every((id) => !roster.has(id))) return true;
		if (Date.now() > end) return false;
		await sleep(50);
	}
}

function spawnHost(rec: JobRecord): number {
	// decision 7: the client that started the daemon gave the host's entry
	const entry = roostEnv("HOST_ENTRY");
	if (!entry)
		throw new OpError("no_host", "the daemon was started without ROOST_HOST_ENTRY: it cannot start sessions");
	const env = { ...process.env };
	// a job's identity never reaches a host (a daemon started from inside a session has one)
	for (const k of Object.keys(env)) if (JOB_ENV_NAMES.includes(k) || k.startsWith("ROOST_JOB_")) delete env[k];
	const child = spawn(process.execPath, [entry, rec.id], { detached: true, stdio: "ignore", cwd: rec.cwd, env });
	child.on("error", (err) => log("error", "host spawn error", { id: rec.id, error: String(err) }));
	child.on("exit", () => setImmediate(checkHosts));
	child.unref();
	if (child.pid === undefined) throw new OpError("spawn_failed", "could not start host process");
	return child.pid;
}

function isDir(p: string): boolean {
	try {
		return statSync(p).isDirectory();
	} catch {
		return false;
	}
}

/** M36: a request id: what a client may send to make a resend safe. */
const requestIdOf = (v: unknown): string | undefined =>
	typeof v === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(v) ? v : undefined;

async function dispatch(
	a: DispatchArgs,
	extra: { schedule?: string; scheduleId?: string } = {},
): Promise<{ id: string; name: string }> {
	if (!a || typeof a !== "object") throw new OpError("bad_request", "missing args");
	// M36: the same request again (its answer was lost): the job it made, not a second one
	const rid = requestIdOf(a.requestId);
	if (a.requestId !== undefined && !rid) throw new OpError("bad_request", "requestId: 1-64 of A-Z a-z 0-9 _ . : -");
	if (rid) for (const r of recs.values()) if (r.requestId === rid) return { id: r.id, name: r.name };
	if (!str(a.cwd) || !isAbsolute(a.cwd) || !isDir(a.cwd))
		throw new OpError("bad_request", `cwd is not a directory: ${a.cwd}`);
	if (!Array.isArray(a.command) || a.command.length === 0 || !a.command.every(str)) {
		throw new OpError("bad_request", "command must be a non-empty array of strings");
	}
	const shell = a.kind === "shell";
	if (!shell && (!str(a.sessionFile) || !isAbsolute(a.sessionFile)))
		throw new OpError("bad_request", "sessionFile must be an absolute path");
	const env: Record<string, string> = {};
	if (a.env && typeof a.env === "object") {
		for (const [k, v] of Object.entries(a.env)) if (typeof v === "string") env[k] = v;
	}

	if (!shell) {
		const holder = readWriterLock(a.sessionFile);
		if (holder) throw new OpError("locked", `session is in use by pid ${holder.pid}`);
		for (const id of roster.keys()) {
			if (recs.get(id)?.sessionFile === a.sessionFile) {
				throw new OpError("locked", `session is already running as job ${id}`);
			}
		}
	}

	let id = newJobId();
	while (recs.has(id)) id = newJobId();
	// M49: one line, as rename keeps it
	const base = (str(a.name) ? a.name.replace(/\s+/g, " ").trim().slice(0, 200) : "") || id;
	// M22: a job this one takes the session from gives up its name (one row per session)
	const taken = new Set(
		[...recs.values()].filter((r) => !(!shell && foldsInto(r, a.sessionFile)) && !hiddenJob(r.id)).map((r) => r.name),
	);
	let name = base;
	for (let n = 2; taken.has(name); n++) name = `${base} (${n})`;

	const now = Date.now();
	const origin = a.origin === "bg" || a.origin === "adopt" || a.origin === "fork" ? a.origin : "dispatch";
	const rec: JobRecord = {
		id,
		name,
		cwd: a.cwd,
		sessionFile: shell ? "" : a.sessionFile,
		command: a.command,
		...(shell ? { kind: "shell" as const } : {}),
		env,
		...(str(a.model) ? { model: a.model } : {}),
		...(str(a.thinking) ? { thinking: a.thinking } : {}),
		...(a.workspaceEnv === "shell" || a.workspaceEnv === "direnv" ? { workspaceEnv: a.workspaceEnv } : {}),
		...(Array.isArray(a.envDeny)
			? { envDeny: a.envDeny.filter((d): d is string => typeof d === "string" && d !== "").slice(0, 256) }
			: {}),
		...(Array.isArray(a.envForce)
			? { envForce: a.envForce.filter((d): d is string => typeof d === "string" && d !== "").slice(0, 256) }
			: {}),
		origin,
		createdAt: now,
		...(str(a.piVersion) ? { piVersion: a.piVersion } : {}),
		roostVersion: ROOST_VERSION,
		...(rid ? { requestId: rid } : {}),
		...(extra.schedule ? { schedule: extra.schedule } : {}),
		...(extra.scheduleId ? { scheduleId: extra.scheduleId } : {}),
	};
	createJob(rec, {
		state: "working",
		startedAt: now,
		updatedAt: now,
		jobToken: newToken(),
		...(shell ? { status: "busy" } : {}),
	});
	recs.set(id, rec);
	try {
		await startHost(rec);
	} catch (err) {
		recs.delete(id);
		shellPids.delete(id);
		removeJob(id);
		throw err;
	}
	log("info", "dispatch", { id, name, cwd: rec.cwd, origin, ...(extra.schedule ? { schedule: extra.schedule } : {}) });
	// M43: the feed starts the job as working; a schedule's run is recorded by the schedule
	lastSeen.set(id, { state: "working", waitingFor: null, question: null });
	if (!extra.schedule)
		record({
			kind: "dispatch",
			id,
			name,
			who: "user",
			why: origin === "dispatch" ? null : origin,
			text: clipText(taskOf(a)),
		});
	if (!shell) supersedeOthers(id);
	return { id, name };
}

/** M43: the task a dispatch carries, for the feed: the argument after "--". */
function taskOf(a: DispatchArgs): string | null {
	const i = a.command.indexOf("--");
	return i >= 0 && str(a.command[i + 1]) ? a.command[i + 1]! : null;
}

/** M22: a job whose session another job took over (while that one is there). */
function hidden(st: JobState): boolean {
	return str(st.supersededBy) && recs.has(st.supersededBy);
}
function hiddenJob(id: string): boolean {
	if (roster.has(id)) return false;
	const st = readState(id);
	return st ? hidden(st) : false;
}

/** M22: an ended xpi job on this session (it gives way to the job that runs it now). */
function foldsInto(r: JobRecord, session: string | undefined): boolean {
	return !!session && r.kind !== "shell" && r.sessionFile === session && !roster.has(r.id);
}

/**
 * M22: one row per session. A job that runs a session again (moved to the background
 * from another xpi window, reopened by a new dispatch) takes over the rows of the ended
 * jobs on it: they stop being listed (their records stay), and a pin carries over.
 */
function supersedeOthers(id: string): void {
	const rec = recs.get(id);
	if (!rec || rec.kind === "shell" || !rec.sessionFile) return;
	let pinned = false;
	for (const r of recs.values()) {
		if (r.id === id || !foldsInto(r, rec.sessionFile)) continue;
		const st = readState(r.id);
		if (!st || hidden(st)) continue;
		if (st.pinned === true) pinned = true;
		updateState(r.id, { supersededBy: id });
		push({ event: "removed", id: r.id });
		log("info", "superseded", { id: r.id, by: id });
	}
	if (pinned && readState(id)?.pinned !== true) {
		updateState(id, { pinned: true });
		pushJob(id);
	}
}

async function startHost(rec: JobRecord): Promise<void> {
	const id = rec.id;
	starting.add(id);
	let hostPid: number;
	try {
		hostPid = spawnHost(rec);
	} catch (err) {
		starting.delete(id);
		throw err;
	}
	const ref: HostRef = { hostPid, hostToken: "" };
	roster.set(id, ref);
	for (let i = 0; i < 25 && !ref.hostToken; i++) {
		ref.hostToken = (await processStartTokenAsync(hostPid)) ?? "";
		if (!ref.hostToken) await sleep(20);
	}
	if (ref.hostToken) ref.verifiedAt = Date.now();
	try {
		updateState(id, { hostPid, hostToken: ref.hostToken });
	} catch {}
	persistRoster();
	starting.delete(id);
	pushJob(id);
	checkHosts();
}

/**
 * AT-1, DM-5, flow 5.7: start an ended job again from its session file. `restart`
 * stops a live one first (respawn --all after an upgrade).
 */
async function respawn(
	id: string,
	opts: { prompt?: string; crash?: boolean; restart?: boolean } = {},
): Promise<{ id: string; started: boolean }> {
	const rec = recs.get(id);
	if (!rec) throw new OpError("not_found", `no such job: ${id}`);
	if (starting.has(id) || respawning.has(id)) return { id, started: false };
	respawning.add(id);
	let restarting = false;
	let priorState: JobState["state"] | undefined;
	try {
		// DM-5: an automatic restart waiting: this start takes its place (once it can start)
		const pendingResume = typeof readState(id)?.resumeAt === "number";
		const shell = rec.kind === "shell";
		let prompt = shell ? undefined : opts.prompt;
		// started by other means (attach, Enter twice) while a restart waited: the run
		// still carries on; a reply waiting goes in instead
		if (!prompt && !shell && pendingResume && pendingReplies(id).length === 0) prompt = CONTINUE;
		if (roster.has(id)) {
			// a running command is never killed to be run again (respawn --all after an upgrade)
			if (!opts.restart || shell) return { id, started: false };
			// a turn cut short by the restart carries on in the new worker
			if (!prompt && readState(id)?.state === "working") prompt = CONTINUE;
			// spec 03: attached terminals and the hub see a restart, not an end, until the new host is up (or this fails)
			restarting = true;
			priorState = readState(id)?.state;
			updateState(id, { restarting: true });
			pushJob(id);
			await terminateHost(id, "restart");
			if (!(await waitGone([id], WAIT_MS))) throw new OpError("busy", `job ${id} did not stop`);
		}
		if (ptyError) throw new OpError("no_pty", `node-pty is unavailable: ${ptyError}`);
		if (!shell) {
			const holder = readWriterLock(rec.sessionFile);
			if (holder) throw new OpError("locked", `session is in use by pid ${holder.pid}`);
		}
		if (!isDir(rec.cwd)) throw new OpError("bad_request", `cwd is gone: ${rec.cwd}`);
		if (!recs.has(id)) throw new OpError("not_found", `job ${id} was removed`);
		const st = readState(id);
		const written = !shell && existsSync(rec.sessionFile);
		// M8: the model and thinking level it last reported running win over the dispatch's;
		// before any report, the ones it was dispatched with (a hand-off's live values)
		const command = respawnCommand(rec, written, prompt, {
			model: st?.model ?? rec.model,
			thinking: st?.thinking ?? rec.thinking,
		});
		const now = Date.now();
		// nothing new to do: the worker shows where the session left off, so keep the row as is
		const restore = written && !prompt && pendingReplies(id).length === 0 && st?.state !== "working";
		// it starts now: the waiting restart is spent (a failure above leaves it to run)
		clearTimeout(resumeTimers.get(id));
		resumeTimers.delete(id);
		clearExit(id);
		clearWorker(id);
		updateState(id, {
			...(restore
				? // the old process's exit marked it stopped; a restart gives back the state it was in
					{ stateSince: st?.stateSince, ...(priorState ? { state: priorState } : {}) }
				: { state: "working" as const, stateSince: now, summary: null, question: null, choices: [] }),
			// a shell job has no worker to report: it is busy until it exits
			status: rec.kind === "shell" ? "busy" : null,
			waitingFor: null,
			tool: null,
			error: null,
			reportedAt: undefined,
			// spec 03: what the old process said about itself (its build) must not show on the restarted row
			agentInfo: undefined,
			endedAt: undefined,
			stopRequested: false,
			removeAt: undefined,
			reaped: false,
			supersededBy: undefined,
			attachSignal: false,
			restartedAt: now,
			resumeAt: undefined,
			command,
			restore,
			// an automatic restart counts; one the user makes while one waited neither counts
			// nor gives the budget back (replies to a crash loop would keep it going)
			crashRestarts:
				opts.crash || pendingResume
					? (typeof st?.crashRestarts === "number" ? st.crashRestarts : 0) + (opts.crash ? 1 : 0)
					: 0,
		});
		await startHost(rec);
		if (!shell) supersedeOthers(id);
		log("info", "respawn", { id, crash: !!opts.crash, restart: !!opts.restart, prompt: !!prompt });
		return { id, started: true };
	} finally {
		respawning.delete(id);
		if (restarting) {
			try {
				updateState(id, { restarting: undefined });
			} catch {}
			pushJob(id);
		}
	}
}

/**
 * Spec 03: restart these running xpi sessions onto the installed code, one after another in the order given, `last`
 * at the end with its own prompt. It runs to the end whatever happens to the client's connection: the caller may be
 * one of the sessions (its process goes when its own turn comes, which is why it is last). A session that cannot be
 * restarted is reported and the others go on.
 */
async function restartSessions(
	ids: string[],
	last: { id: string; prompt?: string } | undefined,
): Promise<{ id: string; started: boolean; error?: string }[]> {
	const order = [...new Set(ids)].filter((id) => id !== last?.id);
	if (last) order.push(last.id);
	const results: { id: string; started: boolean; error?: string }[] = [];
	for (const id of order) {
		try {
			const rec = recs.get(id);
			if (!rec) throw new OpError("not_found", `no such job: ${id}`);
			if (!roster.has(id) || rec.kind === "shell") throw new OpError("bad_request", "not running");
			const prompt = id === last?.id && last.prompt?.trim() ? last.prompt.trim() : undefined;
			results.push(await respawn(id, { restart: true, prompt }));
		} catch (err) {
			results.push({ id, started: false, error: (err as Error).message });
		}
	}
	return results;
}

/** DI-6: a shell job's row shows its latest output line; ended ones go after a while. */
function shellTick(): void {
	const now = Date.now();
	for (const [id, rec] of recs) {
		if (rec.kind !== "shell") {
			// M22: a worker that is up shows as such before its first report (or without one)
			if (!roster.has(id)) shellPids.delete(id);
			else {
				const pid = readWorkerPid(id) ?? null;
				if (shellPids.get(id) !== pid) {
					shellPids.set(id, pid);
					pushJob(id);
				}
			}
			continue;
		}
		const st = readState(id);
		if (!st) continue;
		if (!roster.has(id)) {
			if (typeof st.removeAt === "number" && now >= st.removeAt) {
				recs.delete(id);
				removeJob(id);
				log("info", "shell job expired", { id });
				push({ event: "removed", id });
			}
			shellPids.delete(id);
			continue;
		}
		const line = lastScreenLine(id);
		const pid = readWorkerPid(id) ?? null;
		const changed = Boolean(line && line !== st.summary);
		if (changed) updateState(id, { summary: line });
		if (changed || shellPids.get(id) !== pid) {
			shellPids.set(id, pid);
			pushJob(id);
		}
	}
}

function lastScreenLine(id: string): string | undefined {
	try {
		const lines = readFileSync(screenPath(id), "utf8").split("\n");
		for (let i = lines.length - 1; i >= 0; i--) {
			const l = lines[i]!.trim();
			if (l) return l.slice(0, 200);
		}
	} catch {
		// not painted yet
	}
	return undefined;
}

/** When an idle job became idle, if it may be reaped now. */
function reapable(id: string, now: number, minutes: number): number | undefined {
	const st = readState(id);
	if (!st || st.pinned === true || st.state === "working") return undefined;
	if (st.waitingFor === "dialog" || (st.status !== "idle" && st.status !== "waiting")) return undefined;
	if (pendingReplies(id).length > 0) return undefined;
	const since = typeof st.stateSince === "number" ? st.stateSince : st.updatedAt;
	return now - since < minutes * 60_000 ? undefined : since;
}

/**
 * M22: stop a worker only if nobody is attached, decided in the host itself: an attach
 * between asking for its status and terminating it would otherwise lose its session.
 */
async function terminateIfIdle(id: string): Promise<boolean> {
	try {
		const r = (await hostControl(id, "terminate-idle")) as { ok?: boolean; error?: string };
		if (r.error) await hostControl(id, "terminate");
		else if (r.ok !== true) {
			log("info", "not stopped: attached meanwhile", { id });
			return false;
		}
		return true;
	} catch {
		return false;
	}
}

/** DM-4: stop workers that have been idle, unattached and unpinned for reapIdleMinutes. */
async function reapIdle(): Promise<void> {
	const minutes = Number(roostEnv("REAP_MINUTES")) || settings().reapIdleMinutes;
	if (!(minutes > 0)) return;
	const now = Date.now();
	for (const id of [...roster.keys()]) {
		if (starting.has(id) || stopping.has(id) || reaping.has(id) || respawning.has(id)) continue;
		const since = reapable(id, now, minutes);
		if (since === undefined) continue;
		reaping.add(id); // replies and stops see this while we ask the host
		let attached = true;
		try {
			attached = !!((await hostControl(id, "status")) as { attached?: boolean }).attached;
		} catch {
			// unknown: leave it
		}
		// anything may have happened during the await: decide again
		if (
			attached ||
			!reaping.has(id) ||
			!roster.has(id) ||
			stopping.has(id) ||
			reapable(id, Date.now(), minutes) === undefined
		) {
			reaping.delete(id);
			continue;
		}
		log("info", "reap", { id, idleMinutes: Math.round((now - since) / 60_000) });
		if (!(await terminateIfIdle(id))) reaping.delete(id);
	}
}

function resolve(query: unknown): string {
	if (!str(query)) throw new OpError("bad_request", "query required");
	if (recs.has(query)) return query;
	// M22: jobs folded into another one's row are matched only when nothing listed is
	const shown = (ids: string[]) => {
		const v = ids.filter((id) => !hiddenJob(id));
		return v.length > 0 ? v : ids;
	};
	const byPrefix = shown([...recs.keys()].filter((id) => id.startsWith(query)));
	if (byPrefix.length === 1) return byPrefix[0]!;
	const q = query.toLowerCase();
	const matches =
		byPrefix.length > 1
			? byPrefix
			: shown([...recs.values()].filter((r) => r.name.toLowerCase().includes(q)).map((r) => r.id));
	if (matches.length === 1) return matches[0]!;
	if (matches.length === 0) throw new OpError("not_found", `no job matches "${query}"`);
	const list = matches.map((id) => `${id} · ${recs.get(id)!.name}`).join(", ");
	throw new OpError("ambiguous", `"${query}" is ambiguous: ${list}`);
}

const REPORT_WAITING = new Set([null, "dialog", "question", "first-prompt"]);

interface PendingReply {
	seq: number;
	text: string;
	/** M28: a user reply that steers. */
	mode?: "steer";
}

const MAX_PENDING = 50;

function pendingReplies(id: string): PendingReply[] {
	const p = readState(id)?.pendingReplies;
	return Array.isArray(p) ? p.filter((r): r is PendingReply => typeof r?.seq === "number" && str(r?.text)) : [];
}

/** (Re)send every reply the worker has not acknowledged; the worker drops seqs it has seen. */
function flushPending(id: string, conn: Conn): void {
	const pending = pendingReplies(id);
	for (const r of pending) send(conn, deliverEvent(id, r));
	if (pending.length > 0) log("info", "delivered pending replies", { id, count: pending.length });
}

function acknowledge(args: { id?: unknown; token?: unknown; seq?: unknown } | undefined): void {
	const id = args?.id;
	if (!str(id) || !recs.has(id)) throw new OpError("not_found", `no such job: ${String(id)}`);
	const st = readState(id);
	if (!st || !str(args?.token) || st.jobToken !== args.token) throw new OpError("unauthorized", "bad job token");
	if (typeof args.seq !== "number") throw new OpError("bad_request", "seq required");
	const acked = args.seq;
	// replies are acknowledged up to a seq
	// not durable: an ack lost in a crash means the reply is sent again, and dropped by seq
	updateState(id, { pendingReplies: pendingReplies(id).filter((r) => r.seq > acked) }, false);
}

function deliverEvent(id: string, r: PendingReply): Event {
	return { event: "deliver", id, seq: r.seq, text: r.text, ...(r.mode ? { mode: r.mode } : {}) };
}

async function reply(args: { id?: unknown; text?: unknown; mode?: unknown } | undefined): Promise<{
	delivered: boolean;
	saved: boolean;
	stopped?: boolean;
	respawned?: boolean;
	error?: string;
	duplicate?: boolean;
}> {
	const id = requireJob(args);
	const text = typeof args?.text === "string" ? args.text.trim() : "";
	const steer = args?.mode === "steer";
	if (!text) throw new OpError("bad_request", "empty reply");
	// M36: a resend of a reply the daemon took (its answer was lost) is not taken twice
	const rawRid = (args as { requestId?: unknown } | undefined)?.requestId;
	const rid = requestIdOf(rawRid);
	if (rawRid !== undefined && !rid) throw new OpError("bad_request", "requestId: 1-64 of A-Z a-z 0-9 _ . : -");
	if (rid && seenRequest(id, rid)) {
		// taken before; an ended job it was to start (the daemon died in between) starts now
		if (!roster.has(id) && !starting.has(id) && !respawning.has(id) && pendingReplies(id).length > 0) {
			const r = await respawn(id).catch((err: unknown) => ({ error: (err as Error).message }));
			return {
				delivered: false,
				saved: true,
				duplicate: true,
				...("error" in r ? { error: r.error } : { respawned: r.started }),
			};
		}
		return { delivered: false, saved: true, duplicate: true };
	}
	const live = roster.has(id);
	if (text === "/stop") {
		if (live) await terminateHost(id);
		else if (cancelResume(id)) {
			endWaiting(id, "stopped", null);
			return { delivered: false, saved: false, stopped: true };
		}
		return { delivered: live, saved: false, stopped: live };
	}
	if (text.startsWith("!"))
		throw new OpError("unsupported", "shell commands in replies are not supported yet; attach to run them");
	if (recs.get(id)?.kind === "shell")
		throw new OpError("unsupported", "a shell job takes no replies; attach to type into it");
	const conn = workerConns.get(id);
	const connected = live && !!conn && !conn.sock.destroyed;
	// PK-5: commands only make sense live; plain replies wait for the worker.
	if (live && !connected && text.startsWith("/")) return { delivered: false, saved: false };
	const pending = pendingReplies(id);
	if (pending.length >= MAX_PENDING)
		throw new OpError("full", `${MAX_PENDING} replies are already waiting for this session`);
	// Every reply stays pending until the worker acknowledges it, so a dying connection loses nothing.
	const st = readState(id);
	const seq = (typeof st?.replySeq === "number" ? st.replySeq : 0) + 1;
	const item: PendingReply = { seq, text, ...(steer ? { mode: "steer" as const } : {}) };
	// the request id goes in the same write as the reply: both are kept, or neither
	updateState(id, {
		replySeq: seq,
		pendingReplies: [...pending, item],
		...(rid ? { requestIds: withRequest(st, rid) } : {}),
	});
	record({ kind: "reply", id, name: rowOf(id)?.name ?? id, who: "user", whoId: null, text: clipText(text) });
	if (connected) {
		send(conn!, deliverEvent(id, item));
		return { delivered: true, saved: false };
	}
	log("info", "reply saved", { id, live });
	if (live) return { delivered: false, saved: true };
	// flow 5.7: a reply to an ended session starts it again; the worker picks the reply up
	try {
		const { started } = await respawn(id);
		// started: false means it is already coming up; the saved reply reaches it either way
		return { delivered: false, saved: true, respawned: started || starting.has(id) || roster.has(id) };
	} catch (err) {
		log("warn", "respawn for reply failed", { id, error: String(err) });
		return { delivered: false, saved: true, error: (err as Error).message };
	}
}

/**
 * M31: an agent's hello. Informational (a report is what proves a job): the daemon keeps
 * what the agent can do and answers with its own protocol and capabilities. A newer
 * protocol than this daemon's is answered with this one's: the agent decides.
 */
function hello(
	conn: Conn,
	args: { protocol?: unknown; agent?: unknown; capabilities?: unknown } | undefined,
): HelloResult {
	const a = (args?.agent && typeof args.agent === "object" ? args.agent : {}) as {
		name?: unknown;
		version?: unknown;
		build?: unknown;
	};
	const name = (str(a.name) ? oneLineText(a.name, 64) : "") || "unknown";
	const caps = Array.isArray(args?.capabilities)
		? [...new Set(args.capabilities.filter(str).map((c) => c.slice(0, 40)))].slice(0, 32)
		: [];
	conn.hello = {
		name,
		version: str(a.version) ? a.version.slice(0, 40) : null,
		// spec 03: the build of the code the agent runs; absent from an agent that does not say
		...(str(a.build) && a.build ? { build: a.build.slice(0, 40) } : {}),
		capabilities: caps,
	};
	return {
		protocol: PROTOCOL_VERSION,
		daemon: { name: "roost", version: ROOST_VERSION },
		capabilities: [...DAEMON_CAPABILITIES],
	};
}

/** M49: one line of plain characters (newlines and tabs fold too), at most `max`. */
const oneLineText = (v: unknown, max: number): string => taskText(v, max).replace(/\s+/g, " ").trim();

/** M36: request ids a job's replies came with, the last 100 (a resend comes soon after). */
const MAX_REQUEST_IDS = 100;
function seenRequest(id: string, rid: string): boolean {
	const ids = readState(id)?.requestIds;
	return Array.isArray(ids) && ids.includes(rid);
}
function withRequest(st: JobState | undefined, rid: string): string[] {
	const ids = Array.isArray(st?.requestIds)
		? (st.requestIds as unknown[]).filter((x): x is string => typeof x === "string")
		: [];
	return [...ids, rid].slice(-MAX_REQUEST_IDS);
}

function acceptReport(
	conn: Conn,
	args: { id?: unknown; token?: unknown; report?: Partial<WorkerReport> } | undefined,
): void {
	const id = args?.id;
	if (!str(id) || !recs.has(id)) throw new OpError("not_found", `no such job: ${String(id)}`);
	const st = readState(id);
	if (!st || !str(args?.token) || st.jobToken !== args.token) throw new OpError("unauthorized", "bad job token");
	if (!roster.has(id) || stopping.has(id)) return; // ended or being stopped: the daemon owns the state now
	if (workerConns.get(id) !== conn) {
		workerConns.set(id, conn);
		conn.peer = { id };
		flushPending(id, conn);
	}
	// checked here, not at the entry: a report for a job that ended is taken (above) whatever it says
	const r = args.report;
	if (!r || !REPORT_STATES.has(r.state as string) || !REPORT_STATUS.has(r.status as string)) {
		throw new OpError("bad_request", "invalid report");
	}
	const opt = (v: unknown, max = 500) => (typeof v === "string" && v.length > 0 ? v.slice(0, max) : null);
	const before = st.state;
	const waitingBefore = st.waitingFor ?? null;
	const waitingNow = REPORT_WAITING.has(r.waitingFor ?? null) ? (r.waitingFor ?? null) : null;
	const reported = opt(r.name, 200);
	updateState(id, {
		...(before !== r.state || waitingBefore !== waitingNow ? { stateSince: Date.now() } : {}),
		state: r.state,
		status: r.status,
		waitingFor: waitingNow,
		summary: opt(r.summary),
		question: opt(r.question, 2000),
		choices: Array.isArray(r.choices)
			? r.choices
					.filter(str)
					.slice(0, 20)
					.map((c) => c.slice(0, 200))
			: [],
		tool: opt(r.tool, 100),
		error: opt(r.error, 1000),
		// a rename the session has not taken yet keeps the daemon's name
		displayName: str(st.pendingName) && reported !== st.pendingName ? st.pendingName : reported,
		...(str(st.pendingName) && reported === st.pendingName ? { pendingName: null } : {}),
		model: opt(r.model, 200),
		...(r.thinking !== undefined ? { thinking: opt(r.thinking, 20) } : {}),
		...(r.context !== undefined ? { context: contextFrom(r.context) } : {}),
		...(r.usage !== undefined ? { usage: usageFrom(r.usage) } : {}),
		reportedAt: Date.now(),
		// M31: what its agent said it can do (kept from the hello on this connection)
		...(conn.hello ? { agentInfo: conn.hello } : {}),
		attachSignal: r.attachSignal === true,
		// a turn that ends normally clears the crash budget (DM-5)
		// (only once the worker has stayed up a while, so a crash loop stays bounded)
		// (written only when there is a count: a report is not otherwise a durable write)
		...(r.state !== "working" &&
		typeof st.crashRestarts === "number" &&
		st.crashRestarts > 0 &&
		Date.now() - (typeof st.restartedAt === "number" ? st.restartedAt : 0) > CRASH_RESET_MS
			? { crashRestarts: 0 }
			: {}),
	});
	if (before !== r.state) log("info", "state", { id, from: before, to: r.state, waitingFor: r.waitingFor ?? null });
	pushJob(id);
}

const REPORT_STATES = new Set(["working", "blocked", "done", "failed"]);
const REPORT_STATUS = new Set(["busy", "waiting", "idle"]);

/** AV-K10: the row's name, the job's name for `attach <name>`, and the live session's name. */
function rename(args: { id?: unknown; name?: unknown } | undefined): { id: string; name: string } {
	const id = requireJob(args);
	const name = (args!.name as string).replace(/\s+/g, " ").trim().slice(0, 200);
	const rec = recs.get(id)!;
	const next = { ...rec, name };
	writeJsonAtomic(`${jobDirOf(id)}/job.json`, next);
	recs.set(id, next);
	// a shell job's row is named by the daemon alone
	if (rec.kind === "shell") {
		updateState(id, { displayName: name }, true);
		pushJob(id);
		log("info", "rename", { id, name });
		return { id, name };
	}
	// The session takes the name too, whenever its worker next runs (now, or after a
	// respawn): until it reports that name, the daemon's name wins over the report.
	const st = readState(id);
	const seq = (typeof st?.replySeq === "number" ? st.replySeq : 0) + 1;
	const pending = pendingReplies(id).filter((r) => !r.text.startsWith("/name "));
	updateState(id, {
		displayName: name,
		pendingName: name,
		replySeq: seq,
		pendingReplies: [...pending, { seq, text: `/name ${name}` }],
	});
	const conn = workerConns.get(id);
	if (roster.has(id) && conn && !conn.sock.destroyed) send(conn, { event: "deliver", id, seq, text: `/name ${name}` });
	pushJob(id);
	log("info", "rename", { id, name });
	return { id, name };
}

function requireJob(args: unknown): string {
	const id = (args as { id?: unknown } | undefined)?.id;
	if (!str(id)) throw new OpError("bad_request", "id required");
	if (!recs.has(id)) throw new OpError("not_found", `no such job: ${id}`);
	return id;
}

function list(args: { cwd?: string } | undefined): JobRow[] {
	const cwd = args?.cwd;
	const prefix = cwd ? (cwd.endsWith("/") ? cwd : `${cwd}/`) : undefined;
	const rows: JobRow[] = [];
	for (const rec of recs.values()) {
		if (cwd && rec.cwd !== cwd && !rec.cwd.startsWith(prefix!)) continue;
		const row = rowOf(rec.id);
		if (row) rows.push(row);
	}
	return rows.sort((x, y) => y.startedAt - x.startedAt);
}

let server: Server;
let shuttingDown = false;

async function shutdown(keepWorkers: boolean): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	log("info", "shutdown", { keepWorkers });
	// DM-5: a waiting restart stays in the job's state (resumeAt); the next start takes it up
	for (const t of resumeTimers.values()) clearTimeout(t);
	resumeTimers.clear();
	clearInterval(watcher);
	clearInterval(shellWatcher);
	clearInterval(reaper);
	schedules.stop();
	if (!keepWorkers) {
		const ids = [...roster.keys()];
		await Promise.all(ids.map((id) => terminateHost(id)));
		if (!(await waitGone(ids, WAIT_MS))) {
			// a host that did not stop would keep its session running with no daemon to reach it
			for (const id of ids) if (roster.has(id)) killHost(id, "shutdown");
			await waitGone(ids, 2000);
		}
	}
	persistRoster();
	// M35: the last group of durable writes reaches the disk before the process goes
	await durable().catch(() => {});
	// The reverse of the order they were taken in: a daemon starting now never finds the state locked
	// behind a free runtime lock.
	releaseStateLock();
	releaseDaemonLock();
	server.close();
	for (const c of conns) c.sock.destroy();
	try {
		unlinkSync(daemonSocketPath());
	} catch {}
	process.exit(0);
}

async function handle(conn: Conn, op: string, args: any): Promise<unknown> {
	// M63: who may do it, by the caller's kind (lib/callers.ts); the op checks what needs state
	const refused = allow(callerOf(conn), op);
	if (refused) throw new OpError(refused.code, refused.message);
	// an agent's first words mark its connection as an agent's, even when they are refused
	if (op === "hello" || op === "report") conn.agentSide = true;
	// M76: the arguments' shape, by the op's schema (lib/protocol-schema.ts); what needs state is the op's
	const problem = argsProblem(op, args);
	if (problem) throw new OpError("bad_request", problem);
	switch (op) {
		case "ping":
			return { pid: process.pid, version: ROOST_VERSION };
		case "hello":
			return hello(conn, args);
		case "list":
			return { jobs: list(args) };
		case "dispatch":
			return dispatch(args);
		case "schedules":
		case "schedule-add":
		case "schedule-edit":
		case "schedule-rm":
		case "schedule-pause":
		case "schedule-run":
			return schedules.op(op, args);
		case "resolve":
			return { id: resolve(args?.query) };
		case "status": {
			const s: DaemonStatus = {
				pid: process.pid,
				version: ROOST_VERSION,
				socketDir: runtimeDir(),
				liveJobs: roster.size,
				totalJobs: recs.size,
				...(ROOST_BUILD ? { build: ROOST_BUILD } : {}),
				ptyError,
				startedAt,
			};
			return s;
		}
		case "subscribe":
			conn.subscribed = true;
			return {};
		case "stop": {
			const id = requireJob(args);
			if (roster.has(id)) {
				log("info", "stop", { id });
				await terminateHost(id);
			} else if (cancelResume(id)) {
				// DM-5: between a crash and its automatic restart
				log("info", "stop", { id, resume: "cancelled" });
				endWaiting(id, "stopped", null);
			}
			return { id };
		}
		case "rm":
			return removeRecord(requireJob(args));
		case "respawn": {
			if (args.ids) return { results: await restartSessions(args.ids, args.last) };
			if (args?.all === true) {
				const results: { id: string; started: boolean; error?: string }[] = [];
				for (const id of [...recs.keys()]) {
					// --all moves live jobs to the installed version; reaped ones pick it up when woken
					if (!roster.has(id) || recs.get(id)?.kind === "shell") continue;
					try {
						results.push(await respawn(id, { restart: true }));
					} catch (err) {
						results.push({ id, started: false, error: (err as Error).message });
					}
				}
				return { results };
			}
			const id = requireJob(args);
			const prompt = typeof args?.prompt === "string" && args.prompt.trim() ? args.prompt.trim() : undefined;
			return { results: [await respawn(id, { restart: args?.restart === true, prompt })] };
		}
		case "pin": {
			const id = requireJob(args);
			const pinned = args?.pinned === true;
			updateState(id, { pinned });
			pushJob(id);
			return { id, pinned };
		}
		case "rename":
			return rename(args);
		case "reorder": {
			// M76: a list of job ids and a key, checked at the entry; ids of jobs it knows, here
			const ids = args.ids as string[];
			const key = args.key as string;
			if (!ids.every((v) => recs.has(v))) throw new OpError("bad_request", "ids must be job ids");
			for (const [i, id] of ids.entries()) updateState(id, { order: i, orderKey: key });
			for (const id of ids) pushJob(id);
			return {};
		}
		case "report":
			acceptReport(conn, args);
			return {};
		case "reply":
			return reply(args);
		case "ack":
			acknowledge(args);
			return {};
		case "shutdown":
			setTimeout(() => void shutdown(!!args?.keepWorkers), 20);
			return {};
		case "events":
			return eventLog.since({ after: args?.after, limit: args?.limit, id: args?.id });
		default:
			throw new OpError("bad_request", `unknown op: ${op}`);
	}
}

/** M49: a connection's lines are handled INFLIGHT_MAX at a time; past that it is not read until answers went out. */
function pumpLines(conn: Conn): void {
	while (conn.head < conn.backlog.length && conn.inflight < INFLIGHT_MAX) {
		const line = conn.backlog[conn.head++]!;
		conn.inflight++;
		void onLine(conn, line).finally(() => {
			conn.inflight--;
			pumpLines(conn);
		});
	}
	if (conn.head >= conn.backlog.length) {
		conn.backlog = [];
		conn.head = 0;
	}
	const full = conn.inflight >= INFLIGHT_MAX;
	if (full !== !!conn.paused && !conn.sock.destroyed) {
		conn.paused = full;
		if (full) conn.sock.pause();
		else conn.sock.resume();
	}
}

async function onLine(conn: Conn, line: string): Promise<void> {
	if (!line.trim()) return;
	let msg: { id?: unknown; op?: unknown; args?: unknown } | undefined;
	try {
		msg = JSON.parse(line);
	} catch {
		log("warn", "bad client line");
		return;
	}
	const reqId = msg && typeof msg === "object" ? msg.id : undefined;
	if (typeof reqId !== "number") return;
	if (typeof msg!.op !== "string") {
		send(conn, { id: reqId, ok: false, error: "op required", code: "bad_request" });
		return;
	}
	try {
		const result = await handle(conn, msg!.op, msg!.args);
		// M35: what the answer says was saved is on disk before it is sent
		await durable();
		send(conn, { id: reqId, ok: true, result });
	} catch (err) {
		const e = err as Partial<OpError> & Error;
		if (!(err instanceof OpError)) log("error", "op failed", { op: msg!.op, error: String(e?.stack ?? err) });
		send(conn, { id: reqId, ok: false, error: e?.message ?? String(err), code: e?.code ?? "internal" });
	}
}

loadJobs();

try {
	unlinkSync(daemonSocketPath());
} catch {}
server = createServer((sock) => {
	if (conns.size >= CONNS_MAX) {
		log("warn", "too many connections: refused", { open: conns.size });
		sock.destroy();
		return;
	}
	const conn: Conn = { sock, subscribed: false, inflight: 0, backlog: [], head: 0 };
	conns.add(conn);
	const reader = new LineReader(LINE_MAX_REQUEST);
	sock.on("data", (chunk) => {
		let lines: string[];
		try {
			lines = reader.push(chunk);
		} catch (err) {
			log("warn", "client line too long: dropped", { peer: conn.peer?.id ?? null, error: String(err) });
			sock.destroy();
			return;
		}
		for (const line of lines) conn.backlog.push(line);
		pumpLines(conn);
	});
	sock.on("error", () => {});
	sock.on("close", () => {
		conns.delete(conn);
		// M49: what it sent and was not started yet is not run for a client that is gone
		conn.backlog = [];
		conn.head = 0;
	});
});
server.on("error", (err) => {
	log("error", "server error", { error: String(err) });
});
await new Promise<void>((res) => {
	server.once("error", (err) => {
		releaseStateLock();
		releaseDaemonLock();
		console.error(`daemon cannot listen: ${err}`);
		process.exit(1);
	});
	server.listen(daemonSocketPath(), () => res());
});
try {
	chmodSync(daemonSocketPath(), 0o600);
} catch {}

const watcher = setInterval(checkHosts, 1000);
const shellWatcher = setInterval(shellTick, 2000);
shellWatcher.unref();
const reaper = setInterval(
	() => {
		void reapIdle().catch((err: unknown) => log("error", "reap failed", { error: String(err) }));
		void cleanupOld().catch((err: unknown) => log("error", "cleanup failed", { error: String(err) }));
	},
	Number(roostEnv("REAP_CHECK_MS")) || REAP_CHECK_MS,
);
// ---- phase 2: schedules (lib/schedules.ts) ---------------------------------------------

/** Decision 7: a run holds its schedule back while it works, starts or waits to restart after a crash. */
function runStillWorking(id: string | undefined): boolean {
	if (!id || !recs.has(id)) return false;
	if (starting.has(id) || respawning.has(id)) return true;
	const st = readState(id);
	return st?.state === "working" && (roster.has(id) || typeof st.resumeAt === "number");
}

/**
 * Decision 6, for the retention: "ended" (done, failed or stopped, nothing waiting to start it again); "asking" (it
 * ended on a question and has no process, no reply and no restart waiting); else "running".
 */
function runState(id: string): ScheduleRun["state"] {
	if (!recs.has(id) || runStillWorking(id) || stopping.has(id) || removing.has(id)) return "running";
	const st = readState(id);
	if (!st || pendingReplies(id).length > 0 || typeof st.resumeAt === "number") return "running";
	if (st.state === "done" || st.state === "failed" || st.state === "stopped") return "ended";
	if (st.state === "blocked" && !roster.has(id)) return "asking";
	return "running";
}

const schedulesPath = join(roostHome(), "schedules.json");
const schedules = createSchedules({
	jobs: {
		dispatch: (launch, extra) => dispatch(launch, extra),
		stillRunning: runStillWorking,
		shuttingDown: () => shuttingDown,
		runs: () => {
			const out: ScheduleRun[] = [];
			for (const r of recs.values()) {
				if (!r.scheduleId) continue;
				out.push({
					id: r.id,
					scheduleId: r.scheduleId,
					createdAt: r.createdAt,
					state: runState(r.id),
					live: roster.has(r.id),
					pinned: readState(r.id)?.pinned === true,
				});
			}
			return out;
		},
		reaping: () => (Number(roostEnv("REAP_MINUTES")) || settings().reapIdleMinutes) > 0,
		remove: async (id) => {
			// asked again: anything may have changed since the list
			if (runState(id) === "running" || readState(id)?.pinned === true) return;
			await removeRecord(id);
		},
	},
	store: {
		read: () => (existsSync(schedulesPath) ? JSON.parse(readFileSync(schedulesPath, "utf8")) : undefined),
		write: (v) => writeJsonAtomic(schedulesPath, v),
		setAside: () => {
			const to = `${schedulesPath}.bad-${new Date().toISOString().replace(/[:.]/g, "-")}`;
			renameSync(schedulesPath, to);
			return to;
		},
	},
	record,
	log,
	isDir,
	exists: (p) => existsSync(p),
	tickMs: Number(roostEnv("SCHEDULE_TICK_MS")) || 15_000,
});
schedules.start();

// M78: test mode only (ROOST_PARENT_PID is set by tests): with its parent or its home gone
// the daemon stops, hosts included. Never armed in normal use.
const followed = followedParent();
if (followed !== undefined) {
	const follower = setInterval(() => {
		if (!pidAlive(followed)) {
			log("info", "parent gone, stopping", { parent: followed });
			void shutdown(false);
		} else if (!existsSync(roostHome())) {
			log("info", "home gone, stopping");
			void shutdown(false);
		}
	}, 2000);
	follower.unref();
}
process.on("SIGTERM", () => void shutdown(true));
process.on("SIGINT", () => void shutdown(true));
log("info", "started", {
	pid: process.pid,
	version: ROOST_VERSION,
	socket: daemonSocketPath(),
	ptyError,
	jobs: recs.size,
	live: roster.size,
});
