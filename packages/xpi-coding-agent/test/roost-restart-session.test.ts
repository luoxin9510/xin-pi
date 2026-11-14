// Spec 03: what `/restart` asks of the daemon from inside a session: a new connection (never the worker's reporter
// connection, on which `respawn` is refused), this session as `ids` and as `last`, with the prompt only when it was
// working. The daemon side is tested in xpi-roost.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
	state: "working",
	requests: [] as { op: string; args: unknown }[],
	connects: 0,
	closed: 0,
	fail: undefined as undefined | (() => Error),
	failAll: false,
	respawn: (): { results: { id: string; started: boolean; error?: string }[] } => ({
		results: [{ id: "j1", started: true }],
	}),
}));

vi.mock("xpi-roost", async (importOriginal) => {
	const real = await importOriginal<typeof import("xpi-roost")>();
	return {
		...real,
		DaemonClient: Object.assign(class {}, {
			connect: async () => {
				fake.connects++;
				return {
					close: () => {
						fake.closed++;
					},
					request: async (op: string, args: unknown) => {
						fake.requests.push({ op, args });
						if (op === "respawn" && fake.fail && (fake.failAll || "ids" in (args as object))) throw fake.fail();
						if (op === "list") return { jobs: [{ id: "j1", name: "n", state: fake.state, pid: 1, kind: "pi" }] };
						return fake.respawn();
					},
				};
			},
		}),
	};
});

import { DaemonError } from "xpi-roost";
import { restartFromSession } from "../src/extensions/roost/restart.ts";

const saved = process.env.ROOST_JOB_ID;
beforeEach(() => {
	process.env.ROOST_JOB_ID = "j1";
	Object.assign(fake, {
		state: "working",
		requests: [],
		connects: 0,
		closed: 0,
		respawn: () => ({ results: [{ id: "j1", started: true }] }),
		fail: undefined,
		failAll: false,
	});
});
afterEach(() => {
	if (saved === undefined) delete process.env.ROOST_JOB_ID;
	else process.env.ROOST_JOB_ID = saved;
});

describe("/restart from a session", () => {
	it("opens a new connection and restarts this session last, with no prompt even when it was working", async () => {
		const notes: string[] = [];
		await restartFromSession(false, (t) => notes.push(t));
		expect(fake.connects).toBe(1);
		expect(fake.requests.find((r) => r.op === "respawn")!.args).toEqual({
			ids: ["j1"],
			last: { id: "j1" },
		});
		expect(fake.closed).toBe(1);
		expect(notes).toEqual(["restarting this session onto the installed build…"]);
	});

	it("sends no prompt when the session was idle", async () => {
		fake.state = "done";
		await restartFromSession(false, () => {});
		expect(fake.requests.find((r) => r.op === "respawn")!.args).toEqual({ ids: ["j1"], last: { id: "j1" } });
	});

	it("says so when the daemon did not restart it", async () => {
		fake.respawn = () => ({ results: [{ id: "j1", started: false, error: "locked" }] });
		const notes: string[] = [];
		await restartFromSession(false, (t) => notes.push(t));
		expect(notes.at(-1)).toBe("not restarted: locked");
	});

	it("falls back to the older request on a daemon that does not know ids, and says when it cannot", async () => {
		const refuse = () => Object.assign(new DaemonError("id required", "bad_request"), { fromDaemon: true });
		fake.fail = refuse;
		const notes: string[] = [];
		await restartFromSession(false, (t) => notes.push(t));
		expect(fake.requests.filter((r) => r.op === "respawn").map((r) => r.args)).toEqual([
			{ ids: ["j1"], last: { id: "j1" } },
			{ id: "j1", restart: true },
		]);
		// the fallback fails too
		fake.requests = [];
		fake.failAll = true;
		await restartFromSession(false, (t) => notes.push(t));
		expect(notes.at(-1)).toContain("the background service is older than this command");
	});
});
