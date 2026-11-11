// `xpi roost <subcommand>`: the command line over the daemon (pi-roost's bin/pi-roost.ts).
// xpi supplies what this library cannot know: the agent directory, the daemon's and the
// host's entry files, the detach key (the user's keybinding) and its own install hints.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { readJson } from "./lib/atomic.ts";
import { attachToHost, type DetachKeyMatcher } from "./lib/attach.ts";
import { DaemonClient, DaemonError, type DaemonStart, daemonEnv, requestOnce } from "./lib/client.ts";
import { eventAgo, eventLine, type RoostEvent } from "./lib/events.ts";
import { hostControl } from "./lib/hostclient.ts";
import { readJobEnv } from "./lib/identity.ts";
import { formatList, formatSchedules } from "./lib/list-format.ts";
import {
	checkRuntimeDir,
	daemonLogPath,
	hostSocketPath,
	ROOST_LOCATION_ENV,
	roostHome,
	runtimeDir,
} from "./lib/paths.ts";
import type { DispatchArgs, JobRow, ScheduleRow } from "./lib/protocol.ts";
import { ensureLive } from "./lib/resume.ts";
import {
	checkTask,
	parseWhen,
	SCHEDULE_NAME,
	type Schedule,
	scheduleRow,
	untilText,
	WHEN_HELP,
} from "./lib/schedule.ts";
import { screenPath } from "./lib/store.ts";
import { ROOST_VERSION } from "./lib/version.ts";

interface Out {
	write(text: string): unknown;
}

export interface RoostCliOptions {
	/** The roost: the agent directory and the two entry files. */
	start: DaemonStart;
	/** The detach key for `attach` (decision 11: the caller's, from the user's keybindings). */
	isDetachKey: DetachKeyMatcher;
	/** How the detach key is named in help and messages, e.g. "ctrl+z". */
	detachKeyName: string;
	/** What to tell the user when the daemon cannot load node-pty (how to install it). */
	ptyHint: string;
	/**
	 * Whether node-pty is installed for this xpi (default true). Without it only what starts a
	 * session process (a PTY host) is refused: `respawn`, and `attach` to a session that is not
	 * running. Everything else talks to the daemon and to running hosts, which have theirs.
	 */
	ptyInstalled?: boolean;
	/** `xpi roost hub [dir]`: the hub runs on xpi's terminal and settings, so xpi supplies it (none: not available). */
	hub?: (args: string[]) => Promise<number>;
	/**
	 * Phase 2: a schedule's launch, built by xpi as for any new session (decision 9): its environment filtered by the
	 * `roost` settings, the stored trust decision for `cwd`, the session directory xpi would use there with `{{run}}`
	 * for each run's file, this xpi's executable and entry, and the model and thinking (the given ones, else the
	 * settings'). None: `schedule add` and `edit` are not available.
	 */
	scheduleLaunch?: (input: ScheduleLaunchInput) => DispatchArgs;
	/** How long a daemon may take to start (tests). */
	startTimeoutMs?: number;
	stdout?: Out;
	stderr?: Out;
}

const ENDED_CUTOFF_MS = 48 * 60 * 60 * 1000;

/** What a schedule's launch is built from. */
export interface ScheduleLaunchInput {
	cwd: string;
	/** The first prompt (none: the run starts idle). */
	task?: string;
	model?: string;
	thinking?: string;
	name: string;
}

