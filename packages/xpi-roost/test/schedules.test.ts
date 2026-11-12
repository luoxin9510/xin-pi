// Phase 2 (spec 02, from pi-roost's M67 tests): the Schedules module through its own interface: a fake jobs port, an
// in-memory store and a manual clock; no daemon, no waiting.
import { describe, expect, it } from "vitest";
import type { RoostEvent } from "../src/lib/events.ts";
import type { DispatchArgs } from "../src/lib/protocol.ts";
import type { Schedule } from "../src/lib/schedule.ts";
import {
	CATCH_UP_MS,
	createSchedules,
	type ScheduleRun,
	type Schedules,
	type SchedulesStore,
	STILL_WORKING,
} from "../src/lib/schedules.ts";
import { manualClock } from "./support/clock.ts";

const M = 60_000;
const H = 3600_000;
const D = 24 * H;
const T0 = Date.UTC(2026, 0, 5, 10, 0, 0);
const XPI = "/opt/xpi/node";
const CLI = "/opt/xpi/cli.js";

/** A launch as buildLaunch makes one: its task after `--` (none: no task). */
const template = (over: Partial<DispatchArgs> = {}, task?: string): DispatchArgs => ({
	cwd: "/work",
	sessionFile: "/sessions/{{run}}.jsonl",
	command: [XPI, CLI, "--session", "/sessions/{{run}}.jsonl", "--no-approve", ...(task ? ["--", task] : [])],
	env: { PATH: "/made/here", KEY: "k1" },
	name: "x",
	origin: "dispatch",
	...over,
});

type Log = { level: string; msg: string; extra?: Record<string, unknown> };

function setup(opts: { initial?: unknown; tickMs?: number; startAt?: number; store?: SchedulesStore } = {}) {
	const { clock, advance, pending } = manualClock(opts.startAt ?? T0);
	let saved: unknown = opts.initial;
	const store: SchedulesStore = opts.store ?? {
		read: () => (saved === undefined ? undefined : JSON.parse(JSON.stringify(saved))),
		write: (v) => {
			saved = JSON.parse(JSON.stringify(v));
		},
		setAside: () => undefined,
	};
	const events: Omit<RoostEvent, "seq" | "at">[] = [];
	const logs: Log[] = [];
	const dispatched: { launch: DispatchArgs; extra: { schedule: string; scheduleId: string } }[] = [];
	const running = new Set<string>();
	const runs: ScheduleRun[] = [];
	const removed: string[] = [];
	const files = new Set([XPI, CLI]);
	const dirs = new Set(["/work"]);
	const state = {
		shuttingDown: false,
		failWith: null as Error | null,
		gate: null as Promise<void> | null,
		n: 0,
		tickThrows: false,
		reaping: true,
	};
	const make = (): Schedules =>
		createSchedules({
			jobs: {
				async dispatch(launch, extra) {
					dispatched.push({ launch, extra });
					if (state.gate) await state.gate;
					if (state.failWith) throw state.failWith;
					const id = `job${++state.n}`;
					return { id, name: launch.name ?? "?" };
				},
				stillRunning: (id) => !!id && running.has(id),
				shuttingDown: () => {
					if (state.tickThrows) {
						state.tickThrows = false;
						throw new Error("boom");
					}
					return state.shuttingDown;
				},
				runs: () => runs.filter((r) => !removed.includes(r.id)),
				remove: async (id) => void removed.push(id),
				reaping: () => state.reaping,
			},
			store,
			record: (e) => void events.push(e),
			log: (level, msg, extra) => void logs.push({ level, msg, extra }),
			isDir: (p) => dirs.has(p),
			exists: (p) => files.has(p),
			clock,
			tickMs: opts.tickMs ?? 15_000,
		});
	return {
		clock,
		advance,
		pending,
		make,
		events,
		logs,
		dispatched,
		running,
		runs,
		removed,
		files,
		dirs,
		state,
		saved: () => saved as Schedule[],
	};
}

const saved = (over: Record<string, unknown> = {}) => ({
	id: "id-nightly",
	name: "nightly",
	when: "every 1h",
	launch: template(),
	paused: false,
	createdAt: T0 - 2 * H,
	anchor: T0 - 2 * H,
	nextAt: T0 - M,
	...over,
});

const flush = () => new Promise((r) => setTimeout(r, 0));
type Row = Record<string, unknown>;
const rows = async (s: Schedules) => ((await s.op("schedules", {})) as { schedules: Row[] }).schedules;

