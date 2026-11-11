import { describe, expect, it } from "vitest";
import {
	notifySequence,
	notifyText,
	observeJob,
	resolveNotify,
	setJobEventBus,
	transitionKind,
} from "../src/lib/job-events.ts";
import type { JobRow } from "../src/lib/protocol.ts";

const row = (over: Partial<JobRow> = {}): JobRow => ({
	id: "a1",
	cwd: "/w",
	kind: "pi",
	startedAt: 0,
	state: "working",
	pid: 1,
	status: "busy",
	waitingFor: null,
	sessionFile: "/s.jsonl",
	name: "fix tests",
	endedAt: null,
	summary: null,
	question: null,
	choices: [],
	model: null,
	thinking: null,
	context: null,
	error: null,
	stateSince: 0,
	reaped: false,
	pinned: false,
	order: null,
	orderKey: null,
	...over,
});

describe("job events", () => {
	it("announces transitions once and ignores first sightings", () => {
		const seen: [string, unknown][] = [];
		setJobEventBus({ emit: (c, d) => seen.push([c, d]) });
		expect(observeJob(row({ id: "e1" }))).toBeUndefined();
		// a first sighting is never news, whatever its state
		expect(observeJob(row({ id: "e0", state: "blocked" }))).toBeUndefined();
		expect(observeJob(row({ id: "e00", state: "done" }))).toBeUndefined();
		expect(observeJob(row({ id: "e1", state: "blocked", question: "tabs?" }))).toBe("needs_input");
		expect(observeJob(row({ id: "e1", state: "blocked" }))).toBeUndefined();
		expect(observeJob(row({ id: "e1", state: "done", summary: "ok" }))).toBe("completed");
		expect(seen.map(([c]) => c)).toEqual(["agents:job_needs_input", "agents:job_completed"]);
		expect(seen[1]![1]).toMatchObject({ id: "e1", state: "done", summary: "ok" });
		expect(transitionKind("working", row({ state: "stopped" }))).toBeUndefined();
		setJobEventBus(undefined);
	});

	it("builds terminal notifications", () => {
		expect(resolveNotify("auto", { TERM_PROGRAM: "iTerm.app" })).toBe("osc9");
		expect(resolveNotify("auto", { TERM_PROGRAM: "Apple_Terminal" })).toBe("bell");
		expect(resolveNotify("off", {})).toBe("off");
		expect(notifySequence("osc9", "a", "b;\x1bc")).toBe("\x1b]9;a: b c\x07");
		expect(notifySequence("osc777", "t", "b")).toBe("\x1b]777;notify;t;b\x07");
		expect(notifySequence("bell", "t", "b")).toBe("\x07");
		expect(notifySequence("off", "t", "b")).toBe("");
		expect(notifyText(row({ state: "failed", error: "boom" }), "completed")).toEqual({
			title: "fix tests failed",
			body: "boom",
		});
	});
});
