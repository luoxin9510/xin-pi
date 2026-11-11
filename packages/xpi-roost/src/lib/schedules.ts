/**
 * Phase 2 (spec 02, from pi-roost's M39 and M67): the daemon's schedules as a module. The schedules and their file, the
 * tick that starts a run when its slot comes due (or once for missed slots, decision 4), the skips (decision 7), the
 * retention of ended runs (decision 6) and the ops. Ports are narrow; time is the Clock's.
 */
import { type Clock, systemClock, type Timer } from "./clock.ts";
import type { RoostEvent } from "./events.ts";
import { OpError } from "./op.ts";
import type { DispatchArgs } from "./protocol.ts";
import {
	checkTask,
	checkTemplate,
	latestSlot,
	nextRun,
	parseWhen,
	runLaunch,
	runSlot,
	SCHEDULE_NAME,
	SCHEDULES_MAX,
	type Schedule,
	scheduleRow,
	type When,
} from "./schedule.ts";

/** A run as the retention needs it. */
export interface ScheduleRun {
	id: string;
	schedule: string;
	createdAt: number;
	/** Done, failed or stopped, and not working, starting or waiting to restart. */
	ended: boolean;
	pinned: boolean;
}

/** The jobs: sessions the daemon runs. */
export interface SchedulesJobsPort {
	/** Starts a run (its record carries the schedule's name). */
	dispatch(launch: DispatchArgs, extra: { schedule: string }): Promise<{ id: string; name: string }>;
	/** Decision 7: whether a run is working, starting or waiting to restart after a crash (not one waiting for an answer). */
	stillRunning(id: string | undefined): boolean;
	/** The daemon is going down: a tick starts nothing. */
	shuttingDown(): boolean;
	/** Every job a schedule started (its record's `schedule`). */
	runs(): ScheduleRun[];
	/** Removes a job's record, as `rm` does. */
	remove(id: string): Promise<void>;
}

/** The file the schedules live in (the daemon writes it atomically and durably under the roost's home). */
export interface SchedulesStore {
	read(): unknown;
	write(v: unknown): void;
}

export interface SchedulesDeps {
	jobs: SchedulesJobsPort;
	store: SchedulesStore;
	record(e: Omit<RoostEvent, "seq" | "at">): void;
	log(level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>): void;
	isDir(path: string): boolean;
	/** Whether a file exists (the launch's executable and entry). */
	exists(path: string): boolean;
	clock?: Clock;
	/** How often the tick looks (default 15 s). */
	tickMs?: number;
}

export type ScheduleOp =
	| "schedules"
	| "schedule-add"
	| "schedule-edit"
	| "schedule-rm"
	| "schedule-pause"
	| "schedule-run";
export const SCHEDULE_OPS: readonly ScheduleOp[] = [
	"schedules",
	"schedule-add",
	"schedule-edit",
	"schedule-rm",
	"schedule-pause",
	"schedule-run",
];

/** Decision 6: a schedule keeps this many ended, unpinned runs. */
export const RUNS_KEPT = 3;
/** Decision 4: missed slots older than this are dropped. */
export const CATCH_UP_MS = 7 * 24 * 3600_000;
/** Decision 7: what a skip records. */
export const STILL_WORKING = "previous run still working";

export interface Schedules {
	/** An op on the schedules (args as the socket brings them). */
	op(name: ScheduleOp, args: any): Promise<unknown>;
	/** A tick at once (missed slots), then the tick. */
	start(): void;
	/** Clears the tick. */
	stop(): void;
}

type Why = "due" | "catch-up" | "now";

