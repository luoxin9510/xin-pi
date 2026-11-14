// Spec 03: the order of `xpi roost restart`, with clients that answer from a script (no daemon): what is asked of the
// daemon, in which order, what `--if-stale` leaves alone, what counts as a failure, and the caller-last rule.
import { describe, expect, it } from "vitest";
import { DaemonError } from "../src/lib/client.ts";
import type { JobRow } from "../src/lib/protocol.ts";
import {
	lastFor,
	OLD_DAEMON,
	RESTART_PROMPT,
	type RestartClient,
	respawnOne,
	restartRoost,
} from "../src/lib/restart.ts";

const OLD = "aaaaaaaaaaaaaaaa";
const NEW = "bbbbbbbbbbbbbbbb";

function row(id: string, over: Partial<JobRow> = {}): JobRow {
	return {
		id,
		name: `n-${id}`,
		kind: "pi",
		pid: 100,
		state: "done",
		build: OLD,
		...over,
	} as JobRow;
}

/** What the two daemons say; each `connect` is a connection to whichever daemon is up then. */
function world(o: {
	rows: JobRow[];
	/** The rows after the restart (default: the same). */
	after?: JobRow[];
	daemonBuild?: string | undefined;
	newBuild?: string | undefined;
	newPid?: number;
	respawn?: (args: Record<string, unknown>) => { id: string; started: boolean; error?: string }[];
	stops?: boolean;
}) {
	const log: string[] = [];
	const sent: { op: string; args: unknown }[] = [];
	let restarted = false;
	let alive = true;
	const client = (): RestartClient => ({
		close: () => {},
		request: (async (op: string, args: Record<string, unknown>) => {
			sent.push({ op, args });
			switch (op) {
				case "status":
					return restarted
						? { pid: o.newPid ?? 2, build: o.newBuild ?? NEW }
						: { pid: 1, build: o.daemonBuild ?? OLD };
				case "list":
					return { jobs: restarted ? (o.after ?? o.rows) : o.rows };
				case "resolve":
					return { id: (args.query as string) === "alpha" ? "a" : (args.query as string) };
				case "shutdown":
					restarted = true;
					alive = o.stops === false;
					return {};
				case "respawn":
					return {
						results: o.respawn ? o.respawn(args) : (args.ids as string[]).map((id) => ({ id, started: true })),
					};
				default:
					throw new Error(`unexpected ${op}`);
			}
		}) as RestartClient["request"],
	});
	return {
		log,
		sent,
		deps: {
			connect: async () => client(),
			buildOnDisk: () => NEW,
			say: (l: string) => log.push(l),
			isAlive: () => alive,
			exitTimeoutMs: 80,
			pollMs: 5,
		},
		respawns: () => sent.filter((s) => s.op === "respawn").map((s) => s.args),
		ops: () => sent.map((s) => s.op),
	};
}

