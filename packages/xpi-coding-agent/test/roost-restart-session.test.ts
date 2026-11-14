// Spec 03: what `/restart` asks of the daemon from inside a session: a new connection (never the worker's reporter
// connection, on which `respawn` is refused), this session as `ids` and as `last`, with the prompt only when it was
// working. The daemon side is tested in xpi-roost.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
	state: "working",
	requests: [] as { op: string; args: unknown }[],
	connects: 0,
	closed: 0,
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
						if (op === "list") return { jobs: [{ id: "j1", name: "n", state: fake.state, pid: 1, kind: "pi" }] };
						return fake.respawn();
					},
				};
			},
		}),
	};
});

import { RESTART_PROMPT } from "xpi-roost";
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
	});
});
afterEach(() => {
	if (saved === undefined) delete process.env.ROOST_JOB_ID;
	else process.env.ROOST_JOB_ID = saved;
});

describe("/restart from a session", () => {
	it("opens a new connection and restarts this session last, with the prompt, when it was working", async () => {
		const notes: string[] = [];
		await restartFromSession(false, (t) => notes.push(t));
		expect(fake.connects).toBe(1);
		expect(fake.requests.find((r) => r.op === "respawn")!.args).toEqual({
			ids: ["j1"],
			last: { id: "j1", prompt: RESTART_PROMPT },
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
});
