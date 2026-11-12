// Phase 2 (spec 02, decision 8): the schedules overlay on its own: a fake port, a fake host.
import { afterEach, describe, expect, it, vi } from "vitest";
import { visibleWidth } from "xpi-tui";
import { createSchedulesOverlay, type SchedulesOpts } from "../src/hub/overlays/schedules.ts";
import type { DispatchArgs, JobRow, ScheduleRow } from "../src/lib/protocol.ts";
import { fakeHost, tick } from "./support/overlay-host.ts";
import { KEY } from "./support/overlay-keys.ts";
import { fakePort } from "./support/roost-port.ts";

const NOW = 1_800_000_000_000;
const M = 60_000;
afterEach(() => vi.useRealTimers());

const sched = (over: Partial<ScheduleRow> = {}): ScheduleRow => ({
	name: "nightly",
	when: "daily 03:00",
	task: "check the build",
	cwd: "/home/u/proj",
	model: null,
	thinking: null,
	paused: false,
	nextAt: NOW + 125 * M,
	lastRunAt: NOW - 3 * 60 * M,
	lastJob: "abcd1234",
	lastRunWhy: "catch-up",
	lastSkip: null,
	...over,
});

const launch = (s: ScheduleRow): DispatchArgs => ({
	cwd: s.cwd,
	sessionFile: "/s/{{run}}.jsonl",
	command: ["node", "xpi", "--session", "/s/{{run}}.jsonl", "--", s.task ?? ""],
	env: { PATH: "/rebuilt" },
	name: s.name,
	origin: "dispatch",
});

async function open(list: () => ScheduleRow[], opts: SchedulesOpts = { rebuild: launch }, problem?: string) {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
	const p = fakePort({
		"schedules.list": async () => ({ schedules: list(), ...(problem ? { problem } : {}) }),
		"schedules.run": async () => ({ name: "nightly", id: "job9" }),
		"schedules.pause": async (name: string, paused: boolean) => ({
			...sched({ name }),
			paused,
			nextAt: paused ? null : NOW + 60 * M,
		}),
		"schedules.edit": async (a: { name: string; when: string }) => ({ ...sched({ name: a.name, when: a.when }) }),
		"schedules.rm": async (name: string) => ({ name }),
	});
	const h = fakeHost(p.port);
	const overlay = await createSchedulesOverlay(h.host, opts);
	return { ...h, overlay: overlay!, maybe: overlay, calls: p.calls };
}

const two = () => [
	sched(),
	sched({
		name: "ask",
		when: "manual",
		nextAt: null,
		paused: true,
		lastRunAt: null,
		lastJob: null,
		lastRunWhy: null,
		lastSkip: { at: NOW - 5 * M, why: "previous run still working" },
	}),
];