describe("Schedules: ops", () => {
	it("adds a schedule: the row, the file (launch and environment kept), the log; lists sorted", async () => {
		const t = setup();
		const s = t.make();
		const row = await s.op("schedule-add", {
			name: "hourly",
			when: " every  1h ",
			launch: template({ model: "m1", thinking: "low" }, "check the build"),
			task: "check the build",
		});
		expect(row).toEqual({
			name: "hourly",
			when: "every 1h",
			task: "check the build",
			cwd: "/work",
			model: "m1",
			thinking: "low",
			paused: false,
			nextAt: T0 + H,
			lastRunAt: null,
			lastJob: null,
			lastRunWhy: null,
			lastSkip: null,
		});
		expect(t.saved()).toHaveLength(1);
		expect(t.saved()[0]).toMatchObject({
			name: "hourly",
			createdAt: T0,
			anchor: T0,
			nextAt: T0 + H,
			paused: false,
			task: "check the build",
			launch: { env: { PATH: "/made/here", KEY: "k1" } },
		});
		expect(t.logs).toEqual([
			{ level: "info", msg: "schedule added", extra: { name: "hourly", when: "every 1h", nextAt: T0 + H } },
		]);
		await s.op("schedule-add", { name: "alpha", when: "manual", launch: template() });
		const list = await rows(s);
		expect(list.map((x) => [x.name, x.nextAt])).toEqual([
			["alpha", null],
			["hourly", T0 + H],
		]);
	});

	it("refuses bad adds with their codes and words", async () => {
		const t = setup();
		const s = t.make();
		const add = (a: Record<string, unknown>) =>
			s.op("schedule-add", { name: "ok", when: "every 1h", launch: template(), ...a });
		await add({});
		await expect(add({})).rejects.toMatchObject({
			code: "exists",
			message: "a schedule named ok exists (remove it first)",
		});
		await expect(add({ name: "../x" })).rejects.toMatchObject({
			code: "bad_request",
			message: "name: 1-40 of A-Z a-z 0-9 _ . -, starting with a letter or digit",
		});
		await expect(add({ name: 5 })).rejects.toMatchObject({ code: "bad_request" });
		await expect(add({ name: "b", when: "hourly" })).rejects.toMatchObject({
			code: "bad_request",
			message: expect.stringContaining("every 30m"),
		});
		await expect(add({ name: "b", when: "every 2m" })).rejects.toMatchObject({
			code: "bad_request",
			message: "every: five minutes at least",
		});
		await expect(add({ name: "c", launch: template({ sessionFile: "/work/x.jsonl" }) })).rejects.toMatchObject({
			code: "bad_request",
			message: "launch: its sessionFile must be absolute and hold {{run}}",
		});
		await expect(add({ name: "d", launch: undefined })).rejects.toMatchObject({
			code: "bad_request",
			message: "launch: missing",
		});
		// decision 9: a missing directory is refused at add
		await expect(add({ name: "e", launch: template({ cwd: "/nowhere" }) })).rejects.toMatchObject({
			code: "bad_request",
			message: "cwd is not a directory: /nowhere",
		});
		await expect(add({ name: "g", task: "check", launch: template({}, "other") })).rejects.toMatchObject({
			code: "bad_request",
			message: "launch: its task is not the schedule's task",
		});
		await expect(add({ name: "f", task: "x".repeat(64 * 1024 + 1) })).rejects.toMatchObject({
			code: "bad_request",
			message: "task: 64 KiB at most",
		});
		expect(t.saved()).toHaveLength(1);
	});

	it("limits to 50 schedules, paused ones included", async () => {
		const t = setup({
			initial: Array.from({ length: 50 }, (_, i) => saved({ name: `s${i}`, nextAt: T0 + H, paused: i % 2 === 0 })),
		});
		const s = t.make();
		await expect(s.op("schedule-add", { name: "more", when: "every 1h", launch: template() })).rejects.toMatchObject({
			code: "limit",
			message: "50 schedules at most",
		});
		await s.op("schedule-rm", { name: "s0" });
		await expect(s.op("schedule-add", { name: "more", when: "every 1h", launch: template() })).resolves.toMatchObject(
			{
				name: "more",
			},
		);
	});

	it("pauses (no next run) and resumes (counted from now); removes; unknown names are not_found", async () => {
		const t = setup();
		const s = t.make();
		await s.op("schedule-add", { name: "hourly", when: "every 1h", launch: template() });
		expect(await s.op("schedule-pause", { name: "hourly", paused: true })).toMatchObject({
			paused: true,
			nextAt: null,
		});
		t.advance(30 * M);
		expect(await s.op("schedule-pause", { name: "hourly", paused: false })).toMatchObject({
			paused: false,
			nextAt: T0 + 30 * M + H,
		});
		expect(t.saved()[0]).toMatchObject({ anchor: T0 + 30 * M, paused: false });
		// resuming one that is not paused changes nothing: its anchor and next run stay
		t.advance(10 * M);
		expect(await s.op("schedule-pause", { name: "hourly" })).toMatchObject({
			paused: false,
			nextAt: T0 + 30 * M + H,
		});
		expect(t.saved()[0]).toMatchObject({ anchor: T0 + 30 * M });
		expect(await s.op("schedule-rm", { name: "hourly" })).toEqual({ name: "hourly" });
		expect(t.saved()).toEqual([]);
		expect(t.logs.at(-1)).toEqual({ level: "info", msg: "schedule removed", extra: { name: "hourly" } });
		for (const op of ["schedule-rm", "schedule-pause", "schedule-run", "schedule-edit"] as const)
			await expect(s.op(op, { name: "hourly", launch: template() })).rejects.toMatchObject({
				code: "not_found",
				message: "no schedule named hourly",
			});
	});

	it("a manual schedule has no next run, resumed or not", async () => {
		const t = setup();
		const s = t.make();
		await s.op("schedule-add", { name: "ask", when: "manual", launch: template() });
		await s.op("schedule-pause", { name: "ask", paused: true });
		expect(await s.op("schedule-pause", { name: "ask", paused: false })).toMatchObject({ nextAt: null });
		s.start();
		t.advance(2 * D);
		await flush();
		expect(t.dispatched).toHaveLength(0);
		s.stop();
	});

	it("edit: a new launch (environment too) and task; a new rule moves the anchor and nextAt; the directory stays", async () => {
		const t = setup();
		const s = t.make();
		await s.op("schedule-add", { name: "e", when: "every 1h", launch: template({}, "one"), task: "one" });
		t.advance(20 * M);
		// no new rule: nextAt kept
		const kept = (await s.op("schedule-edit", {
			name: "e",
			launch: template({ env: { PATH: "/edited", KEY: "k2" }, model: "m2" }, "one"),
		})) as Row;
		expect(kept).toMatchObject({ task: "one", model: "m2", nextAt: T0 + H });
		expect(t.saved()[0]!.launch.env).toEqual({ PATH: "/edited", KEY: "k2" });
		expect(t.saved()[0]!.anchor).toBe(T0);
		const ruled = (await s.op("schedule-edit", {
			name: "e",
			when: "every 2h",
			task: "two",
			launch: template({}, "two"),
		})) as Row;
		expect(ruled).toMatchObject({ when: "every 2h", task: "two", nextAt: T0 + 20 * M + 2 * H });
		expect(t.saved()[0]!.anchor).toBe(T0 + 20 * M);
		await expect(s.op("schedule-edit", { name: "e", launch: template({ cwd: "/elsewhere" }) })).rejects.toMatchObject(
			{ code: "bad_request", message: expect.stringMatching(/directory cannot change/) },
		);
		await expect(s.op("schedule-edit", { name: "e", when: "every 1m", launch: template() })).rejects.toMatchObject({
			code: "bad_request",
		});
		await expect(s.op("schedule-edit", { name: "e" })).rejects.toMatchObject({
			code: "bad_request",
			message: "launch: missing",
		});
		// the task and the launch's first prompt stay one: a launch with another task is refused
		await expect(s.op("schedule-edit", { name: "e", launch: template({}, "something else") })).rejects.toMatchObject({
			code: "bad_request",
			message: "launch: its task is not the schedule's task",
		});
		await expect(
			s.op("schedule-edit", { name: "e", task: "three", launch: template({}, "two") }),
		).rejects.toMatchObject({ message: "launch: its task is not the schedule's task" });
		await expect(
			s.op("schedule-edit", { name: "e", task: "x".repeat(64 * 1024 + 1), launch: template({}, "two") }),
		).rejects.toMatchObject({ message: "task: 64 KiB at most" });
		expect(t.saved()[0]!.task).toBe("two");
		// a paused schedule's new rule leaves it paused
		await s.op("schedule-pause", { name: "e", paused: true });
		expect(
			await s.op("schedule-edit", { name: "e", when: "daily 03:00", launch: template({}, "two") }),
		).toMatchObject({
			paused: true,
			nextAt: null,
		});
	});

	it("refuses an unknown op", async () => {
		const s = setup().make();
		await expect(s.op("nope" as never, {})).rejects.toMatchObject({
			code: "bad_request",
			message: "unknown op: nope",
		});
	});

	it("a store that cannot write is logged, not thrown", async () => {
		const t = setup({
			store: {
				read: () => undefined,
				write: () => {
					throw new Error("disk full");
				},
				setAside: () => undefined,
			},
		});
		const s = t.make();
		await s.op("schedule-add", { name: "a", when: "every 1h", launch: template() });
		expect(t.logs.find((l) => l.level === "error")).toEqual({
			level: "error",
			msg: "schedules not saved",
			extra: { error: "Error: disk full" },
		});
	});
});

