// Spec 03: `xpi roost restart`, as a function the command line, a session's `/restart all` and the hub's `/restart` all
// call. It moves the daemon and every running xpi session onto the code installed now. Clients are injected, so the
// order of the steps, `--if-stale`, the failures and the caller-last rule are tested without a daemon.
import type { DaemonClient } from "./client.ts";
import { isAlive } from "./proc.ts";
import type { JobRow } from "./protocol.ts";
import { isStale } from "./version.ts";

/**
 * What a session is told when it asked for its own restart in a tool call: the command is cut short and shows no result
 * (the cut-off call resumes with the synthetic "No result provided" error), so it must not run again.
 */
export const RESTART_PROMPT =
	'xpi was restarted on the installed build, as this session asked with "xpi roost restart". The command that asked for it was cut short and shows no result: do not run it again. Carry on from where you were.';

/** What the restart needs from a connection. */
export type RestartClient = Pick<DaemonClient, "request" | "close">;

export interface RestartOptions {
	/** One session (id or name): only it is restarted and the daemon is left as it is. */
	query?: string;
	/** Only what is stale: the daemon if its build is, each session if its build is (an unknown build counts as stale). */
	ifStale?: boolean;
	/** The session that runs this restart (ROOST_JOB_ID): when it is among those restarted, it goes last. */
	self?: string;
}

export interface RestartDeps {
	/** A connection to the daemon, starting it when none runs. Each call is a new connection the caller closes. */
	connect(): Promise<RestartClient>;
	/** The build installed now (unknown from sources). */
	buildOnDisk(): string | undefined;
	/** One line of output. */
	say(line: string): void;
	/** Default: `process.kill(pid, 0)`. */
	isAlive?: (pid: number) => boolean;
	/** How long the old daemon may take to go (default 10 s) and how often it is looked at. */
	exitTimeoutMs?: number;
	pollMs?: number;
}

/** Whether a running session is behind: a build that is not the installed one, or none reported (`--if-stale`). */
const behind = (build: string | undefined, onDisk: string | undefined): boolean =>
	!build || !onDisk || isStale(build, onDisk);

/** The session that makes the request goes last, and says to carry on only when it was working (its tool call was cut). */
export function lastFor(
	self: string | undefined,
	rows: JobRow[],
	ids: string[],
): { id: string; prompt?: string } | undefined {
	if (!self || !ids.includes(self)) return undefined;
	const row = rows.find((r) => r.id === self);
	return row?.state === "working" ? { id: self, prompt: RESTART_PROMPT } : { id: self };
}

const running = (r: JobRow) => r.pid !== null && r.kind !== "shell";
const label = (r: JobRow | undefined, id: string) => `${id} · ${r?.name ?? id}`;

