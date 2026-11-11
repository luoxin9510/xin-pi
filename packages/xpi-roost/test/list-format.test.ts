// `xpi roost ls`: the table for people. Ported from pi-roost's list-format.test.ts without the
// subagent rows (decision 6); the widths are checked with xpi-roost's own text-width, since
// xpi-roost imports nothing of xpi.
import { describe, expect, it } from "vitest";
import { formatList, formatSchedules } from "../src/lib/list-format.ts";
import type { JobRow, ScheduleRow } from "../src/lib/protocol.ts";
import { truncateToWidth, visibleWidth } from "../src/lib/text-width.ts";

let n = 0;
const row = (over: Partial<JobRow> = {}): JobRow => {
	n++;
	const now = Date.now();
	return {
		id: `abcd000${n}`,
		cwd: "/home/u/proj",
		kind: "pi",
		startedAt: now - 120_000,
		state: "working",
		pid: 1,
		status: "busy",
		waitingFor: null,
		sessionFile: `/s/${n}.jsonl`,
		name: `task ${n}`,
		endedAt: null,
		summary: "running tests",
		question: null,
		choices: [],
		model: null,
		thinking: null,
		context: null,
		error: null,
		stateSince: now - 60_000,
		reaped: false,
		pinned: false,
		order: null,
		orderKey: null,
		...over,
	};
};

describe("xpi roost ls", () => {
	it("waiting first, then working, then ended; fits the width", () => {
		const done = row({ state: "done", status: "idle", pid: null, summary: "All green", endedAt: Date.now() - 1000 });
		const waiting = row({ state: "blocked", status: "waiting", question: "Which branch?" });
		const working = row();
		const out = formatList([done, working, waiting], { width: 80, home: "/home/u" });
		const lines = out.trimEnd().split("\n");
		expect(lines[0]).toMatch(/^ID +STATE +NAME/);
		expect(lines[1]).toContain("Which branch?");
		expect(lines[2]).toContain("running tests");
		expect(lines[3]).toContain("All green");
		expect(lines[3]).toContain("~/proj");
		expect(lines).toHaveLength(4);
		for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(80);
		for (const l of formatList([done, working, waiting], { width: 40 }).split("\n"))
			expect(visibleWidth(l)).toBeLessThanOrEqual(40);
		expect(formatList([])).toBe("no background sessions\n");
	});

	it("a name in wide characters or with control characters keeps the columns", () => {
		// working rows are listed newest state first: the wide one is the newer, whichever millisecond each was made in
		const now = Date.now();
		const wide = row({
			name: "修复登录页面的错误和测试覆盖率问题",
			summary: "line one\nline two\x1b[31m",
			stateSince: now - 1_000,
		});
		const out = formatList([wide, row({ stateSince: now - 60_000 })], { width: 140, now });
		const lines = out.trimEnd().split("\n");
		expect(out).not.toContain("\x1b");
		expect(lines[1]).toContain("line one line two");
		for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(140);
		// the AGE column starts at the same place in both rows
		const ageAt = (l: string) => visibleWidth(l.slice(0, l.search(/\d+[smhd]\b/)));
		expect(ageAt(lines[1]!)).toBe(ageAt(lines[2]!));
	});

	it("text-width: wide characters count two, marks none, and truncation cuts whole characters", () => {
		expect(visibleWidth("abc")).toBe(3);
		expect(visibleWidth("中文")).toBe(4);
		expect(visibleWidth("é")).toBe(1);
		expect(visibleWidth("a‍b")).toBe(2);
		expect(truncateToWidth("中文字", 5, "…")).toBe("中文…");
		expect(truncateToWidth("abc", 3, "…")).toBe("abc");
		expect(visibleWidth(truncateToWidth("中文字中文字", 7, "…"))).toBeLessThanOrEqual(7);
	});
});

describe("phase 2: schedules in ls and schedule list", () => {
	it("a scheduled run shows its schedule's name", () => {
		const out = formatList([row({ name: "nightly (2)", schedule: "nightly" }), row({ name: "plain" })], {
			width: 140,
		});
		expect(out).toContain("nightly (2) ← nightly");
		expect(out).not.toContain("plain ←");
	});

	it("schedule list: a table with the next run, the last run or skip, paused and manual", () => {
		const now = Date.UTC(2026, 0, 5, 10);
		const base: ScheduleRow = {
			name: "nightly",
			when: "daily 03:00",
			task: "check the build",
			cwd: "/home/u/proj",
			model: null,
			thinking: null,
			paused: false,
			nextAt: now + 125 * 60_000,
			lastRunAt: now - 3 * 3600_000,
			lastJob: "abcd1234",
			lastRunWhy: "catch-up",
			lastSkip: null,
		};
		const out = formatSchedules(
			[
				base,
				{ ...base, name: "ask", when: "manual", nextAt: null, lastRunAt: null, lastJob: null, lastRunWhy: null },
				{
					...base,
					name: "rest",
					paused: true,
					nextAt: null,
					lastSkip: { at: now - 60_000, why: "previous run still working" },
				},
			],
			{ now, width: 200, home: "/home/u" },
		);
		const lines = out.trimEnd().split("\n");
		expect(lines[0]).toMatch(/^NAME\s+WHEN\s+NEXT\s+LAST\s+DIR\s+TASK$/);
		expect(lines[1]).toMatch(
			/^nightly\s+daily 03:00\s+in 2h 05m\s+3h ago \(catch-up\) abcd1234\s+~\/proj\s+check the build$/,
		);
		expect(lines[2]).toMatch(/^ask\s+manual\s+on request\s+never run/);
		expect(lines[3]).toMatch(/^rest\s+daily 03:00\s+paused\s+skipped 1m ago: previous run still working/);
		expect(formatSchedules([])).toBe("no schedules\n");
		for (const l of formatSchedules([base], { now, width: 50 }).split("\n"))
			expect(visibleWidth(l)).toBeLessThanOrEqual(50);
	});
});