describe("restartRoost", () => {
	it("stops the daemon keeping sessions, then restarts the running xpi sessions in one request", async () => {
		const w = world({
			rows: [row("a"), row("b"), row("c", { pid: null, state: "stopped" }), row("sh", { kind: "shell" })],
		});
		expect(await restartRoost({}, w.deps)).toBe(0);
		expect(w.ops()).toEqual(["status", "list", "shutdown", "status", "list", "respawn"]);
		expect(w.sent.find((s) => s.op === "shutdown")!.args).toEqual({ keepWorkers: true });
		expect(w.respawns()).toEqual([{ ids: ["a", "b"] }]);
		expect(w.log).toEqual([
			"daemon · stopping (pid 1, sessions stay running)",
			"daemon · started (pid 2, build bbbbbbbbbbbbbbbb)",
			"session · restarted · a · n-a",
			"session · restarted · b · n-b",
		]);
	});

	it("fails when the old daemon does not go within the time", async () => {
		const w = world({ rows: [row("a")], stops: false });
		expect(await restartRoost({}, w.deps)).toBe(1);
		expect(w.log.at(-1)).toContain("did not stop");
		expect(w.respawns()).toEqual([]);
	});

	it("fails when the new daemon is the old pid or not on the installed build", async () => {
		const same = world({ rows: [row("a")], newPid: 1 });
		expect(await restartRoost({}, same.deps)).toBe(1);
		expect(same.log.at(-1)).toContain("the old process");
		const old = world({ rows: [row("a")], newBuild: OLD });
		expect(await restartRoost({}, old.deps)).toBe(1);
		expect(old.log.at(-1)).toContain("not on the installed build");
		expect(old.respawns()).toEqual([]);
	});

	it("reports a session that was not adopted, leaves it out and fails", async () => {
		const w = world({ rows: [row("a"), row("b")], after: [row("a"), row("b", { pid: null })] });
		expect(await restartRoost({}, w.deps)).toBe(1);
		expect(w.log).toContain("session · ended while the daemon restarted · b · n-b");
		expect(w.respawns()).toEqual([{ ids: ["a"] }]);
	});

	it("fails when a session does not restart, and goes on to say what happened to each", async () => {
		const w = world({
			rows: [row("a"), row("b"), row("c")],
			respawn: () => [
				{ id: "a", started: true },
				{ id: "b", started: false, error: "locked" },
				{ id: "c", started: false },
			],
		});
		expect(await restartRoost({}, w.deps)).toBe(1);
		expect(w.log).toContain("session · failed: locked · b · n-b");
		expect(w.log).toContain("session · not restarted (busy) · c · n-c");
	});

	it("says so when there is nothing running", async () => {
		const w = world({ rows: [row("c", { pid: null })] });
		expect(await restartRoost({}, w.deps)).toBe(0);
		expect(w.respawns()).toEqual([]);
		expect(w.log.at(-1)).toBe("sessions · none running");
	});

	describe("--if-stale", () => {
		it("leaves a daemon and sessions on the installed build alone; an unknown build counts as stale", async () => {
			const w = world({
				daemonBuild: NEW,
				rows: [row("a", { build: NEW }), row("b", { build: OLD }), row("c", { build: undefined })],
			});
			expect(await restartRoost({ ifStale: true }, w.deps)).toBe(0);
			expect(w.ops()).not.toContain("shutdown");
			expect(w.respawns()).toEqual([{ ids: ["b", "c"] }]);
			expect(w.log[0]).toBe(`daemon · up to date (build ${NEW})`);
		});

		it("restarts the daemon when it is stale or says no build, and sessions that are up to date stay", async () => {
			const w = world({ daemonBuild: undefined, rows: [row("a", { build: NEW })] });
			expect(await restartRoost({ ifStale: true }, w.deps)).toBe(0);
			expect(w.ops()).toContain("shutdown");
			expect(w.respawns()).toEqual([]);
			expect(w.log.at(-1)).toBe("sessions · up to date");
		});
	});

	describe("the caller", () => {
		it("goes last, and is told its command was cut short when its own tool call ran it while it was working", async () => {
			const w = world({ rows: [row("a", { state: "working" }), row("b"), row("c")] });
			expect(await restartRoost({ self: "a", selfPrompt: true }, w.deps)).toBe(0);
			expect(w.respawns()).toEqual([{ ids: ["a", "b", "c"], last: { id: "a", prompt: RESTART_PROMPT } }]);
		});

		it("sends no prompt when it was idle", async () => {
			const w = world({ rows: [row("a", { state: "blocked" }), row("b")] });
			await restartRoost({ self: "a", selfPrompt: true }, w.deps);
			expect(w.respawns()).toEqual([{ ids: ["a", "b"], last: { id: "a" } }]);
		});

		it("is not named when it is not among the sessions restarted", async () => {
			const w = world({ rows: [row("a")] });
			await restartRoost({ self: "z" }, w.deps);
			expect(w.respawns()).toEqual([{ ids: ["a"] }]);
		});

		it("sends no prompt when a person typed the command, working or not (selfPrompt off)", async () => {
			const w = world({ rows: [row("a", { state: "working" }), row("b")] });
			await restartRoost({ self: "a" }, w.deps);
			expect(w.respawns()).toEqual([{ ids: ["a", "b"], last: { id: "a" } }]);
		});

		it("lastFor takes the state from the row, and the prompt only with selfPrompt", () => {
			expect(lastFor("a", [row("a", { state: "working" })], ["a"], true)).toEqual({
				id: "a",
				prompt: RESTART_PROMPT,
			});
			expect(lastFor("a", [row("a", { state: "working" })], ["a"])).toEqual({ id: "a" });
			expect(lastFor("a", [row("a")], ["a"], true)).toEqual({ id: "a" });
			expect(lastFor(undefined, [row("a")], ["a"])).toBeUndefined();
		});
	});
});