/** Runs the restart; resolves to the exit code (1 when anything failed). */
export async function restartRoost(opts: RestartOptions, deps: RestartDeps): Promise<number> {
	const { say } = deps;
	const first = await deps.connect();
	try {
		const status = await first.request("status", {});
		const { jobs } = await first.request("list", {});
		if (opts.query !== undefined) return await restartOne(first, opts, jobs, status.build, deps);

		// 1. what runs now
		const onDisk = deps.buildOnDisk();
		const ids = jobs
			.filter(running)
			.filter((r) => !opts.ifStale || behind(r.build, onDisk))
			.map((r) => r.id);
		const daemonStale = !opts.ifStale || behind(status.build, onDisk);

		// 2 and 3. the daemon: stopped with its sessions left running, and started on the installed code
		let daemon: RestartClient = first;
		let moved = false;
		if (daemonStale) {
			moved = true;
			say(`daemon · stopping (pid ${status.pid}, sessions stay running)`);
			try {
				await first.request("shutdown", { keepWorkers: true });
			} catch {
				// the answer may be lost with the connection: the pid below says whether it went
			}
			first.close();
			if (!(await gone(status.pid, deps))) {
				say(`daemon · pid ${status.pid} did not stop within ${(deps.exitTimeoutMs ?? 10_000) / 1000} s`);
				return 1;
			}
			// another client may have started the daemon already: the installed code either way
			daemon = await deps.connect();
			const now = await daemon.request("status", {});
			if (now.pid === status.pid || isStale(now.build, onDisk)) {
				say(
					`daemon · started, but it is ${now.pid === status.pid ? "the old process" : "not on the installed build"}`,
				);
				daemon.close();
				return 1;
			}
			say(`daemon · started (pid ${now.pid}${now.build ? `, build ${now.build}` : ""})`);
		} else say(`daemon · up to date (build ${status.build})`);

		// 4. the sessions
		let code = 0;
		try {
			const rows = (await daemon.request("list", {})).jobs;
			const go: string[] = [];
			for (const id of ids) {
				// a daemon adopts running hosts before it listens: a session with no process now had none to adopt
				if (moved && rows.find((r) => r.id === id)?.pid == null) {
					say(
						`session · ended while the daemon restarted · ${label(
							jobs.find((j) => j.id === id),
							id,
						)}`,
					);
					code = 1;
				} else go.push(id);
			}
			if (go.length === 0) {
				if (ids.length === 0) say(opts.ifStale ? "sessions · up to date" : "sessions · none running");
				return code;
			}
			const last = lastFor(opts.self, jobs, go);
			if (last)
				say(
					`session · this one restarts last · ${label(
						jobs.find((j) => j.id === last.id),
						last.id,
					)}`,
				);
			const { results } = await daemon.request("respawn", { ids: go, ...(last ? { last } : {}) });
			for (const r of results) {
				const row = jobs.find((j) => j.id === r.id);
				if (r.started) say(`session · restarted · ${label(row, r.id)}`);
				else {
					say(`session · ${r.error ? `failed: ${r.error}` : "not restarted (busy)"} · ${label(row, r.id)}`);
					code = 1;
				}
			}
		} finally {
			daemon.close();
		}
		return code;
	} finally {
		first.close();
	}
}

/** `xpi roost restart <id|name>`: that session only. The daemon is not touched; it says when it is stale. */
async function restartOne(
	client: RestartClient,
	opts: RestartOptions,
	jobs: JobRow[],
	daemonBuild: string | undefined,
	deps: RestartDeps,
): Promise<number> {
	const { id } = await client.request("resolve", { query: opts.query! });
	const row = jobs.find((j) => j.id === id);
	if (!row || !running(row)) {
		deps.say(`session · not running · ${label(row, id)} (xpi roost respawn starts it)`);
		return 1;
	}
	const onDisk = deps.buildOnDisk();
	if (daemonBuild && isStale(daemonBuild, onDisk))
		deps.say("daemon · runs an older build and was not restarted: xpi roost restart restarts it too");
	if (opts.ifStale && !behind(row.build, onDisk)) {
		deps.say(`session · up to date · ${label(row, id)}`);
		return 0;
	}
	const last = lastFor(opts.self, jobs, [id]);
	const { results } = await client.request("respawn", { ids: [id], ...(last ? { last } : {}) });
	const r = results[0];
	if (r?.started) {
		deps.say(`session · restarted · ${label(row, id)}`);
		return 0;
	}
	deps.say(`session · ${r?.error ? `failed: ${r.error}` : "not restarted (busy)"} · ${label(row, id)}`);
	return 1;
}

/** Polls until the process is gone; false after the timeout. */
async function gone(pid: number, deps: RestartDeps): Promise<boolean> {
	const alive = deps.isAlive ?? isAlive;
	const deadline = Date.now() + (deps.exitTimeoutMs ?? 10_000);
	while (alive(pid)) {
		if (Date.now() > deadline) return false;
		await new Promise((r) => setTimeout(r, deps.pollMs ?? 50));
	}
	return true;
}