describe("Schedules: runs", () => {
	it("run now: a session named after the schedule with a fresh session file and its stored environment; nextAt untouched", async () => {
		const t = setup();
		const s = t.make();
		await s.op("schedule-add", { name: "check", when: "daily 03:00", launch: template() });
		const before = await rows(s);
		const r = await s.op("schedule-run", { name: "check" });
		expect(r).toEqual({ name: "check", id: "job1" });
		const d = t.dispatched[0]!;
		expect(d.extra).toEqual({ schedule: "check", scheduleId: t.saved()[0]!.id });
		expect(t.saved()[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
		expect(d.launch).toMatchObject({
			name: "check",
			requestId: undefined,
			cwd: "/work",
			env: { PATH: "/made/here" },
		});
		expect(d.launch.sessionFile).toMatch(/^\/sessions\/2026-01-05T10-00-00-000Z_[0-9a-f-]{36}\.jsonl$/);
		expect(d.launch.command[3]).toBe(d.launch.sessionFile);
		expect(t.events).toEqual([{ kind: "schedule", id: "job1", name: "check", who: "check", why: "now" }]);
		expect((await rows(s))[0]).toMatchObject({
			nextAt: before[0]!.nextAt,
			lastRunAt: T0,
			lastJob: "job1",
			lastRunWhy: "now",
			lastSkip: null,
		});
		// every run its own file
		await s.op("schedule-run", { name: "check" });
		expect(t.dispatched[1]!.launch.sessionFile).not.toBe(d.launch.sessionFile);
		expect(t.dispatched[1]!.launch.env).toEqual(d.launch.env);
	});

	it("run now works for a paused or manual schedule", async () => {
		const t = setup();
		const s = t.make();
		await s.op("schedule-add", { name: "m", when: "manual", launch: template() });
		await s.op("schedule-add", { name: "p", when: "every 1h", launch: template() });
		await s.op("schedule-pause", { name: "p", paused: true });
		await s.op("schedule-run", { name: "m" });
		await s.op("schedule-run", { name: "p" });
		expect(t.dispatched.map((d) => d.extra.schedule)).toEqual(["m", "p"]);
		expect((await rows(s)).map((r) => r.nextAt)).toEqual([null, null]);
	});

	it("run now while the previous run works: busy, said in lastSkip and the log", async () => {
		const t = setup();
		const s = t.make();
		await s.op("schedule-add", { name: "check", when: "daily 03:00", launch: template() });
		await s.op("schedule-run", { name: "check" });
		t.running.add("job1");
		t.advance(5000);
		await expect(s.op("schedule-run", { name: "check" })).rejects.toMatchObject({
			code: "busy",
			message: STILL_WORKING,
		});
		const row = (await rows(s))[0]!;
		expect(row.lastSkip).toEqual({ at: T0 + 5000, why: "previous run still working" });
		expect(row.lastJob).toBe("job1");
		expect(t.saved()[0]!.lastSkip).toEqual({ at: T0 + 5000, why: "previous run still working" });
		expect(t.events.at(-1)).toEqual({
			kind: "schedule",
			id: "job1",
			name: "check",
			who: "check",
			why: "skip",
			text: "previous run still working",
		});
		expect(t.dispatched).toHaveLength(1);
		t.running.clear();
		await s.op("schedule-run", { name: "check" });
		expect(t.dispatched).toHaveLength(2);
		expect(t.saved()[0]!.lastSkip).toBeUndefined();
		expect(t.saved()[0]!.lastJob).toBe("job2");
	});

	it("two runs asked at once start one; the other is busy", async () => {
		const t = setup();
		const s = t.make();
		await s.op("schedule-add", { name: "twice", when: "daily 03:00", launch: template() });
		let open!: () => void;
		t.state.gate = new Promise<void>((r) => {
			open = r;
		});
		const both = Promise.allSettled([
			s.op("schedule-run", { name: "twice" }),
			s.op("schedule-run", { name: "twice" }),
		]);
		await flush();
		open();
		const res = await both;
		expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		expect(res.find((r) => r.status === "rejected")).toMatchObject({
			reason: { code: "busy", message: STILL_WORKING },
		});
		expect(t.dispatched).toHaveLength(1);
	});

	it("a slot that comes while a run-now is still starting is skipped and recorded", async () => {
		const t = setup({ initial: [saved({ nextAt: T0 + 10_000 })] });
		const s = t.make();
		let open!: () => void;
		t.state.gate = new Promise<void>((r) => {
			open = r;
		});
		const now = s.op("schedule-run", { name: "nightly" });
		s.start();
		t.advance(15_000);
		await flush();
		expect(t.saved()[0]!.lastSkip).toEqual({ at: T0 + 15_000, why: STILL_WORKING });
		expect(t.events.at(-1)).toMatchObject({ why: "skip", text: STILL_WORKING });
		open();
		await now;
		expect(t.dispatched).toHaveLength(1);
		s.stop();
	});

	it("a dispatch that fails is said in lastSkip, logged and recorded; the next try is not held", async () => {
		const t = setup();
		const s = t.make();
		await s.op("schedule-add", { name: "bad", when: "daily 03:00", launch: template() });
		t.state.failWith = new Error("could not start host process");
		await expect(s.op("schedule-run", { name: "bad" })).rejects.toThrow("could not start host process");
		expect(t.saved()[0]!.lastSkip).toEqual({ at: T0, why: "could not start host process" });
		expect(t.logs.at(-1)).toEqual({
			level: "warn",
			msg: "schedule run failed",
			extra: { schedule: "bad", error: "Error: could not start host process" },
		});
		expect(t.events).toEqual([
			{ kind: "schedule", id: "", name: "bad", who: "bad", why: "skip", text: "could not start host process" },
		]);
		t.state.failWith = null;
		await expect(s.op("schedule-run", { name: "bad" })).resolves.toMatchObject({ id: "job1" });
	});

	it("a directory gone since it was added skips the run with that reason", async () => {
		const t = setup();
		const s = t.make();
		await s.op("schedule-add", { name: "d", when: "every 1h", launch: template() });
		t.dirs.clear();
		await expect(s.op("schedule-run", { name: "d" })).rejects.toMatchObject({
			message: "directory not found: /work",
		});
		s.start();
		t.advance(H);
		await flush();
		expect(t.dispatched).toHaveLength(0);
		expect(t.saved()[0]!.lastSkip).toEqual({ at: T0 + H, why: "directory not found: /work" });
		expect(t.saved()[0]!.nextAt).toBe(T0 + 2 * H);
		s.stop();
	});

	it("an executable or entry gone (xpi moved) skips the run and says to edit the schedule", async () => {
		const t = setup();
		const s = t.make();
		await s.op("schedule-add", { name: "x", when: "every 1h", launch: template() });
		t.files.delete(CLI);
		await expect(s.op("schedule-run", { name: "x" })).rejects.toMatchObject({
			message: `xpi not found at ${CLI}: run \`xpi roost schedule edit x\` to update it`,
		});
		t.files.add(CLI);
		t.files.delete(XPI);
		await expect(s.op("schedule-run", { name: "x" })).rejects.toMatchObject({
			message: expect.stringContaining(`xpi not found at ${XPI}`),
		});
		expect(t.dispatched).toHaveLength(0);
	});

	it("starts a run when its slot comes due on the tick, then keeps its rhythm", async () => {
		const t = setup({ initial: [saved({ nextAt: T0 + 40_000 })], tickMs: 15_000 });
		const s = t.make();
		s.start();
		t.advance(30_000);
		await flush();
		expect(t.dispatched).toHaveLength(0);
		t.advance(30_000); // ticks at 45 s: due since 40 s
		await flush();
		expect(t.dispatched).toHaveLength(1);
		expect(t.events).toEqual([{ kind: "schedule", id: "job1", name: "nightly", who: "nightly", why: "due" }]);
		const row = t.saved()[0]!;
		expect(row).toMatchObject({ lastRunAt: T0 + 45_000, lastJob: "job1", lastRunWhy: "due", nextAt: T0 + H });
		t.advance(H - 75_000);
		await flush();
		expect(t.dispatched).toHaveLength(1);
		t.advance(15_000);
		await flush();
		expect(t.dispatched).toHaveLength(2);
		expect(t.saved()[0]!.nextAt).toBe(T0 + 2 * H);
		s.stop();
	});

	it("the next slot is set at least a second ahead of the run", async () => {
		const t = setup({
			initial: [saved({ when: "every 5m", anchor: T0 + 15_000 + 500 - 5 * M, nextAt: T0 + 10_000 })],
			tickMs: 15_000,
		});
		const s = t.make();
		s.start();
		t.advance(15_000);
		await flush();
		expect(t.dispatched).toHaveLength(1);
		expect(t.saved()[0]!.nextAt).toBe(T0 + 15_000 + 1000);
		s.stop();
	});

	it("a tick that throws is logged and the next tick still comes", async () => {
		const t = setup({ initial: [saved({ nextAt: T0 + 20_000 })], tickMs: 15_000 });
		const s = t.make();
		s.start();
		t.state.tickThrows = true;
		t.advance(15_000);
		await flush();
		expect(t.logs).toContainEqual({ level: "error", msg: "schedule tick failed", extra: { error: "Error: boom" } });
		expect(t.pending()).toBe(1);
		t.advance(15_000);
		await flush();
		expect(t.dispatched).toHaveLength(1);
		s.stop();
	});

	it("a due slot whose previous run works is skipped: lastSkip, an event, next slot kept", async () => {
		const t = setup({ initial: [saved({ nextAt: T0 + 10_000, lastJob: "old" })] });
		t.running.add("old");
		const s = t.make();
		s.start();
		t.advance(15_000);
		await flush();
		expect(t.dispatched).toHaveLength(0);
		expect(t.saved()[0]).toMatchObject({
			lastSkip: { at: T0 + 15_000, why: STILL_WORKING },
			nextAt: T0 + H,
			lastJob: "old",
		});
		expect(t.events).toEqual([
			{ kind: "schedule", id: "old", name: "nightly", who: "nightly", why: "skip", text: STILL_WORKING },
		]);
		t.running.clear();
		t.advance(H);
		await flush();
		expect(t.dispatched).toHaveLength(1);
		expect(t.saved()[0]!.lastSkip).toBeUndefined();
		s.stop();
	});

	it("a previous run waiting for an answer (not working) does not hold the schedule back", async () => {
		// stillRunning is the daemon's: a blocked run is not in it; here the fake says not running
		const t = setup({ initial: [saved({ nextAt: T0 + 10_000, lastJob: "asking" })] });
		const s = t.make();
		s.start();
		t.advance(15_000);
		await flush();
		expect(t.dispatched).toHaveLength(1);
		s.stop();
	});

	it("a paused schedule does not run; a resumed one runs on its new rhythm", async () => {
		const t = setup({ initial: [saved({ nextAt: T0 + 10_000 })] });
		const s = t.make();
		s.start();
		await s.op("schedule-pause", { name: "nightly", paused: true });
		t.advance(2 * H);
		await flush();
		expect(t.dispatched).toHaveLength(0);
		await s.op("schedule-pause", { name: "nightly", paused: false });
		t.advance(H - 1);
		await flush();
		expect(t.dispatched).toHaveLength(0);
		t.advance(15_000);
		await flush();
		expect(t.dispatched).toHaveLength(1);
		s.stop();
	});

	it("a removed schedule does not run; a tick while the daemon goes down starts nothing", async () => {
		const t = setup({ initial: [saved({ nextAt: T0 + 10_000 }), saved({ name: "other", nextAt: T0 + 10_000 })] });
		const s = t.make();
		s.start();
		await s.op("schedule-rm", { name: "nightly" });
		t.state.shuttingDown = true;
		t.advance(H);
		await flush();
		expect(t.dispatched).toHaveLength(0);
		s.stop();
	});

	it("stop() clears the tick: nothing runs after it, no timer waits", async () => {
		const t = setup({ initial: [saved({ nextAt: T0 + 10_000 })] });
		const s = t.make();
		expect(t.pending()).toBe(0);
		s.start();
		expect(t.pending()).toBe(1);
		t.advance(5000);
		s.stop();
		expect(t.pending()).toBe(0);
		t.advance(H);
		await flush();
		expect(t.dispatched).toHaveLength(0);
		s.start();
		s.start();
		expect(t.pending()).toBe(1);
		s.stop();
	});
});

describe("Schedules: missed slots (decision 4)", () => {
	it("at start: a slot missed within 7 days runs once as a catch-up; nextAt the first slot after now", async () => {
		const t = setup({
			initial: [saved({ name: "missed", nextAt: T0 - 3 * H }), saved({ name: "ahead", nextAt: T0 + H })],
		});
		const s = t.make();
		s.start();
		await flush();
		expect(t.dispatched.map((d) => d.extra.schedule)).toEqual(["missed"]);
		expect(t.events).toEqual([{ kind: "schedule", id: "job1", name: "missed", who: "missed", why: "catch-up" }]);
		const by = Object.fromEntries(t.saved().map((x) => [x.name, x]));
		expect(by.missed).toMatchObject({ lastRunAt: T0, lastJob: "job1", lastRunWhy: "catch-up", nextAt: T0 + H });
		expect(by.ahead!.nextAt).toBe(T0 + H);
		expect((await rows(s)).find((r) => r.name === "missed")).toMatchObject({ lastRunWhy: "catch-up" });
		// not twice on the next tick
		t.advance(15_000);
		await flush();
		expect(t.dispatched).toHaveLength(1);
		s.stop();
	});

	it("a slot missed more than 7 days ago is dropped: no run, nextAt the first slot after now", async () => {
		const t = setup({
			// its one slot a year, ten days before T0
			initial: [
				saved({ when: 'cron "0 9 26 12 *"', nextAt: new Date(2025, 11, 26, 9).getTime(), anchor: T0 - 30 * D }),
			],
		});
		const s = t.make();
		s.start();
		await flush();
		expect(t.dispatched).toHaveLength(0);
		expect(t.saved()[0]!.nextAt).toBe(new Date(2026, 11, 26, 9, 0).getTime());
		expect(t.logs).toContainEqual(expect.objectContaining({ msg: "schedule missed" }));
		s.stop();
	});

	it("searches from max(nextAt, now - 7 d): the latest slot within 7 days runs once even when nextAt is older", async () => {
		// daily, its nextAt 20 days back: slots within the last 7 days exist
		const t = setup({ initial: [saved({ when: "daily 09:00", nextAt: T0 - 20 * D, anchor: T0 - 30 * D })] });
		const s = t.make();
		s.start();
		await flush();
		expect(t.dispatched).toHaveLength(1);
		expect(t.saved()[0]).toMatchObject({ lastRunWhy: "catch-up" });
		expect(t.saved()[0]!.nextAt! > T0).toBe(true);
		s.stop();
		expect(CATCH_UP_MS).toBe(7 * D);
	});

	it("after a sleep: a tick that comes late by more than two ticks runs once as a catch-up", async () => {
		const t = setup({ initial: [saved({ when: "every 1h", nextAt: T0 + H, anchor: T0 })], tickMs: 15_000 });
		const s = t.make();
		s.start();
		await flush();
		expect(t.dispatched).toHaveLength(0);
		// the machine sleeps: the tick's timer fires five hours late (no timer in between)
		s.stop();
		t.advance(5 * H + 30 * M);
		s.start();
		await flush();
		expect(t.dispatched).toHaveLength(1);
		expect(t.events.at(-1)).toMatchObject({ why: "catch-up" });
		expect(t.saved()[0]!.nextAt).toBe(T0 + 6 * H);
		s.stop();
	});

	it("a catch-up is skipped like any run while the previous run works", async () => {
		const t = setup({ initial: [saved({ nextAt: T0 - 3 * H, lastJob: "old" })] });
		t.running.add("old");
		const s = t.make();
		s.start();
		await flush();
		expect(t.dispatched).toHaveLength(0);
		expect(t.saved()[0]).toMatchObject({ lastSkip: { why: STILL_WORKING }, nextAt: T0 + H });
		s.stop();
	});

	it("a paused schedule is left alone", async () => {
		const t = setup({ initial: [saved({ paused: true, nextAt: null })] });
		const s = t.make();
		s.start();
		t.advance(H);
		await flush();
		expect(t.dispatched).toHaveLength(0);
		s.stop();
	});
});

describe("Schedules: retention (decision 6)", () => {
	const run = (id: string, createdAt: number, over: Partial<ScheduleRun> = {}): ScheduleRun => ({
		id,
		scheduleId: "id-nightly",
		createdAt,
		state: "ended",
		live: false,
		pinned: false,
		...over,
	});

	it("keeps 3 ended unpinned runs per schedule; older ones go; pinned and running ones do not count", async () => {
		const t = setup({ initial: [saved({ nextAt: T0 + D })] });
		t.runs.push(
			run("r1", 1),
			run("r2", 2),
			run("r3", 3, { pinned: true }),
			run("r4", 4),
			run("r5", 5, { state: "running" }),
			run("r6", 6),
			run("r7", 7),
		);
		const s = t.make();
		s.start();
		await flush();
		// ended and unpinned: r7 r6 r4 kept, r2 r1 go; r3 (pinned) and r5 (running) stay
		expect(t.removed).toEqual(["r2", "r1"]);
		s.stop();
	});

	it("a restarted run counts as running until it ends again", async () => {
		const t = setup({ initial: [saved({ nextAt: T0 + D })] });
		t.runs.push(run("r1", 1), run("r2", 2), run("r3", 3), run("r4", 4, { state: "running" }));
		const s = t.make();
		s.start();
		await flush();
		expect(t.removed).toEqual([]);
		t.runs[3]!.state = "ended";
		t.advance(15_000);
		await flush();
		expect(t.removed).toEqual(["r1"]);
		s.stop();
	});

	it("runs that ended on a question and have no process count as ended, except the schedule's last run", async () => {
		const t = setup({ initial: [saved({ nextAt: T0 + D, lastJob: "q5" })] });
		t.runs.push(
			run("q1", 1, { state: "asking" }),
			run("q2", 2, { state: "asking" }),
			run("q3", 3, { state: "asking" }),
			run("q4", 4, { state: "asking" }),
			run("q5", 5, { state: "asking" }),
		);
		const s = t.make();
		s.start();
		await flush();
		// q5 is the last run (the list's Needs input): it stays and does not count; q4 q3 q2 kept, q1 goes
		expect(t.removed).toEqual(["q1"]);
		s.stop();
	});

	it("only the schedules there are, by id: a removed schedule's runs stay, a new one of its name does not take them", async () => {
		const t = setup({ initial: [saved({ nextAt: T0 + D })] });
		for (let i = 1; i <= 5; i++) t.runs.push(run(`r${i}`, i));
		const s = t.make();
		await s.op("schedule-rm", { name: "nightly" });
		await s.op("schedule-add", { name: "nightly", when: "manual", launch: template() });
		expect(t.saved()[0]!.id).not.toBe("id-nightly");
		s.start();
		await flush();
		expect(t.removed).toEqual([]);
		s.stop();
	});

	it("an old run whose worker still waits idle goes once it has exited; at once when nothing reaps", async () => {
		const t = setup({ initial: [saved({ nextAt: T0 + D })] });
		t.runs.push(run("r1", 1, { live: true }), run("r2", 2), run("r3", 3), run("r4", 4), run("r5", 5));
		const s = t.make();
		s.start();
		await flush();
		expect(t.removed).not.toContain("r1");
		expect(t.removed).toEqual(["r2"]);
		t.runs[0]!.live = false;
		t.advance(15_000);
		await flush();
		expect(t.removed).toEqual(["r2", "r1"]);
		s.stop();
		const u = setup({ initial: [saved({ nextAt: T0 + D })] });
		u.state.reaping = false;
		u.runs.push(run("r1", 1, { live: true }), run("r2", 2), run("r3", 3), run("r4", 4));
		const v = u.make();
		v.start();
		await flush();
		expect(u.removed).toEqual(["r1"]);
		v.stop();
	});
});

describe("Schedules: start and the file", () => {
	it("an entry this daemon cannot run is not loaded, logged, and kept in the file as it was", async () => {
		const unknown = [
			saved({ name: "badwhen", when: "hourly" }),
			saved({ name: "floor", when: "every 1m" }),
			saved({ name: "badlaunch", launch: { cwd: "/work" } }),
			saved({ name: "../evil" }),
			null,
			{ name: "future", when: "fortnightly", launch: template(), something: "new" },
		];
		const t = setup({ initial: [saved({ name: "good" }), ...unknown] });
		const s = t.make();
		const list = (await s.op("schedules", {})) as { schedules: Row[]; unread?: number };
		expect(list.schedules.map((x) => x.name)).toEqual(["good"]);
		expect(list.unread).toBe(6);
		expect(t.logs.filter((l) => l.level === "warn").map((w) => w.extra?.name)).toEqual([
			"badwhen",
			"floor",
			"badlaunch",
			"../evil",
			undefined,
			"future",
		]);
		// a save writes them back unchanged
		await s.op("schedule-pause", { name: "good", paused: true });
		expect(t.saved().slice(1)).toEqual(unknown);
		// a name one of them has is not taken
		await expect(s.op("schedule-add", { name: "future", when: "manual", launch: template() })).rejects.toMatchObject({
			code: "exists",
			message: expect.stringContaining("cannot read"),
		});
	});

	it("a file that cannot be read or is not a list is moved aside, said in the list and the log; the daemon starts with none", async () => {
		for (const read of [
			() => {
				throw new SyntaxError("Unexpected token } in JSON");
			},
			() => ({ schedules: [] }),
		]) {
			const asides: string[] = [];
			let written: unknown;
			const t = setup({
				store: {
					read,
					write: (v) => {
						written = v;
					},
					setAside: () => {
						asides.push("x");
						return "/home/schedules.json.bad-T";
					},
				},
			});
			const s = t.make();
			const list = (await s.op("schedules", {})) as { schedules: Row[]; problem?: string };
			expect(list.schedules).toEqual([]);
			expect(list.problem).toMatch(
				/^schedules\.json could not be read \(.+\); it was moved to \/home\/schedules\.json\.bad-T; no schedules were loaded$/,
			);
			expect(asides).toHaveLength(1);
			expect(written).toBeUndefined();
			expect(t.logs).toContainEqual(expect.objectContaining({ level: "warn", msg: "schedules file unreadable" }));
		}
	});

	it("a file that cannot be moved aside is never written over until the daemon starts again", async () => {
		let writes = 0;
		const t = setup({
			store: {
				read: () => {
					throw new SyntaxError("Unexpected end of JSON input");
				},
				write: () => {
					writes++;
				},
				setAside: () => {
					throw new Error("EACCES");
				},
			},
		});
		const s = t.make();
		const list = (await s.op("schedules", {})) as { problem?: string };
		expect(list.problem).toMatch(/could not be moved aside, so changes are not saved until the daemon restarts$/);
		await s.op("schedule-add", { name: "new", when: "manual", launch: template() });
		await s.op("schedule-run", { name: "new" });
		expect(writes).toBe(0);
		expect(t.logs).toContainEqual(expect.objectContaining({ level: "error", msg: "schedules file not moved aside" }));
	});

	it("more than 50 in the file: 50 are loaded, the rest kept", async () => {
		const t = setup({ initial: Array.from({ length: 52 }, (_, i) => saved({ name: `s${i}`, id: `id${i}` })) });
		const s = t.make();
		expect(await rows(s)).toHaveLength(50);
		await s.op("schedule-pause", { name: "s0", paused: true });
		expect(t.saved()).toHaveLength(52);
	});

	it("an entry without an id gets one, saved", async () => {
		const t = setup({ initial: [{ name: "old", when: "every 1h", launch: template() }] });
		t.make();
		expect(t.saved()[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
	});

	it("an entry edited by hand is made good: missing times, flags", async () => {
		const t = setup({
			initial: [
				{ name: "hand", when: "every 1h", launch: template() },
				saved({ name: "rest", paused: true, nextAt: 5 }),
				saved({ name: "man", when: "manual", nextAt: 5 }),
			],
		});
		const s = t.make();
		const list = await rows(s);
		expect(list.find((r) => r.name === "hand")).toMatchObject({ paused: false, nextAt: T0 + H });
		expect(list.find((r) => r.name === "rest")).toMatchObject({ paused: true, nextAt: null });
		expect(list.find((r) => r.name === "man")).toMatchObject({ nextAt: null });
	});

	it("a restart (a new module over the same store) keeps the schedules, their pause and their last run", async () => {
		const t = setup();
		const first = t.make();
		await first.op("schedule-add", { name: "kept", when: "weekdays 09:00", launch: template() });
		await first.op("schedule-add", { name: "resting", when: "every 1h", launch: template() });
		await first.op("schedule-pause", { name: "resting", paused: true });
		await first.op("schedule-run", { name: "kept" });
		first.stop();
		const second = t.make();
		expect((await rows(second)).map((r) => [r.name, r.paused, r.lastJob])).toEqual([
			["kept", false, "job1"],
			["resting", true, null],
		]);
		second.start();
		t.advance(2 * H);
		await flush();
		expect(t.dispatched.filter((d) => d.extra.schedule === "resting")).toHaveLength(0);
		second.stop();
	});
});
