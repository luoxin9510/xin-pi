/**
 * Spec 02, decision 5: the daemon as a per-user login service, so schedules run after a login without a client
 * starting the daemon. macOS: a launchd agent in `~/Library/LaunchAgents`; Linux: a systemd user unit. Named by the
 * agent directory's key, so two agent directories do not collide. It runs what `connectOrStart` runs (this Node with
 * the daemon's entry) with only the roost's location in its environment, once per login: no KeepAlive, no Restart=,
 * so `xpi roost daemon stop` is not undone.
 *
 * The files are made by pure functions; the commands (launchctl, systemctl), the home directory and the file system
 * are the caller's, so tests never touch the user's launchd or systemd.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DaemonError, type DaemonStart, daemonCommand, daemonLocation } from "./client.ts";
import { agentDirKey, roostHome } from "./paths.ts";

export type ServiceKind = "launchd" | "systemd";

/** What a service file is made of. */
export interface ServiceSpec {
	/** The launchd label or the systemd unit's name without `.service`. */
	name: string;
	execPath: string;
	args: string[];
	env: Record<string, string>;
	/** Where the daemon's stdout and stderr go (it writes its own log too). */
	logPath: string;
	agentDir: string;
}

/** A command's outcome (launchctl, systemctl). */
export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** What installing, removing and reading the service need; tests give fakes. */
export interface ServiceDeps {
	platform: NodeJS.Platform;
	/** The user's home directory (where `Library/LaunchAgents` or `.config/systemd/user` is). */
	home: string;
	uid: number;
	/** Runs launchctl or systemctl. */
	run(cmd: string, args: string[]): RunResult;
	/** The pid of the agent directory's daemon (the state lock's live holder), if one runs. */
	daemonPid(): number | undefined;
	/** Starts the daemon as any client does (`connectOrStart`: detached, outside the service). */
	startDaemon(): Promise<void>;
	sleep(ms: number): Promise<void>;
	/** How long a daemon stopped by `launchctl bootout` may take to release its lock (default 15 s). */
	stopTimeoutMs?: number;
}

export function defaultServiceDeps(daemonPid: () => number | undefined, startDaemon: () => Promise<void>): ServiceDeps {
	return {
		platform: process.platform,
		home: homedir(),
		uid: process.getuid?.() ?? 0,
		run: (cmd, args) => {
			const r = spawnSync(cmd, args, { encoding: "utf8" });
			return {
				code: r.status ?? (r.error ? 127 : 1),
				stdout: r.stdout ?? "",
				stderr: r.stderr ?? (r.error ? String(r.error.message) : ""),
			};
		},
		daemonPid,
		startDaemon,
		sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
	};
}

export function serviceKind(platform: NodeJS.Platform): ServiceKind | undefined {
	return platform === "darwin" ? "launchd" : platform === "linux" ? "systemd" : undefined;
}

/** The label (launchd) or unit name (systemd) of an agent directory's daemon. */
export function serviceName(kind: ServiceKind, agentDir: string): string {
	const key = agentDirKey(agentDir);
	return kind === "launchd" ? `dev.xpi.roost.${key}` : `xpi-roost-${key}`;
}

/** Where the service file goes. */
export function servicePath(kind: ServiceKind, home: string, name: string): string {
	return kind === "launchd"
		? join(home, "Library", "LaunchAgents", `${name}.plist`)
		: join(home, ".config", "systemd", "user", `${name}.service`);
}

