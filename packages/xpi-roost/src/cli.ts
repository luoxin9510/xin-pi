// `xpi roost <subcommand>`: the command line over the daemon (pi-roost's bin/pi-roost.ts).
// xpi supplies what this library cannot know: the agent directory, the daemon's and the
// host's entry files, the detach key (the user's keybinding) and its own install hints.
import { existsSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { attachToHost, type DetachKeyMatcher } from "./lib/attach.ts";
import { DaemonClient, DaemonError, type DaemonStart, daemonEnv, requestOnce } from "./lib/client.ts";
import { eventAgo, eventLine, type RoostEvent } from "./lib/events.ts";
import { hostControl } from "./lib/hostclient.ts";
import { formatList } from "./lib/list-format.ts";
import { checkRuntimeDir, daemonLogPath, hostSocketPath, ROOST_LOCATION_ENV, runtimeDir } from "./lib/paths.ts";
import type { JobRow } from "./lib/protocol.ts";
import { ensureLive } from "./lib/resume.ts";
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
	/** How long a daemon may take to start (tests). */
	startTimeoutMs?: number;
	stdout?: Out;
	stderr?: Out;
}

const ENDED_CUTOFF_MS = 48 * 60 * 60 * 1000;

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
  xpi roost respawn --all          restart live and reaped sessions (after an upgrade)
  xpi roost daemon status|logs|stop [--keep-workers]
  xpi roost hub [dir]              the hub (not there yet)`;
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

	async function cmdDaemon(sub: string | undefined, args: string[]): Promise<void> {
		if (sub === "logs") {
			const file = daemonLogPath();
			if (!existsSync(file)) throw new DaemonError(`no daemon log at ${file}`, "no_log");
			const lines = readFileSync(file, "utf8").trimEnd().split("\n");
			stdout.write(`${lines.slice(-50).join("\n")}\n`);
			return;
		}
		if (sub === "run") {
			// internal: the daemon in this process (its entry file runs when it is loaded)
			await import(pathToFileURL(start.daemonEntry).href);
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
			case "hub":
				stderr.write("xpi roost: the hub is not in this version of xpi yet; list sessions with: xpi roost ls\n");
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