/** `cron 0 9 * * 1` (the shell took the quotes) is kept as `cron "0 9 * * 1"`, as rules are written. */
export function normalizeWhen(when: string): string {
	const s = when.trim().replace(/\s+/g, " ");
	const m = /^cron\s+["']?(.*?)["']?$/i.exec(s);
	return m ? `cron "${m[1]}"` : s;
}

export function roostUsage(detachKeyName: string): string {
	return `xpi roost ${ROOST_VERSION}: background xpi sessions

usage:
  xpi roost ls [--all] [--cwd <dir>] [--json]
                                   list background sessions (--all includes ended ones
                                   older than 48 h; --json for programs); also: list
  xpi roost attach <id|name>       open a background session (${detachKeyName} detaches);
                                   an ended one is started again first
  xpi roost logs <id|name>         print its current or last screen
  xpi roost log [-n <count>] [--follow] [<id|name>]
                                   what happened lately, oldest first; --follow keeps printing
  xpi roost reply <id|name> <text> send a reply (queued as a follow-up while it works)
  xpi roost stop <id|name>         stop it
  xpi roost rm <id|name>           stop it and delete its record
  xpi roost respawn <id|name>      start an ended session again (or restart a live one)
  xpi roost respawn --all          restart running xpi sessions (after an upgrade)
  xpi roost schedule list [--json]
                                   schedules: rule, next run, last run or skip (works
                                   without the background service running)
  xpi roost schedule add <name> <when> <task> [--cwd <dir>] [--model <m>] [--thinking <t>]
                                   start <task> as a new background session on <when>:
                                   every 30m, daily 09:00, weekdays 09:00, weekly mon 09:00,
                                   cron "0 9 * * 1-5", manual (local time; 5 minutes apart at least)
  xpi roost schedule edit <name> [--when <when>] [--task <task>] [--model <m>] [--thinking <t>]
                                   change it; the launch (environment, xpi, trust) is built again
  xpi roost schedule run <name>    run it now (also paused or manual)
  xpi roost schedule pause|resume|rm <name>
  xpi roost daemon status|logs|stop [--keep-workers]
  xpi roost hub [dir]              the hub: every session, peek, reply, attach, start new ones
                                   (new sessions start in dir, default the current one)`;
}

class UsageError extends Error {}

// A finished turn still has a live worker to attach to; only the process matters.
const isLive = (row: JobRow) => row.pid !== null;

/** Runs one `xpi roost` command; resolves to the exit code. */
export async function runRoostCli(argv: string[], opts: RoostCliOptions): Promise<number> {
	const stdout = opts.stdout ?? process.stdout;
	const stderr = opts.stderr ?? process.stderr;
	const start: DaemonStart = { ...opts.start, agentDir: resolvePath(opts.start.agentDir) };
	// this process uses the roost it was given: every path below (state, sockets) is its
	const location = daemonEnv(start);
	for (const name of ROOST_LOCATION_ENV) process.env[name] = location[name];

	let warned = false;
	/** Refuses what would start a PTY host when node-pty is not installed here. */
	const needPty = (what: string) => {
		if (opts.ptyInstalled === false)
			throw new DaemonError(`${what} starts a session process, which needs node-pty. ${opts.ptyHint}`, "no_pty");
	};
	const connect = () => DaemonClient.connectOrStart(start, opts.startTimeoutMs);

	/** DM-9: a daemon of another version keeps running old code; a daemon without node-pty starts nothing. */
	async function warnOnce(client: DaemonClient): Promise<void> {
		if (warned) return;
		warned = true;
		const s = await client.request("status", {});
		if (s.version !== ROOST_VERSION) {
			stderr.write(
				`warning: the background service is ${s.version}, this xpi is ${ROOST_VERSION}; restart it with: xpi roost daemon stop --keep-workers, then xpi roost respawn --all\n`,
			);
		}
		if (s.ptyError) stderr.write(`warning: background sessions cannot start: ${s.ptyError}. ${opts.ptyHint}\n`);
	}

	async function withDaemon<T>(fn: (client: DaemonClient) => Promise<T>): Promise<T> {
		const client = await connect();
		try {
			await warnOnce(client);
			return await fn(client);
		} finally {
			client.close();
		}
	}

	async function findRow(client: DaemonClient, query: string | undefined): Promise<JobRow> {
		if (!query) throw new UsageError("missing <id|name>");
		const { id } = await client.request("resolve", { query });
		const { jobs } = await client.request("list", { all: true });
		const row = jobs.find((j) => j.id === id);
		if (!row) throw new DaemonError(`no session ${id}`, "not_found");
		return row;
	}

	async function cmdAttach(query: string | undefined): Promise<void> {
		if (!process.stdin.isTTY || !process.stdout.isTTY) throw new DaemonError("attach needs a terminal", "no_tty");
		const row = await withDaemon(async (c) => {
			const r = await findRow(c, query);
			// a running session's host is there already: attaching needs no node-pty here
			if (!isLive(r)) needPty(`attaching to ${r.name}, which is not running,`);
			// AT-1: a reaped or ended session starts again; its last screen shows meanwhile
			await ensureLive(c, r, process.stdout);
			return r;
		});
		const reason = await attachToHost(
			hostSocketPath(row.id),
			{ stdin: process.stdin, stdout: process.stdout },
			{ isDetachKey: opts.isDetachKey },
		);
		const note =
			reason === "exit"
				? "session ended"
				: reason === "takeover"
					? "attached elsewhere"
					: reason === "error"
						? "connection lost"
						: "detached";
		// The session left the cursor wherever its editor was; print below its last frame.
		process.stdout.write(`\x1b[${process.stdout.rows || 24};1H\r\n${note} · ${row.id} · ${row.name}\r\n`);
	}

	async function cmdLogs(query: string | undefined): Promise<void> {
		const row = await withDaemon((c) => findRow(c, query));
		let text: string | undefined;
		if (isLive(row)) {
			try {
				checkRuntimeDir();
				text = ((await hostControl(row.id, "snapshot")) as { text: string }).text;
			} catch {
				// host just went away: fall back to the last screen on disk
			}
		}
		try {
			text ??= readFileSync(screenPath(row.id), "utf8");
		} catch {
			throw new DaemonError(`no screen recorded for ${row.id}`, "no_screen");
		}
		stdout.write(text.endsWith("\n") ? text : `${text}\n`);
	}

	async function cmdStopOrRm(op: "stop" | "rm", query: string | undefined): Promise<void> {
		await withDaemon(async (c) => {
			const row = await findRow(c, query);
			await c.request(op, { id: row.id });
			stdout.write(`${op === "stop" ? "stopped" : "removed"} · ${row.id} · ${row.name}\n`);
		});
	}

	async function cmdReply(query: string | undefined, words: string[]): Promise<number> {
		const text = words.join(" ").trim();
		if (!text) throw new UsageError("reply needs text");
		return withDaemon(async (c) => {
			const row = await findRow(c, query);
			// M51: sent again (once taken) when the answer is lost to a restart of the service
			let cur = c;
			const r = await requestOnce(
				async () => {
					if (cur.isClosed) cur = await connect();
					return cur;
				},
				"reply",
				{ id: row.id, text },
				{ tag: "cli" },
			).finally(() => {
				if (cur !== c) cur.close();
			});
			const what = r.stopped
				? "stopped"
				: r.delivered
					? "sent"
					: r.respawned
						? "sent · restarting the session"
						: r.saved
							? `saved for its next start${r.error ? ` (could not restart it: ${r.error})` : ""}`
							: "not delivered (the session is not running)";
			stdout.write(`${what} · ${row.id} · ${row.name}\n`);
			return (!r.delivered && !r.saved) || r.error ? 1 : 0;
		});
	}

	async function cmdRespawn(args: string[]): Promise<number> {
		const all = args.includes("--all");
		const query = args.find((a) => a !== "--all");
		if (!all && !query) throw new UsageError("respawn needs <id|name> or --all");
		needPty("respawn");
		return withDaemon(async (c) => {
			const id = all ? undefined : (await findRow(c, query)).id;
			const { results } = await c.request("respawn", all ? { all: true } : { id, restart: true });
			let code = 0;
			for (const r of results) {
				stdout.write(`${r.error ? `failed: ${r.error}` : r.started ? "started" : "already running"} · ${r.id}\n`);
				if (r.error) code = 1;
			}
			if (all && results.length === 0) stdout.write("nothing to respawn\n");
			return code;
		});
	}

	/** M43: the event feed, oldest first; --follow polls for more (Ctrl+C ends it). */
	async function cmdLog(args: string[]): Promise<void> {
		const follow = args.includes("--follow") || args.includes("-f");
		const nAt = args.indexOf("-n");
		const limit = nAt === -1 ? 50 : Number(args[nAt + 1]);
		if (nAt !== -1 && !(limit > 0)) throw new UsageError("-n needs a count");
		const rest = args.filter((a, i) => a !== "--follow" && a !== "-f" && i !== nAt && i !== nAt + 1);
		if (rest.length > 1) throw new UsageError("log [-n <count>] [--follow] [<id|name>]");
		await withDaemon(async (c) => {
			const id = rest[0] ? (await c.request("resolve", { query: rest[0] })).id : undefined;
			const print = (events: RoostEvent[]) => {
				const now = Date.now();
				for (const e of events) stdout.write(`${eventAgo(e.at, now).padStart(4)} ago  ${eventLine(e)}\n`);
			};
			let { events, cursor } = await c.request("events", { limit, id });
			print(events);
			if (events.length === 0 && !follow) stdout.write("nothing happened yet\n");
			while (follow) {
				await new Promise((r) => setTimeout(r, 1000));
				({ events, cursor } = await c.request("events", { after: cursor, id }));
				print(events);
			}
		});
	}

	async function cmdList(args: string[]): Promise<void> {
		for (const a of args) {
			if (!["--all", "--json", "--cwd"].includes(a) && args[args.indexOf(a) - 1] !== "--cwd")
				throw new UsageError(`ls: unknown option ${a}`);
		}
		const all = args.includes("--all");
		const cwdAt = args.indexOf("--cwd");
		const cwd = cwdAt === -1 ? undefined : args[cwdAt + 1];
		if (cwdAt !== -1 && !cwd) throw new UsageError("--cwd needs a directory");
		const { jobs } = await withDaemon((c) => c.request("list", { all, cwd: cwd ? resolvePath(cwd) : undefined }));
		const now = Date.now();
		const rows = all ? jobs : jobs.filter((j) => j.endedAt === null || now - j.endedAt < ENDED_CUTOFF_MS);
		if (args.includes("--json")) stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
		else stdout.write(formatList(rows, { width: process.stdout.columns || 100 }));
	}

	/** Decision 8: a session the daemon runs does not make, change or run schedules (a person does). */
	function refuseInSession(what: string): void {
		if (readJobEnv(process.env, "id"))
			throw new DaemonError(
				`schedule ${what} is refused inside a background session (ROOST_JOB_ID is set): schedules are made by a person; run it from your own terminal or the hub`,
				"in_session",
			);
	}

	/** `--flag value` pairs taken out of the arguments; `--` ends them. */
	function flags(args: string[], known: string[]): { values: Record<string, string>; rest: string[] } {
		const values: Record<string, string> = {};
		const rest: string[] = [];
		for (let i = 0; i < args.length; i++) {
			const a = args[i]!;
			if (a === "--") {
				rest.push(...args.slice(i + 1));
				break;
			}
			const eq = a.indexOf("=");
			const name = a.startsWith("--") ? (eq === -1 ? a : a.slice(0, eq)) : undefined;
			if (name && known.includes(name)) {
				const v = eq === -1 ? args[++i] : a.slice(eq + 1);
				if (v === undefined || v === "") throw new UsageError(`${name} needs a value`);
				values[name.slice(2)] = v;
			} else if (name && a.length > 2) throw new UsageError(`schedule: unknown option ${name}`);
			else rest.push(a);
		}
		return { values, rest };
	}

	const nextText = (r: ScheduleRow) =>
		r.paused
			? "paused"
			: r.nextAt === null
				? `runs when asked: xpi roost schedule run ${r.name}`
				: `next run ${untilText(r.nextAt)} (${new Date(r.nextAt).toLocaleString()})`;

	function launchFor(input: ScheduleLaunchInput): DispatchArgs {
		if (!opts.scheduleLaunch) throw new DaemonError("schedules cannot be made here", "unsupported");
		return opts.scheduleLaunch(input);
	}

	async function cmdSchedule(sub: string | undefined, args: string[]): Promise<void> {
		switch (sub) {
			case "list":
			case "ls": {
				const json = args.includes("--json");
				for (const a of args) if (a !== "--json") throw new UsageError(`schedule list: unknown option ${a}`);
				// decision 5: without starting the service, as `daemon status`
				let rows: ScheduleRow[];
				let note = "";
				let client: DaemonClient | undefined;
				try {
					client = await DaemonClient.connect();
				} catch (err) {
					if (err instanceof DaemonError && err.code === "no_roost") throw err;
				}
				if (client) {
					try {
						await warnOnce(client);
						rows = (await client.request("schedules", {})).schedules;
					} finally {
						client.close();
					}
				} else {
					const saved = readJson<unknown>(join(roostHome(), "schedules.json"));
					rows = (Array.isArray(saved) ? (saved as Schedule[]) : [])
						.filter((x) => x && typeof x.name === "string" && x.launch && typeof x.launch.cwd === "string")
						.map(scheduleRow)
						.sort((a, b) => a.name.localeCompare(b.name));
					note =
						"the background service is not running: no schedule runs until it does (any xpi roost command but daemon and schedule list starts it)\n";
				}
				if (json) stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
				else stdout.write(formatSchedules(rows, { width: process.stdout.columns || 100 }));
				if (note) stderr.write(note);
				return;
			}
			case "add": {
				refuseInSession("add");
				const { values, rest } = flags(args, ["--cwd", "--model", "--thinking"]);
				const [name, ...words] = rest;
				if (!name || words.length === 0) throw new UsageError("schedule add <name> <when> <task>");
				if (!SCHEDULE_NAME.test(name))
					throw new UsageError(
						`not a schedule name: ${name} (a letter or digit, then up to 39 of A-Z a-z 0-9 _ . -)`,
					);
				const split = splitArgsWhen(words);
				if (!split) throw new UsageError(`schedule add <name> <when> <task>; when: ${WHEN_HELP}`);
				const task = split.task;
				if (!task.trim()) throw new UsageError("schedule add needs a task");
				parseWhenOrUsage(split.when);
				try {
					checkTask(task);
				} catch (err) {
					throw new UsageError((err as Error).message);
				}
				const cwd = resolvePath(values.cwd ?? process.cwd());
				if (!isDirectory(cwd)) throw new DaemonError(`no directory ${cwd}`, "bad_request");
				const launch = launchFor({ cwd, task, model: values.model, thinking: values.thinking, name });
				const row = await withDaemon((c) => c.request("schedule-add", { name, when: split.when, task, launch }));
				stdout.write(`added · ${row.name} · ${row.when} · ${nextText(row)}\n`);
				return;
			}
			case "edit": {
				refuseInSession("edit");
				const { values, rest } = flags(args, ["--when", "--task", "--model", "--thinking"]);
				const [name, ...extra] = rest;
				if (!name || extra.length > 0)
					throw new UsageError(
						"schedule edit <name> [--when <when>] [--task <task>] [--model <m>] [--thinking <t>]",
					);
				const when = values.when === undefined ? undefined : normalizeWhen(values.when);
				if (when !== undefined) parseWhenOrUsage(when);
				if (values.task !== undefined) {
					try {
						checkTask(values.task);
					} catch (err) {
						throw new UsageError((err as Error).message);
					}
				}
				const row = await withDaemon(async (c) => {
					const cur = (await c.request("schedules", {})).schedules.find((x) => x.name === name);
					if (!cur) throw new DaemonError(`no schedule named ${name}`, "not_found");
					// decision 8: what is not given keeps its stored value; the rest of the launch is built again here
					const task = values.task ?? cur.task ?? undefined;
					const launch = launchFor({
						cwd: cur.cwd,
						task,
						model: values.model ?? cur.model ?? undefined,
						thinking: values.thinking ?? cur.thinking ?? undefined,
						name,
					});
					return c.request("schedule-edit", {
						name,
						...(when !== undefined ? { when } : {}),
						...(values.task !== undefined ? { task: values.task } : {}),
						launch,
					});
				});
				stdout.write(`edited · ${row.name} · ${row.when} · ${nextText(row)}\n`);
				return;
			}
			case "run": {
				refuseInSession("run");
				const name = oneName(args, "run");
				await withDaemon(async (c) => {
					const r = await c.request("schedule-run", { name });
					const job = (await c.request("list", {})).jobs.find((j) => j.id === r.id);
					stdout.write(`started · ${r.id} · ${job?.name ?? name}\n`);
				});
				return;
			}
			case "pause":
			case "resume": {
				const name = oneName(args, sub);
				const row = await withDaemon((c) => c.request("schedule-pause", { name, paused: sub === "pause" }));
				stdout.write(`${sub === "pause" ? "paused" : "resumed"} · ${row.name} · ${nextText(row)}\n`);
				return;
			}
			case "rm": {
				const name = oneName(args, "rm");
				await withDaemon((c) => c.request("schedule-rm", { name }));
				stdout.write(`removed · ${name} (its runs stay listed until removed)\n`);
				return;
			}
			default:
				throw new UsageError(
					sub ? `schedule: unknown command ${sub}` : "schedule needs list, add, edit, run, pause, resume or rm",
				);
		}
	}

	async function cmdDaemon(sub: string | undefined, args: string[]): Promise<void> {
		if (sub === "logs") {
			const file = daemonLogPath();
			if (!existsSync(file)) throw new DaemonError(`no daemon log at ${file}`, "no_log");
			const lines = readFileSync(file, "utf8").trimEnd().split("\n");
			stdout.write(`${lines.slice(-50).join("\n")}\n`);
			return;
		}
		if (sub !== "status" && sub !== "stop") throw new UsageError("daemon needs status, logs or stop");
		let client: DaemonClient;
		try {
			client = await DaemonClient.connect();
		} catch (err) {
			if (err instanceof DaemonError && err.code === "no_roost") throw err;
			stdout.write(`daemon not running (socket dir ${runtimeDir()})\n`);
			return;
		}
		try {
			if (sub === "stop") {
				const keepWorkers = args.includes("--keep-workers");
				await client.request("shutdown", { keepWorkers });
				stdout.write(keepWorkers ? "daemon stopped; sessions kept running\n" : "daemon stopped\n");
				return;
			}
			const s = await client.request("status", {});
			if (s.version !== ROOST_VERSION) {
				stderr.write(
					`warning: the daemon is ${s.version}, this xpi is ${ROOST_VERSION}; restart it with: xpi roost daemon stop --keep-workers, then xpi roost respawn --all\n`,
				);
			}
			stdout.write(
				[
					`version     ${s.version}`,
					`pid         ${s.pid}`,
					`socket dir  ${s.socketDir}`,
					`sessions    ${s.liveJobs} live / ${s.totalJobs} total`,
					`node-pty    ${s.ptyError ? `failed: ${s.ptyError}` : "ok"}`,
					`up since    ${new Date(s.startedAt).toISOString()}`,
					"",
				].join("\n"),
			);
			if (s.ptyError) stderr.write(`${opts.ptyHint}\n`);
		} finally {
			client.close();
		}
	}

	const [cmd, ...rest] = argv;
	const usage = roostUsage(opts.detachKeyName);
	try {
		switch (cmd) {
			case "attach":
				await cmdAttach(rest[0]);
				return 0;
			case "logs":
				await cmdLogs(rest[0]);
				return 0;
			case "log":
				await cmdLog(rest);
				return 0;
			case "reply":
				return await cmdReply(rest[0], rest.slice(1));
			case "stop":
			case "rm":
				await cmdStopOrRm(cmd, rest[0]);
				return 0;
			case "respawn":
				return await cmdRespawn(rest);
			case "ls":
			case "list":
				await cmdList(rest);
				return 0;
			case "daemon":
				await cmdDaemon(rest[0], rest.slice(1));
				return 0;
			case "schedule":
			case "schedules":
				await cmdSchedule(rest[0], rest.slice(1));
				return 0;
			case "hub":
				if (opts.hub) return await opts.hub(rest);
				stderr.write("xpi roost: the hub is not available here; list sessions with: xpi roost ls\n");
				return 1;
			case undefined:
			case "help":
			case "-h":
			case "--help":
				stdout.write(`${usage}\n`);
				return cmd === undefined ? 2 : 0;
			default:
				throw new UsageError(`unknown command: ${cmd}`);
		}
	} catch (err) {
		if (err instanceof UsageError) {
			stderr.write(`xpi roost: ${err.message}\n\n${usage}\n`);
			return 2;
		}
		stderr.write(`xpi roost: ${(err as Error).message}\n`);
		return 1;
	}
}

function isDirectory(p: string): boolean {
	try {
		return statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function parseWhenOrUsage(when: string): void {
	try {
		parseWhen(when);
	} catch (err) {
		throw new UsageError((err as Error).message);
	}
}

function oneName(args: string[], what: string): string {
	if (args.length !== 1 || !args[0]) throw new UsageError(`schedule ${what} <name>`);
	return args[0];
}

/**
 * `<when> <task...>` as the shell split them: `every 2h`, `daily 09:00`, `weekly mon 09:00`, `manual`, or `cron` and
 * its five fields (one quoted argument, or five).
 */
export function splitArgsWhen(words: string[]): { when: string; task: string } | undefined {
	// a rule given as one argument ("every 2h", "cron 0 9 * * 1"): its words
	const first = words[0]?.trim().split(/\s+/) ?? [];
	const [w0, ...more] =
		first.length > 1 && /^(every|daily|weekdays|weekly|cron|manual)$/i.test(first[0]!)
			? [...first, ...words.slice(1)]
			: words;
	if (!w0) return undefined;
	const head = w0.toLowerCase();
	const take = (n: number) =>
		more.length >= n ? { when: [w0, ...more.slice(0, n)].join(" "), task: more.slice(n).join(" ") } : undefined;
	if (head === "manual") return { when: "manual", task: more.join(" ") };
	const norm = (r: { when: string; task: string } | undefined) => (r ? { ...r, when: normalizeWhen(r.when) } : r);
	if (head === "every" || head === "daily" || head === "weekdays") return norm(take(1));
	if (head === "weekly") return norm(take(2));
	if (head === "cron") {
		if (more[0] && more[0].trim().split(/\s+/).length === 5)
			return { when: normalizeWhen(`cron ${more[0]}`), task: more.slice(1).join(" ") };
		const r = take(5);
		return r ? { when: normalizeWhen(r.when), task: r.task } : undefined;
	}
	return undefined;
}