/** The service of this roost: what it runs and where its output goes. */
export function serviceSpec(kind: ServiceKind, start: DaemonStart): ServiceSpec {
	const agentDir = resolve(start.agentDir);
	const run = daemonCommand(start);
	return {
		name: serviceName(kind, agentDir),
		execPath: run.execPath,
		args: run.args,
		env: daemonLocation(start),
		logPath: join(roostHome(agentDir), "service.log"),
		agentDir,
	};
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * A launchd agent: run at load (each login), never kept alive. AbandonProcessGroup: when the daemon exits, launchd
 * leaves the rest of its process group alone (the sessions' hosts are in groups of their own anyway). It does stop the
 * daemon itself on `launchctl bootout` (SIGTERM, which the daemon takes as `daemon stop --keep-workers`).
 */
export function launchdPlist(spec: ServiceSpec): string {
	const str = (s: string) => `<string>${xml(s)}</string>`;
	const env = Object.entries(spec.env)
		.map(([k, v]) => `\t\t<key>${xml(k)}</key>\n\t\t${str(v)}`)
		.join("\n");
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	${str(spec.name)}
	<key>ProgramArguments</key>
	<array>
${[spec.execPath, ...spec.args].map((a) => `\t\t${str(a)}`).join("\n")}
	</array>
	<key>EnvironmentVariables</key>
	<dict>
${env}
	</dict>
	<key>WorkingDirectory</key>
	${str("/")}
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<false/>
	<key>AbandonProcessGroup</key>
	<true/>
	<key>StandardOutPath</key>
	${str(spec.logPath)}
	<key>StandardErrorPath</key>
	${str(spec.logPath)}
</dict>
</plist>
`;
}

/**
 * systemd's quoting of one word: `%` (specifiers) always, `\` and `"` inside quotes, quoted when it needs to be. `$`
 * is doubled only in ExecStart, where systemd expands variables; Environment= does not, and `$$` would stay `$$`.
 */
function sdQuote(s: string, exec: boolean): string {
	let e = s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%");
	if (exec) e = e.replace(/\$/g, "$$$$");
	return /[\s"'\\;]/.test(s) || s === "" ? `"${e}"` : e;
}

/**
 * A systemd user unit: started once per login (default.target), never restarted; KillMode=process, so stopping the
 * daemon (also `daemon stop --keep-workers`) does not take the sessions in its cgroup with it.
 */
export function systemdUnit(spec: ServiceSpec): string {
	const env = Object.entries(spec.env).map(([k, v]) => `Environment=${sdQuote(`${k}=${v}`, false)}`);
	return `[Unit]
Description=xpi roost daemon (${spec.agentDir.replace(/%/g, "%%")})

[Service]
Type=simple
ExecStart=${[spec.execPath, ...spec.args].map((a) => sdQuote(a, true)).join(" ")}
${env.join("\n")}
WorkingDirectory=/
KillMode=process
StandardOutput=append:${spec.logPath.replace(/%/g, "%%")}
StandardError=append:${spec.logPath.replace(/%/g, "%%")}

[Install]
WantedBy=default.target
`;
}

export function serviceFile(kind: ServiceKind, spec: ServiceSpec): string {
	return kind === "launchd" ? launchdPlist(spec) : systemdUnit(spec);
}

/** What install and uninstall refuse before touching anything. */
function refuse(deps: ServiceDeps): ServiceKind {
	const kind = serviceKind(deps.platform);
	if (!kind) throw new Error(`a login service is for macOS (launchd) and Linux (systemd), not ${deps.platform}`);
	if (deps.uid === 0)
		throw new Error("the login service is per user: run this as yourself, not as root (do not use sudo)");
	return kind;
}

function failed(what: string, r: RunResult): Error {
	return new Error(`${what} failed (${r.code}): ${(r.stderr || r.stdout).trim() || "no output"}`);
}

/** The pid launchd has for the job, when it is loaded and its process runs (`launchctl print`'s `pid = N`). */
function launchdJobPid(deps: ServiceDeps, target: string): number | undefined {
	const r = deps.run("launchctl", ["print", target]);
	const m = r.code === 0 ? /^\s*pid = (\d+)\s*$/m.exec(r.stdout) : null;
	return m ? Number(m[1]) : undefined;
}

/**
 * `launchctl bootout` stops a running job's process: SIGTERM, which the daemon takes as `daemon stop --keep-workers`
 * (its sessions keep running). When the daemon was the job's process, waits until it has let go of the state lock, so
 * the next daemon can take it. Returns whether the service's daemon was stopped.
 */
async function bootout(deps: ServiceDeps, target: string, command: "install" | "uninstall"): Promise<boolean> {
	const jobPid = launchdJobPid(deps, target);
	const ours = jobPid !== undefined && deps.daemonPid() === jobPid;
	deps.run("launchctl", ["bootout", target]);
	if (!ours) return false;
	const timeout = deps.stopTimeoutMs ?? 15_000;
	for (let waited = 0; deps.daemonPid() === jobPid; waited += 100) {
		if (waited >= timeout)
			throw new Error(
				`the daemon (pid ${jobPid}) did not stop within ${Math.round(timeout / 1000)} s after launchctl bootout; the service file is still in place: run xpi roost daemon ${command} again once it has stopped (see xpi roost daemon logs)`,
			);
		await deps.sleep(100);
	}
	return true;
}

/**
 * Writes the service file and registers it. launchd: `bootout` of the one installed before (it stops the daemon that
 * one started; waited for), then `bootstrap`, whose RunAtLoad starts a daemon now (one that finds another already
 * running exits at once). systemd: `daemon-reload`, `enable`, and `start` only when no daemon runs (never a second
 * one). A failed registration removes the file again. Returns what was done, for the user.
 */
export async function installService(start: DaemonStart, deps: ServiceDeps): Promise<string> {
	const kind = refuse(deps);
	if (!existsSync(start.daemonEntry))
		throw new DaemonError(`daemon entry not found: ${start.daemonEntry}`, "not_built");
	const spec = serviceSpec(kind, start);
	const path = servicePath(kind, deps.home, spec.name);
	mkdirSync(dirname(path), { recursive: true });
	mkdirSync(dirname(spec.logPath), { recursive: true });
	const failedWith = (err: Error) => {
		rmSync(path, { force: true });
		return err;
	};
	if (kind === "launchd") {
		const domain = `gui/${deps.uid}`;
		const restarted = await bootout(deps, `${domain}/${spec.name}`, "install");
		const running = deps.daemonPid() !== undefined;
		writeFileSync(path, serviceFile(kind, spec));
		const r = deps.run("launchctl", ["bootstrap", domain, path]);
		if (r.code !== 0) throw failedWith(failed("launchctl bootstrap", r));
		const now = restarted
			? "the daemon it ran before was stopped and restarted under the new service (sessions kept running)"
			: running
				? "the daemon running now (started outside the service) keeps running"
				: "started now";
		return `installed ${path} (launchd ${spec.name}): the daemon starts at each login; ${now}`;
	}
	const running = deps.daemonPid() !== undefined;
	writeFileSync(path, serviceFile(kind, spec));
	const sd = (args: string[]) => deps.run("systemctl", ["--user", ...args]);
	let r = sd(["daemon-reload"]);
	if (r.code !== 0) throw failedWith(failed("systemctl --user daemon-reload", r));
	r = sd(["enable", `${spec.name}.service`]);
	if (r.code !== 0) {
		const err = failedWith(failed("systemctl --user enable", r));
		sd(["daemon-reload"]);
		throw err;
	}
	if (!running) {
		r = sd(["start", `${spec.name}.service`]);
		if (r.code !== 0) throw failed("systemctl --user start", r);
	}
	return `installed ${path} (systemd ${spec.name}.service): the daemon starts at each login; ${running ? "the daemon running now keeps running" : "started now"}`;
}

/**
 * Unregisters the service and removes its file. systemd: `disable` without `--now`, so the daemon keeps running.
 * launchd: `bootout` stops the daemon the service started (sessions keep running); it is started again as any client
 * starts it, outside the service, so schedules keep running. A daemon started outside the service is left alone.
 */
export async function uninstallService(agentDir: string, deps: ServiceDeps): Promise<string> {
	const kind = refuse(deps);
	const name = serviceName(kind, agentDir);
	const path = servicePath(kind, deps.home, name);
	if (!existsSync(path)) return "no login service installed for this agent directory";
	const removed = `removed ${path}: the daemon no longer starts at login`;
	if (kind === "launchd") {
		const stopped = await bootout(deps, `gui/${deps.uid}/${name}`, "uninstall");
		rmSync(path, { force: true });
		if (!stopped)
			return `${removed}${deps.daemonPid() !== undefined ? " (the daemon running now keeps running)" : ""}`;
		try {
			await deps.startDaemon();
		} catch (err) {
			const text = `${removed}, but starting the daemon again outside the service failed: ${(err as Error).message}; any xpi roost command starts it`;
			throw err instanceof DaemonError ? new DaemonError(text, err.code) : new Error(text);
		}
		return `${removed}; the daemon the service had started was stopped and started again outside the service (sessions kept running)`;
	}
	const r = deps.run("systemctl", ["--user", "disable", `${name}.service`]);
	if (r.code !== 0) throw failed("systemctl --user disable", r);
	rmSync(path, { force: true });
	deps.run("systemctl", ["--user", "daemon-reload"]);
	return `${removed}${deps.daemonPid() !== undefined ? " (the daemon running now keeps running)" : ""}`;
}

/** `daemon status`'s line: whether the service is installed, and for this xpi or another path. */
export function serviceStatus(start: DaemonStart, deps: Pick<ServiceDeps, "platform" | "home">): string {
	const kind = serviceKind(deps.platform);
	if (!kind) return "not available on this system";
	const spec = serviceSpec(kind, start);
	const path = servicePath(kind, deps.home, spec.name);
	if (!existsSync(path)) return "not installed (xpi roost daemon install)";
	let text = "";
	try {
		text = readFileSync(path, "utf8");
	} catch {}
	const current = text === serviceFile(kind, spec);
	return current
		? `installed (${kind} ${spec.name})`
		: `installed (${kind} ${spec.name}) for another xpi or setup: run xpi roost daemon install again`;
}
