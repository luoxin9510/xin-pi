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
import { dirname, join, resolve } from "node:path";
import { type DaemonStart, daemonCommand, daemonLocation } from "./client.ts";
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
	/** Whether the agent directory's daemon answers now. */
	daemonRunning(): Promise<boolean>;
}

export function defaultServiceDeps(daemonRunning: () => Promise<boolean>): ServiceDeps {
	return {
		platform: process.platform,
		home: process.env.HOME ?? "",
		uid: process.getuid?.() ?? 0,
		run: (cmd, args) => {
			const r = spawnSync(cmd, args, { encoding: "utf8" });
			return {
				code: r.status ?? (r.error ? 127 : 1),
				stdout: r.stdout ?? "",
				stderr: r.stderr ?? (r.error ? String(r.error.message) : ""),
			};
		},
		daemonRunning,
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
 * leaves the sessions' processes alone (their hosts are in groups of their own anyway).
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

/** systemd's quoting of one word of ExecStart or Environment: `%` and `$` escaped, quoted when it needs to be. */
function sdQuote(s: string): string {
	const e = s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$$$");
	return /[\s"'\\;]/.test(s) || s === "" ? `"${e}"` : e;
}

/**
 * A systemd user unit: started once per login (default.target), never restarted; KillMode=process, so stopping the
 * daemon (also `daemon stop --keep-workers`) does not take the sessions in its cgroup with it.
 */
export function systemdUnit(spec: ServiceSpec): string {
	const env = Object.entries(spec.env).map(([k, v]) => `Environment=${sdQuote(`${k}=${v}`)}`);
	return `[Unit]
Description=xpi roost daemon (${spec.agentDir.replace(/%/g, "%%")})

[Service]
Type=simple
ExecStart=${[spec.execPath, ...spec.args].map(sdQuote).join(" ")}
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

const unsupported = (platform: string) =>
	new Error(`a login service is for macOS (launchd) and Linux (systemd), not ${platform}`);

function failed(what: string, r: RunResult): Error {
	return new Error(`${what} failed (${r.code}): ${(r.stderr || r.stdout).trim() || "no output"}`);
}

/**
 * Writes the service file and registers it. launchd: `bootout` of an older one, then `bootstrap` (RunAtLoad starts a
 * daemon now; one that finds another already running exits at once). systemd: `daemon-reload`, `enable`, and `start`
 * only when no daemon answers (never a second one). Returns what was done, for the user.
 */
export async function installService(start: DaemonStart, deps: ServiceDeps): Promise<string> {
	const kind = serviceKind(deps.platform);
	if (!kind) throw unsupported(deps.platform);
	const spec = serviceSpec(kind, start);
	const path = servicePath(kind, deps.home, spec.name);
	mkdirSync(dirname(path), { recursive: true });
	mkdirSync(dirname(spec.logPath), { recursive: true });
	const running = await deps.daemonRunning();
	if (kind === "launchd") {
		const domain = `gui/${deps.uid}`;
		// an older one (another xpi path): replaced
		deps.run("launchctl", ["bootout", `${domain}/${spec.name}`]);
		writeFileSync(path, serviceFile(kind, spec));
		const r = deps.run("launchctl", ["bootstrap", domain, path]);
		if (r.code !== 0) throw failed("launchctl bootstrap", r);
		return `installed ${path} (launchd ${spec.name}): the daemon starts at each login${running ? "; the one running now keeps running" : "; started now"}`;
	}
	writeFileSync(path, serviceFile(kind, spec));
	const sd = (args: string[]) => deps.run("systemctl", ["--user", ...args]);
	let r = sd(["daemon-reload"]);
	if (r.code !== 0) throw failed("systemctl --user daemon-reload", r);
	r = sd(["enable", `${spec.name}.service`]);
	if (r.code !== 0) throw failed("systemctl --user enable", r);
	if (!running) {
		r = sd(["start", `${spec.name}.service`]);
		if (r.code !== 0) throw failed("systemctl --user start", r);
	}
	return `installed ${path} (systemd ${spec.name}.service): the daemon starts at each login${running ? "; the one running now keeps running" : "; started now"}`;
}

/**
 * Unregisters the service and removes its file. The daemon running now keeps running (stop it with `daemon stop`):
 * launchd's `bootout` of a job whose process left its group, and systemd's `disable` without `--now`.
 */
export async function uninstallService(agentDir: string, deps: ServiceDeps): Promise<string> {
	const kind = serviceKind(deps.platform);
	if (!kind) throw unsupported(deps.platform);
	const name = serviceName(kind, agentDir);
	const path = servicePath(kind, deps.home, name);
	if (!existsSync(path)) return "no login service installed for this agent directory";
	if (kind === "launchd") {
		deps.run("launchctl", ["bootout", `gui/${deps.uid}/${name}`]);
		rmSync(path, { force: true });
	} else {
		const r = deps.run("systemctl", ["--user", "disable", `${name}.service`]);
		if (r.code !== 0) throw failed("systemctl --user disable", r);
		rmSync(path, { force: true });
		deps.run("systemctl", ["--user", "daemon-reload"]);
	}
	return `removed ${path}: the daemon no longer starts at login (the one running now keeps running)`;
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