describe("restart <id|name>", () => {
	it("restarts that session only and leaves the daemon; says when the daemon is stale", async () => {
		const w = world({ rows: [row("a"), row("b")] });
		expect(await restartRoost({ query: "alpha" }, w.deps)).toBe(0);
		expect(w.ops()).toEqual(["status", "list", "resolve", "respawn"]);
		expect(w.respawns()).toEqual([{ ids: ["a"] }]);
		expect(w.log).toEqual([
			"daemon · runs an older build and was not restarted: xpi roost restart restarts it too",
			"session · restarted · a · n-a",
		]);
	});

	it("never starts a session that is not running", async () => {
		const w = world({ rows: [row("a", { pid: null, state: "stopped" })] });
		expect(await restartRoost({ query: "a" }, w.deps)).toBe(1);
		expect(w.respawns()).toEqual([]);
		expect(w.log.at(-1)).toContain("not running");
		const shell = world({ rows: [row("s", { kind: "shell" })] });
		expect(await restartRoost({ query: "s" }, shell.deps)).toBe(1);
	});

	it("--if-stale leaves a session on the installed build", async () => {
		const w = world({ daemonBuild: NEW, rows: [row("a", { build: NEW })] });
		expect(await restartRoost({ query: "a", ifStale: true }, w.deps)).toBe(0);
		expect(w.respawns()).toEqual([]);
		expect(w.log).toEqual(["session · up to date · a · n-a"]);
	});

	it("names the caller as last with the prompt when it restarts itself while working", async () => {
		const w = world({ daemonBuild: NEW, rows: [row("a", { state: "working" })] });
		await restartRoost({ query: "a", self: "a", selfPrompt: true }, w.deps);
		expect(w.respawns()).toEqual([{ ids: ["a"], last: { id: "a", prompt: RESTART_PROMPT } }]);
	});

	it("exits 1 when the session does not restart", async () => {
		const w = world({ rows: [row("a")], respawn: () => [{ id: "a", started: false, error: "locked" }] });
		expect(await restartRoost({ query: "a" }, w.deps)).toBe(1);
	});
});

describe("a daemon from before respawn took ids", () => {
	const refusal = () => Object.assign(new DaemonError("id required", "bad_request"), { fromDaemon: true });
	const answer = { results: [{ id: "a", started: true }] };

	it("falls back to {id, restart} when there is no prompt to send", async () => {
		const sent: unknown[] = [];
		const r = await respawnOne(async (a) => {
			sent.push(a);
			if ("ids" in a) throw refusal();
			return answer;
		}, "a");
		expect(r).toEqual({ id: "a", started: true });
		expect(sent).toEqual([{ ids: ["a"] }, { id: "a", restart: true }]);
	});

	it("says the service is older when a prompt would be lost, or the fallback fails too", async () => {
		await expect(
			respawnOne(
				async () => {
					throw refusal();
				},
				"a",
				{ id: "a", prompt: "p" },
			),
		).rejects.toThrow(OLD_DAEMON);
		await expect(
			respawnOne(async () => {
				throw refusal();
			}, "a"),
		).rejects.toThrow(OLD_DAEMON);
	});

	it("passes other errors on, and restartRoost <name> reports it with exit 1", async () => {
		await expect(
			respawnOne(async () => {
				throw new Error("boom");
			}, "a"),
		).rejects.toThrow("boom");
		const w = world({ rows: [row("a", { state: "working" })] });
		const base = w.deps.connect;
		w.deps.connect = async () => {
			const c = await base();
			const req = c.request;
			return {
				...c,
				request: ((op: string, a: Record<string, unknown>) =>
					op === "respawn" ? Promise.reject(refusal()) : req(op as never, a as never)) as RestartClient["request"],
			};
		};
		expect(await restartRoost({ query: "a", self: "a", selfPrompt: true }, w.deps)).toBe(1);
		expect(w.log.at(-1)).toContain(OLD_DAEMON);
	});
});
