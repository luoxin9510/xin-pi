// Phase 2 (spec 02): a schedule's rule and slots, ported from pi-roost's schedule tests, with weekly, manual, the
// 5-minute floor and the 64 KiB task.
import { describe, expect, it } from "vitest";
import {
	checkTask,
	checkTemplate,
	closestMinutes,
	latestSlot,
	nextCron,
	nextRun,
	parseCron,
	parseScheduleInput,
	parseWhen,
	RUN_SLOT,
	runLaunch,
	runSlot,
	SCHEDULE_NAME,
	splitWhen,
	TASK_MAX_BYTES,
	untilText,
} from "../src/lib/schedule.ts";

const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const show = (t: number | null) => {
	if (t === null) return null;
	const d = new Date(t);
	return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")} (${d.getDay()})`;
};
const template = () => ({
	kind: "pi" as const,
	cwd: "/w",
	sessionFile: `/s/${RUN_SLOT}.jsonl`,
	command: ["node", "xpi", "--session", `/s/${RUN_SLOT}.jsonl`, "--", "task"],
	env: {},
	name: "n",
	origin: "dispatch" as const,
});

describe("schedule rules", () => {
	it("parses cron fields: lists, ranges, steps, Sunday as 0 or 7", () => {
		const c = parseCron("*/15 9-17 * * 1-5");
		expect([...c.minute]).toEqual([0, 15, 30, 45]);
		expect([...c.hour]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
		expect([...c.dow]).toEqual([1, 2, 3, 4, 5]);
		expect(c.domAndDow).toBe(false);
		expect([...parseCron("0 0 * * 7").dow]).toEqual([0]);
		expect([...parseCron("5,10 0 1 1 *").minute]).toEqual([5, 10]);
		expect([...parseCron("0 0 1/10 * *").dom]).toEqual([1, 11, 21, 31]);
		for (const bad of [
			"* * * *",
			"60 * * * *",
			"* 24 * * *",
			"* * 0 * *",
			"* * * 13 *",
			"* * * * 8",
			"*/0 * * * *",
			"a * * * *",
			"5-1 * * * *",
		]) {
			expect(() => parseCron(bad), bad).toThrow();
		}
	});

	it("finds the next matching minute in local time", () => {
		const weekdays9 = parseCron("0 9 * * 1-5");
		// Friday 2026-11-06 10:00 → Monday 2026-11-09 9:00
		expect(show(nextCron(weekdays9, at(2026, 11, 6, 10)))).toBe("2026-11-9 9:00 (1)");
		// exactly at a match: the next one, not the same minute
		expect(show(nextCron(weekdays9, at(2026, 11, 9, 9)))).toBe("2026-11-10 9:00 (2)");
		expect(show(nextCron(parseCron("30 * * * *"), at(2026, 11, 5, 13, 30)))).toBe("2026-11-5 14:30 (4)");
		expect(show(nextCron(parseCron("0 0 1 * *"), at(2026, 12, 15)))).toBe("2027-1-1 0:00 (5)");
		expect(show(nextCron(parseCron("0 12 29 2 *"), at(2026, 3, 1)))).toBe("2028-2-29 12:00 (2)");
		// day of month and day of week both given: either (cron's rule)
		expect(show(nextCron(parseCron("0 8 13 * 5"), at(2026, 11, 5)))).toBe("2026-11-6 8:00 (5)");
		expect(nextCron(parseCron("0 0 31 2 *"), at(2026, 1, 1))).toBeNull();
	});

	it("reads when: every, daily, weekdays, weekly, cron, manual", () => {
		expect(parseWhen("every 30m")).toEqual({ every: 30 * 60_000 });
		expect(parseWhen("every 5m")).toEqual({ every: 5 * 60_000 });
		expect(parseWhen("every 2h")).toEqual({ every: 2 * 3600_000 });
		expect(parseWhen("EVERY 1d")).toEqual({ every: 86_400_000 });
		const daily = parseWhen("daily 9:05");
		expect("cron" in daily && [...daily.cron.hour, ...daily.cron.minute]).toEqual([9, 5]);
		const wd = parseWhen("weekdays 18:00");
		expect("cron" in wd && [...wd.cron.dow]).toEqual([1, 2, 3, 4, 5]);
		const mon = parseWhen("weekly mon 09:00");
		expect("cron" in mon && [...mon.cron.dow, ...mon.cron.hour, ...mon.cron.minute]).toEqual([1, 9, 0]);
		const sun = parseWhen("weekly Sunday 23:30");
		expect("cron" in sun && [...sun.cron.dow]).toEqual([0]);
		expect(show(nextRun(mon, at(2026, 11, 9, 9)))).toBe("2026-11-16 9:00 (1)");
		expect("cron" in parseWhen('cron "0 9 * * 1"')).toBe(true);
		expect(parseWhen("manual")).toEqual({ manual: true });
		// a rule that never matches a date would never run
		expect(() => parseWhen('cron "0 9 31 2 *"')).toThrow(/never matches/);
		expect(() => parseWhen('cron "0 9 30 2 *"')).toThrow(/never matches/);
		expect(() => parseWhen('cron "0 9 29 2 *"')).not.toThrow();
		for (const bad of [
			"every 0m",
			"every 5s",
			"daily 25:00",
			"daily 9:60",
			"weekly 09:00",
			"weekly mo 09:00",
			"weekly funday 09:00",
			"hourly",
			"cron 1 2 3",
			"manual now",
			"",
		])
			expect(() => parseWhen(bad), bad).toThrow();
	});

	it("the floor: every under 5 minutes is refused", () => {
		expect(() => parseWhen("every 4m")).toThrow(/five minutes/);
		expect(() => parseWhen("every 1m")).toThrow(/five minutes/);
		expect(() => parseWhen("every 5m")).not.toThrow();
	});

	it("the floor: a cron rule whose times of day are under 5 minutes apart is refused, across an hour and midnight", () => {
		expect(() => parseWhen('cron "* * * * *"')).toThrow(/1 minute apart/);
		expect(() => parseWhen('cron "*/4 * * * *"')).toThrow(/4 minutes apart/);
		expect(() => parseWhen('cron "*/5 * * * *"')).not.toThrow();
		// 9:58 and 10:01, across an hour
		expect(() => parseWhen('cron "1,58 9-10 * * *"')).toThrow(/3 minutes apart/);
		expect(closestMinutes(parseCron("1,58 9-10 * * *"))).toBe(3);
		// 23:58 and 0:01 the next day, across midnight
		expect(() => parseWhen('cron "58 23 * * *"')).not.toThrow();
		expect(closestMinutes(parseCron("1,58 0,23 * * *"))).toBe(3);
		expect(() => parseWhen('cron "1,58 0,23 * * *"')).toThrow(/3 minutes apart/);
		// 0:00 and 23:57 (three minutes across midnight); day fields do not matter
		expect(() => parseWhen('cron "0,57 0,23 * * 1"')).toThrow(/3 minutes apart/);
		expect(() => parseWhen('cron "0 0,12 * * *"')).not.toThrow();
		expect(closestMinutes(parseCron("30 9 * * *"))).toBe(24 * 60);
	});

	it("every counts from the schedule's anchor; a run after a gap goes to the next slot; manual has none", () => {
		const start = at(2026, 11, 5, 10);
		const h = parseWhen("every 1h");
		expect(nextRun(h, start, start)).toBe(start + 3600_000);
		expect(nextRun(h, start + 3600_000, start)).toBe(start + 2 * 3600_000);
		expect(nextRun(h, start + 5.5 * 3600_000, start)).toBe(start + 6 * 3600_000);
		expect(nextRun(parseWhen("manual"), start, start)).toBeNull();
	});

	it("the latest slot in a window: every from its anchor, cron by its matches, manual none", () => {
		const a = at(2026, 11, 5, 10);
		const h = parseWhen("every 1h");
		expect(latestSlot(h, a + 30 * 60_000, a + 5.5 * 3600_000, a)).toBe(a + 5 * 3600_000);
		expect(latestSlot(h, a + 5.2 * 3600_000, a + 5.5 * 3600_000, a)).toBeNull();
		// not the anchor itself
		expect(latestSlot(h, a - 3600_000, a + 30 * 60_000, a)).toBeNull();
		const daily = parseWhen("daily 09:00");
		expect(show(latestSlot(daily, at(2026, 11, 1), at(2026, 11, 5, 12), 0))).toBe("2026-11-5 9:00 (4)");
		expect(show(latestSlot(daily, at(2026, 11, 1), at(2026, 11, 5, 8), 0))).toBe("2026-11-4 9:00 (3)");
		// the window's first minute counts
		expect(show(latestSlot(daily, at(2026, 11, 5, 9), at(2026, 11, 5, 9, 30), 0))).toBe("2026-11-5 9:00 (4)");
		expect(latestSlot(daily, at(2026, 11, 5, 10), at(2026, 11, 5, 12), 0)).toBeNull();
		expect(latestSlot(parseWhen("manual"), 0, at(2026, 11, 5), 0)).toBeNull();
	});

	it("fills each run's session file and command, and keeps only xpi launches it can run", () => {
		const t = template();
		const slot = runSlot(at(2026, 11, 5, 9));
		expect(slot).toMatch(/^2026-11-0\dT\d\d-00-00-000Z_[0-9a-f-]{36}$/);
		const r = runLaunch(t, slot);
		expect(r.sessionFile).toBe(`/s/${slot}.jsonl`);
		expect(r.command[3]).toBe(`/s/${slot}.jsonl`);
		expect(t.sessionFile).toContain(RUN_SLOT);
		expect(() => checkTemplate(t)).not.toThrow();
		expect(() => checkTemplate({ ...t, sessionFile: "/s/a.jsonl" })).toThrow(/sessionFile/);
		expect(() => checkTemplate({ ...t, sessionFile: `rel/${RUN_SLOT}.jsonl` })).toThrow(/sessionFile/);
		expect(() => checkTemplate({ ...t, kind: "shell" })).toThrow(/xpi sessions only/);
		expect(() => checkTemplate({ ...t, cwd: "rel" })).toThrow(/cwd/);
		expect(() => checkTemplate({ ...t, env: undefined })).toThrow(/env/);
		expect(() => checkTemplate(undefined)).toThrow(/missing/);
	});

	it("a task saying {{run}} is left alone; the command must name the session file", () => {
		const t = template();
		const file = t.sessionFile;
		const r = runLaunch({ ...t, command: ["xpi", "--session", file, "--", `explain ${RUN_SLOT}`] }, "SLOT");
		expect(r.command).toEqual(["xpi", "--session", "/s/SLOT.jsonl", "--", `explain ${RUN_SLOT}`]);
		expect(() => checkTemplate({ ...t, command: ["xpi", "--", "x"] })).toThrow(/name its sessionFile/);
	});

	it("names and the task's 64 KiB", () => {
		for (const ok of ["a", "nightly", "Deploy.check_2", "x".repeat(40)])
			expect(SCHEDULE_NAME.test(ok), ok).toBe(true);
		for (const bad of ["", "-a", ".a", "../x", "a b", "x".repeat(41)])
			expect(SCHEDULE_NAME.test(bad), bad).toBe(false);
		expect(checkTask(undefined)).toBeUndefined();
		expect(checkTask("x".repeat(TASK_MAX_BYTES))).toHaveLength(TASK_MAX_BYTES);
		expect(() => checkTask("x".repeat(TASK_MAX_BYTES + 1))).toThrow(/64 KiB/);
		// bytes, not characters
		expect(() => checkTask("é".repeat(TASK_MAX_BYTES / 2 + 1))).toThrow(/64 KiB/);
		expect(() => checkTask(5)).toThrow(/text/);
	});

	it("reads <name> <when> <task>", () => {
		expect(parseScheduleInput("nightly every 2h check the build and fix it")).toEqual({
			name: "nightly",
			when: "every 2h",
			task: "check the build and fix it",
		});
		expect(parseScheduleInput("standup weekdays 9:30 summarise yesterday's commits")).toMatchObject({
			when: "weekdays 9:30",
		});
		expect(parseScheduleInput("plan weekly mon 9:00 plan the week")).toMatchObject({
			when: "weekly mon 9:00",
			task: "plan the week",
		});
		expect(parseScheduleInput("ask manual look at open issues")).toMatchObject({ when: "manual" });
		expect(parseScheduleInput('mon cron "0 9 * * 1" plan the week')).toEqual({
			name: "mon",
			when: 'cron "0 9 * * 1"',
			task: "plan the week",
		});
		expect(parseScheduleInput("a every 1h line one\nline two")).toMatchObject({ task: "line one\nline two" });
		expect(parseScheduleInput("nightly every 2h")).toHaveProperty("error");
		expect(parseScheduleInput("../x every 2h task")).toHaveProperty("error");
		expect(parseScheduleInput("x daily 25:00 task")).toHaveProperty("error");
		expect(parseScheduleInput("x every 1m task")).toMatchObject({ error: expect.stringMatching(/five minutes/) });
		expect(parseScheduleInput("x hourly task")).toHaveProperty("error");
		expect(splitWhen("every 2h")).toEqual({ when: "every 2h", rest: "" });
	});

	it("says how long until a run", () => {
		const now = 1_000_000_000_000;
		expect(untilText(now - 5, now)).toBe("now");
		expect(untilText(now + 30_000, now)).toBe("in <1m");
		expect(untilText(now + 5 * 60_000, now)).toBe("in 5m");
		expect(untilText(now + 125 * 60_000, now)).toBe("in 2h 05m");
		expect(untilText(now + 50 * 3600_000, now)).toBe("in 2d 2h");
	});

	it("never goes back in the hour a DST change repeats, nor skips past", () => {
		const tz = process.env.TZ;
		process.env.TZ = "America/New_York";
		try {
			const after = Date.UTC(2026, 10, 1, 6, 30);
			for (const expr of ["* * * * *", "*/5 * * * *", "0 * * * *", "30 1 * * *"]) {
				const next = nextCron(parseCron(expr), after);
				expect(next, expr).not.toBeNull();
				expect(next! > after, expr).toBe(true);
				expect(next! - after, expr).toBeLessThan(25 * 3600_000);
			}
			expect(nextCron(parseCron("* * * * *"), after)).toBe(after + 60_000);
			const spring = nextCron(parseCron("30 2 * * *"), Date.UTC(2026, 2, 8, 5, 0));
			expect(new Date(spring!).toISOString()).toBe("2026-03-09T06:30:00.000Z");
		} finally {
			if (tz === undefined) delete process.env.TZ;
			else process.env.TZ = tz;
		}
	});

	it("a leading * keeps cron's day rule (and)", () => {
		expect(parseCron("0 0 */2 * 1").domAndDow).toBe(false);
		expect(parseCron("0 0 1 * 1").domAndDow).toBe(true);
	});
});