export function createSchedules(deps: SchedulesDeps): Schedules {
	const { jobs, store, record, log } = deps;
	const clock = deps.clock ?? systemClock;
	const tickMs = deps.tickMs ?? 15_000;
	const schedules = new Map<string, Schedule>();
	/** Schedules whose run is being started (two requests at once start one). */
	const startingRuns = new Set<string>();
	let ticker: Timer | null = null;
	let pruning = false;

	function load(): void {
		const saved = store.read();
		if (!Array.isArray(saved)) return;
		for (const s of saved as Schedule[]) {
			try {
				if (!s || !SCHEDULE_NAME.test(s.name)) throw new Error("name");
				const when = parseWhen(s.when);
				checkTemplate(s.launch);
				checkTask(s.task);
				// a file edited by hand: what is missing or not a number is made good
				const now = clock.now();
				if (!Number.isFinite(s.createdAt)) s.createdAt = now;
				if (!Number.isFinite(s.anchor)) s.anchor = s.createdAt;
				s.paused = s.paused === true;
				if (s.paused || "manual" in when) s.nextAt = null;
				else if (!Number.isFinite(s.nextAt)) s.nextAt = nextRun(when, now, s.anchor);
				if (schedules.size >= SCHEDULES_MAX) throw new Error(`${SCHEDULES_MAX} schedules at most`);
				schedules.set(s.name, s);
			} catch (err) {
				log("warn", "schedule dropped", { name: s?.name, error: String(err) });
			}
		}
	}

	function save(): void {
		try {
			store.write([...schedules.values()]);
		} catch (err) {
			log("error", "schedules not saved", { error: String(err) });
		}
	}

	const row = scheduleRow;

	function get(name: unknown): Schedule {
		const s = typeof name === "string" ? schedules.get(name) : undefined;
		if (!s) throw new OpError("not_found", `no schedule named ${String(name)}`);
		return s;
	}

	function skip(s: Schedule, now: number, why: string, code: string): OpError {
		s.lastSkip = { at: now, why };
		save();
		log("info", "schedule skipped", { schedule: s.name, why });
		record({ kind: "schedule", id: s.lastJob ?? "", name: s.name, who: s.name, why: "skip", text: why });
		return new OpError(code, why);
	}

	/**
	 * One run of a schedule: a new session named after it. Skipped (said in lastSkip, never stacked) while the previous
	 * run works, or when its directory, executable or entry is gone.
	 */
	async function run(s: Schedule, now: number, why: Why): Promise<string> {
		if (startingRuns.has(s.name)) throw new OpError("busy", "a run of it is starting");
		if (jobs.stillRunning(s.lastJob)) throw skip(s, now, STILL_WORKING, "busy");
		const l = s.launch;
		if (!deps.isDir(l.cwd)) throw skip(s, now, `directory not found: ${l.cwd}`, "bad_request");
		const missing = l.command.slice(0, 2).find((p) => !deps.exists(p));
		if (missing !== undefined)
			throw skip(
				s,
				now,
				`xpi not found at ${missing}: run \`xpi roost schedule edit ${s.name}\` to update it`,
				"bad_request",
			);
		startingRuns.add(s.name);
		try {
			const r = await jobs.dispatch(
				{ ...runLaunch(l, runSlot(now)), name: s.name, requestId: undefined },
				{ schedule: s.name },
			);
			s.lastRunAt = now;
			s.lastJob = r.id;
			s.lastRunWhy = why;
			s.lastSkip = undefined;
			log("info", "schedule ran", { schedule: s.name, id: r.id, why });
			record({ kind: "schedule", id: r.id, name: r.name, who: s.name, why });
			return r.id;
		} catch (err) {
			s.lastSkip = { at: now, why: (err as Error).message };
			log("warn", "schedule run failed", { schedule: s.name, error: String(err) });
			record({
				kind: "schedule",
				id: s.lastJob ?? "",
				name: s.name,
				who: s.name,
				why: "skip",
				text: s.lastSkip.why,
			});
			throw err;
		} finally {
			startingRuns.delete(s.name);
			save();
		}
	}

	/**
	 * Decisions 4 and 7: a schedule whose `nextAt` has come. Due (on time): its run. Missed by more than two ticks: the
	 * latest slot within seven days (from the later of nextAt and seven days ago) runs once as a catch-up; older ones
	 * are dropped. Either way the next slot is the first after now, set before anything awaits.
	 */
	function due(s: Schedule, when: When, now: number): void {
		const late = now - s.nextAt! > 2 * tickMs;
		const slot = late ? latestSlot(when, Math.max(s.nextAt!, now - CATCH_UP_MS), now, s.anchor) : s.nextAt;
		const next = nextRun(when, now, s.anchor);
		// never one not ahead: it would run again on the next tick
		s.nextAt = next === null ? null : Math.max(next, now + 1000);
		if (slot === null) {
			log("info", "schedule missed", { schedule: s.name, nextAt: s.nextAt });
			save();
			return;
		}
		void run(s, now, late ? "catch-up" : "due").catch(() => {});
	}

	function tick(now = clock.now()): void {
		if (jobs.shuttingDown()) return;
		for (const s of schedules.values()) {
			if (s.paused || s.nextAt === null || now < s.nextAt) continue;
			due(s, parseWhen(s.when), now);
		}
		void prune().catch((err: unknown) => log("error", "schedule retention failed", { error: String(err) }));
	}

	/** Decision 6: the ended, unpinned runs past the newest RUNS_KEPT of each schedule go, as `rm` does. */
	async function prune(): Promise<void> {
		if (pruning) return;
		pruning = true;
		try {
			const by = new Map<string, ScheduleRun[]>();
			for (const r of jobs.runs()) {
				if (!r.ended || r.pinned) continue;
				const list = by.get(r.schedule) ?? [];
				list.push(r);
				by.set(r.schedule, list);
			}
			for (const [name, list] of by) {
				if (list.length <= RUNS_KEPT) continue;
				list.sort((a, b) => b.createdAt - a.createdAt);
				for (const r of list.slice(RUNS_KEPT)) {
					log("info", "schedule run removed", { schedule: name, id: r.id });
					await jobs.remove(r.id);
				}
			}
		} finally {
			pruning = false;
		}
	}

	function arm(): void {
		// a chain of one-shot timers (a Clock has no interval): the next is armed first, so the period is fixed and a
		// tick that throws (logged) stops nothing
		ticker = clock.timer(() => {
			if (ticker) arm();
			try {
				tick();
			} catch (err) {
				log("error", "schedule tick failed", { error: String(err) });
			}
		}, tickMs);
	}

	function badRequest<T>(fn: () => T): T {
		try {
			return fn();
		} catch (err) {
			throw new OpError("bad_request", (err as Error).message);
		}
	}

	async function op(name: ScheduleOp, args: any): Promise<unknown> {
		const now = clock.now();
		switch (name) {
			case "schedules":
				return { schedules: [...schedules.values()].sort((a, b) => a.name.localeCompare(b.name)).map(row) };
			case "schedule-add": {
				const sname = args?.name;
				if (typeof sname !== "string" || !SCHEDULE_NAME.test(sname))
					throw new OpError("bad_request", "name: 1-40 of A-Z a-z 0-9 _ . -, starting with a letter or digit");
				if (schedules.has(sname)) throw new OpError("exists", `a schedule named ${sname} exists (remove it first)`);
				if (schedules.size >= SCHEDULES_MAX) throw new OpError("limit", `${SCHEDULES_MAX} schedules at most`);
				const when = badRequest(() => parseWhen(String(args?.when ?? "")));
				const task = badRequest(() => checkTask(args?.task));
				badRequest(() => checkTemplate(args?.launch));
				if (!deps.isDir(args.launch.cwd))
					throw new OpError("bad_request", `cwd is not a directory: ${args.launch.cwd}`);
				const s: Schedule = {
					name: sname,
					when: String(args.when).trim().replace(/\s+/g, " "),
					launch: args.launch,
					...(task !== undefined ? { task } : {}),
					paused: false,
					createdAt: now,
					anchor: now,
					nextAt: nextRun(when, now, now),
				};
				schedules.set(sname, s);
				save();
				log("info", "schedule added", { name: sname, when: s.when, nextAt: s.nextAt });
				return row(s);
			}
			case "schedule-edit": {
				// decision 8: the launch is built again by the editing process; the directory stays
				const s = get(args?.name);
				const when = args?.when === undefined ? undefined : badRequest(() => parseWhen(String(args.when)));
				const task = badRequest(() => checkTask(args?.task));
				badRequest(() => checkTemplate(args?.launch));
				if (args.launch.cwd !== s.launch.cwd)
					throw new OpError(
						"bad_request",
						`a schedule's directory cannot change (${s.launch.cwd}): remove it and add it again there`,
					);
				s.launch = args.launch;
				if (task !== undefined) s.task = task;
				if (when) {
					s.when = String(args.when).trim().replace(/\s+/g, " ");
					s.anchor = now;
					s.nextAt = s.paused ? null : nextRun(when, now, now);
				}
				save();
				log("info", "schedule edited", { name: s.name, when: s.when, nextAt: s.nextAt });
				return row(s);
			}
			case "schedule-rm": {
				const s = get(args?.name);
				schedules.delete(s.name);
				save();
				log("info", "schedule removed", { name: s.name });
				return { name: s.name };
			}
			case "schedule-pause": {
				const s = get(args?.name);
				s.paused = args?.paused === true;
				// resumed: counted from now (an `every` does not fire at once for the time it was paused)
				if (!s.paused) s.anchor = now;
				s.nextAt = s.paused ? null : nextRun(parseWhen(s.when), now, s.anchor);
				save();
				return row(s);
			}
			case "schedule-run": {
				// decision 8: at once, also paused or manual; nextAt is not moved
				const s = get(args?.name);
				return { name: s.name, id: await run(s, now, "now") };
			}
		}
		throw new OpError("bad_request", `unknown op: ${String(name)}`);
	}

	load();
	return {
		op,
		start() {
			try {
				tick();
			} catch (err) {
				log("error", "schedule tick failed", { error: String(err) });
			}
			if (!ticker) arm();
		},
		stop() {
			const t = ticker;
			ticker = null;
			t?.clear();
		},
	};
}
