// AT-1 and M5a: attaching to a session that is not running starts it again first; a failed
// run (cut off) is told to carry on, anything else just reopens. Phase 1 cuts the daemon
// resuming on its own (DM-5's restarts aside), not a person's attach continuing a failed run.
import { describe, expect, it } from "vitest";
import type { DaemonClient } from "../src/lib/client.ts";
import type { JobRow } from "../src/lib/protocol.ts";
import { CONTINUE, ensureLive, resumePrompt } from "../src/lib/resume.ts";

const row = (over: Partial<JobRow>): JobRow => ({
	id: "abcd0001",
	cwd: "/w",
	kind: "pi",
	startedAt: 0,
	state: "failed",
	pid: null,
	status: "idle",
	waitingFor: null,
	sessionFile: "/s.jsonl",
	name: "t",
	endedAt: 1,
	summary: null,
	question: null,
	choices: [],
	model: null,
	thinking: null,
	context: null,
	error: "killed",
	stateSince: 0,
	reaped: false,
	pinned: false,
	order: null,
	orderKey: null,
	...over,
});

/** A daemon that records the respawn it is asked for and refuses it (so ensureLive stops there). */
function fakeDaemon() {
	const asked: unknown[] = [];
	const client = {
		request: async (op: string, args: unknown) => {
			asked.push({ op, args });
			return { results: [{ id: "abcd0001", started: false, error: "refused (test)" }] };
		},
	} as unknown as DaemonClient;
	return { client, asked };
}

describe("attach starts a session that is not running", () => {
	it("a failed run carries on; a shell command, a finished or a stopped run just reopen", () => {
		expect(resumePrompt(row({}))).toBe(CONTINUE);
		expect(CONTINUE).toBe("Continue where you left off.");
		expect(resumePrompt(row({ kind: "shell" }))).toBeUndefined();
		expect(resumePrompt(row({ state: "done" }))).toBeUndefined();
		expect(resumePrompt(row({ state: "stopped" }))).toBeUndefined();
	});

	it("asks the daemon to respawn with that prompt, and nothing for a running session", async () => {
		const failed = fakeDaemon();
		await expect(ensureLive(failed.client, row({}))).rejects.toThrow("refused (test)");
		expect(failed.asked).toEqual([{ op: "respawn", args: { id: "abcd0001", prompt: CONTINUE } }]);
		const done = fakeDaemon();
		await expect(ensureLive(done.client, row({ state: "done" }))).rejects.toThrow("refused (test)");
		expect(done.asked).toEqual([{ op: "respawn", args: { id: "abcd0001", prompt: undefined } }]);
		const live = fakeDaemon();
		await ensureLive(live.client, row({ state: "working", pid: 42, endedAt: null }));
		expect(live.asked).toEqual([]);
	});
});