describe("phase 2: the schedules overlay", () => {
	it("each schedule: rule, next run, last run (catch-up marked), task, directory, the last skip; the keys", async () => {
		const { overlay } = await open(two);
		expect(overlay.render(140)).toEqual([
			"Schedules",
			"",
			"› nightly  daily 03:00  · next in 2h 05m · last 3h ago (catch-up)",
			"    check the build · /home/u/proj",
			"  ask  manual  · paused · not run yet",
			"    check the build · /home/u/proj",
			"    skipped 5m ago: previous run still working",
			"",
			"Enter run now · p pause · e edit the rule · x remove · r reload · Esc close",
		]);
		for (const w of [20, 60]) for (const l of overlay.render(w)) expect(visibleWidth(l)).toBeLessThanOrEqual(w);
	});

	it("none: says how to add one; a list that cannot be read: says why; a file problem is said", async () => {
		const empty = await open(() => []);
		expect(empty.maybe).toBeUndefined();
		expect(empty.texts()[0]).toMatch(/^no schedules: \/schedule <name> <every 30m/);
		const bad = await open(() => {
			throw new Error("background service unavailable");
		});
		expect(bad.maybe).toBeUndefined();
		expect(bad.said).toEqual([{ text: "background service unavailable", tone: "error" }]);
		const moved = await open(two, { rebuild: launch }, "schedules.json could not be read (x); it was moved to /h/b");
		expect(moved.overlay.render(140)[1]).toBe("schedules.json could not be read (x); it was moved to /h/b");
	});

	it("Enter runs the selected one now; p pauses or resumes it; each says what happened and reads the list again", async () => {
		const { overlay, calls, texts } = await open(two);
		overlay.handleInput!(KEY.enter);
		await tick();
		expect(calls.filter((c) => c.path === "schedules.run")).toEqual([{ path: "schedules.run", args: ["nightly"] }]);
		expect(texts()).toContain("nightly: started job9");
		// said above the keys (the view's notice row is under the overlay)
		expect(overlay.render(140).slice(-2)).toEqual([
			"nightly: started job9",
			"Enter run now · p pause · e edit the rule · x remove · r reload · Esc close",
		]);
		overlay.handleInput!(KEY.down);
		expect(overlay.render(140).at(-1)).toContain("p resume");
		overlay.handleInput!("p");
		await tick();
		expect(calls.filter((c) => c.path === "schedules.pause")).toEqual([
			{ path: "schedules.pause", args: ["ask", false] },
		]);
		expect(texts()).toContain("ask: resumed, next run in 1h 00m");
		expect(calls.filter((c) => c.path === "schedules.list")).toHaveLength(3);
	});

	it("a refusal (busy) is said as a warning", async () => {
		const failing = fakePort({
			"schedules.list": async () => ({ schedules: two() }),
			"schedules.run": async () => {
				throw new Error("previous run still working");
			},
		});
		const h = fakeHost(failing.port);
		const o = (await createSchedulesOverlay(h.host, { rebuild: launch }))!;
		o.handleInput!(KEY.enter);
		await tick();
		expect(h.said).toEqual([{ text: "nightly: previous run still working", tone: "warning" }]);
	});

	it("e edits the rule: typed in place, checked, sent with the launch built again here", async () => {
		const { overlay, calls, said } = await open(two);
		overlay.handleInput!("e");
		expect(overlay.render(140).slice(-2)).toEqual(["rule for nightly: daily 03:00▏", "Enter save · Esc cancel"]);
		for (let i = 0; i < "daily 03:00".length; i++) overlay.handleInput!("\x7f");
		for (const ch of "every 1m") overlay.handleInput!(ch);
		overlay.handleInput!(KEY.enter);
		// refused here, before anything is sent: the field stays
		expect(said.at(-1)).toEqual({ text: "every: five minutes at least", tone: "warning" });
		expect(overlay.render(140).at(-2)).toBe("rule for nightly: every 1m▏");
		overlay.handleInput!("\x7f");
		overlay.handleInput!("\x7f");
		for (const ch of "2h") overlay.handleInput!(ch);
		overlay.handleInput!(KEY.enter);
		await tick();
		const edit = calls.filter((c) => c.path === "schedules.edit");
		expect(edit).toEqual([
			{ path: "schedules.edit", args: [{ name: "nightly", when: "every 2h", launch: launch(sched()) }] },
		]);
		// Esc leaves the field without closing the overlay
		overlay.handleInput!("e");
		overlay.handleInput!(KEY.esc);
		expect(overlay.render(140).at(-1)).toContain("Enter run now");
	});

	it("e without a way to build the launch says so; x removes after a second press", async () => {
		const { overlay, calls, texts } = await open(two, {});
		overlay.handleInput!("e");
		expect(texts().at(-1)).toBe("editing is not available here");
		overlay.handleInput!("x");
		expect(calls.filter((c) => c.path === "schedules.rm")).toEqual([]);
		expect(texts().at(-1)).toBe("x again to remove nightly (its runs stay listed)");
		overlay.handleInput!("x");
		await tick();
		expect(calls.filter((c) => c.path === "schedules.rm")).toEqual([{ path: "schedules.rm", args: ["nightly"] }]);
	});

	it("Esc, Ctrl+C and q close it", async () => {
		for (const k of [KEY.esc, KEY.ctrlC, "q"]) {
			const { overlay, log } = await open(two);
			overlay.handleInput!(k);
			expect(log.closes).toBe(1);
		}
	});

	it("decision 8: the last run's result, from its row in the hub; nothing when it is no longer listed", async () => {
		const { overlay, rows } = await open(() => [sched(), sched({ name: "b", lastJob: "gone" })]);
		const r = (state: JobRow["state"]) => ({ id: "abcd1234", state }) as JobRow;
		rows.set("abcd1234", r("failed"));
		expect(overlay.render(140)[2]).toBe("› nightly  daily 03:00  · next in 2h 05m · last 3h ago (catch-up): failed");
		rows.set("abcd1234", r("blocked"));
		expect(overlay.render(140)[2]).toMatch(/\(catch-up\): needs input$/);
		rows.set("abcd1234", r("working"));
		expect(overlay.render(140)[2]).toMatch(/: working$/);
		rows.set("abcd1234", r("done"));
		expect(overlay.render(140)[2]).toMatch(/: done$/);
		// "gone" is not a row: no result
		expect(overlay.render(140)[4]).toBe("  b  daily 03:00  · next in 2h 05m · last 3h ago (catch-up)");
	});

	it("the rule field takes a bracketed paste (one line) and kitty-encoded keys", async () => {
		const { overlay, calls } = await open(two);
		overlay.handleInput!("e");
		for (let i = 0; i < "daily 03:00".length; i++) overlay.handleInput!("\x7f");
		overlay.handleInput!("\x1b[200~every\n2\x1b[201~");
		// "h" as a kitty terminal sends it (CSI-u), then its release, which types nothing
		overlay.handleInput!("\x1b[104u");
		overlay.handleInput!("\x1b[104;1:3u");
		expect(overlay.render(140).at(-2)).toBe("rule for nightly: every 2h▏");
		overlay.handleInput!(KEY.enter);
		await tick();
		expect(calls.filter((c) => c.path === "schedules.edit")[0]!.args[0]).toMatchObject({ when: "every 2h" });
	});

	it("x's second press must come on the same schedule: moving the selection starts again", async () => {
		const { overlay, calls, texts } = await open(two);
		overlay.handleInput!("x");
		overlay.handleInput!(KEY.down);
		overlay.handleInput!("x");
		await tick();
		expect(calls.filter((c) => c.path === "schedules.rm")).toEqual([]);
		expect(texts().at(-1)).toBe("x again to remove ask (its runs stay listed)");
		overlay.handleInput!("x");
		await tick();
		expect(calls.filter((c) => c.path === "schedules.rm")).toEqual([{ path: "schedules.rm", args: ["ask"] }]);
	});

	it("the last one removed closes the overlay, only when it is the one shown", async () => {
		for (const shown of [true, false]) {
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(NOW);
			let left = [sched()];
			const p = fakePort({
				"schedules.list": async () => ({ schedules: left }),
				"schedules.rm": async (name: string) => {
					left = [];
					return { name };
				},
			});
			const h = fakeHost(p.port);
			const o = (await createSchedulesOverlay(h.host, { rebuild: launch }))!;
			if (shown) h.mount(o);
			o.handleInput!("x");
			o.handleInput!("x");
			await tick(20);
			expect(h.texts()).toContain("no schedules left");
			expect(h.log.closes, String(shown)).toBe(shown ? 1 : 0);
		}
	});
});
