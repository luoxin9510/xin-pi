// Spec 02, decision 5 (S11): the login service. The files are pure text; install, uninstall and status run with a fake
// launchctl/systemctl and a temporary home, so nothing touches the user's launchd or systemd.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DaemonError, daemonCommand, daemonLocation } from "../src/lib/client.ts";
import { TEST_DIR_PREFIX } from "../src/lib/orphans.ts";
import { agentDirKey, ROOST_LOCATION_ENV } from "../src/lib/paths.ts";
import {
	installService,
	launchdPlist,
	type RunResult,
	type ServiceDeps,
	type ServiceSpec,
	serviceName,
	servicePath,
	serviceSpec,
	serviceStatus,
	systemdUnit,
	uninstallService,
} from "../src/lib/service.ts";

const saved: Record<string, string | undefined> = {};
let dir: string;

beforeEach(() => {
	for (const k of [...ROOST_LOCATION_ENV, "XDG_RUNTIME_DIR"]) {
		saved[k] = process.env[k];
		delete process.env[k];
	}
	dir = mkdtempSync(join(tmpdir(), `${TEST_DIR_PREFIX}service-`));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

const spec: ServiceSpec = {
	name: "dev.xpi.roost.0123456789ab",
	execPath: "/opt/my node/bin/node",
	args: ["/opt/xpi/dist/roost/daemon.js"],
	env: {
		ROOST_AGENT_DIR: "/home/u/.xpi/agent",
		ROOST_HOME: "/home/u/a&b<c>",
		ROOST_RUNTIME_DIR: "/run/user/1000/x%y$z",
	},
	logPath: "/home/u/.xpi/agent/xpi-roost/service.log",
	agentDir: "/home/u/.xpi/agent",
};

describe("service files", () => {
	it("launchd: run at load, never kept alive, the daemon's command and location, output to the log", () => {
		const plist = launchdPlist(spec);
		expect(plist).toContain("<key>Label</key>\n\t<string>dev.xpi.roost.0123456789ab</string>");
		expect(plist).toContain(
			"<array>\n\t\t<string>/opt/my node/bin/node</string>\n\t\t<string>/opt/xpi/dist/roost/daemon.js</string>\n\t</array>",
		);
		expect(plist).toContain("<key>RunAtLoad</key>\n\t<true/>");
		expect(plist).toContain("<key>KeepAlive</key>\n\t<false/>");
		expect(plist).toContain("<key>AbandonProcessGroup</key>\n\t<true/>");
		expect(plist).toContain("<key>ROOST_HOME</key>\n\t\t<string>/home/u/a&amp;b&lt;c&gt;</string>");
		expect(plist).toContain(`<key>StandardOutPath</key>\n\t<string>${spec.logPath}</string>`);
		expect(plist).toContain(`<key>StandardErrorPath</key>\n\t<string>${spec.logPath}</string>`);
		expect(plist).not.toContain("PATH</key>");
	});

	it("systemd: started once per login, never restarted, KillMode=process, quoted command and location", () => {
		const unit = systemdUnit(spec);
		expect(unit).toContain("Type=simple\n");
		expect(unit).toContain('ExecStart="/opt/my node/bin/node" /opt/xpi/dist/roost/daemon.js\n');
		expect(unit).toContain("Environment=ROOST_AGENT_DIR=/home/u/.xpi/agent\n");
		// Environment= does not expand `$`: only `%` is escaped there; ExecStart doubles `$`
		expect(unit).toContain("Environment=ROOST_RUNTIME_DIR=/run/user/1000/x%%y$z\n");
		expect(systemdUnit({ ...spec, args: ["/a$b%c"] })).toContain('ExecStart="/opt/my node/bin/node" /a$$b%%c\n');
		expect(unit).toContain("KillMode=process\n");
		expect(unit).toContain(`StandardOutput=append:${spec.logPath}\n`);
		expect(unit).toContain("[Install]\nWantedBy=default.target\n");
		expect(unit).not.toMatch(/^Restart=/m);
	});

	it("runs what connectOrStart runs: this node, the daemon entry, the roost's location", () => {
		const start = { agentDir: join(dir, "agent"), daemonEntry: "/x/daemon.js", hostEntry: "/x/host.js" };
		const s = serviceSpec("systemd", start);
		const run = daemonCommand(start);
		expect([s.execPath, ...s.args]).toEqual([run.execPath, ...run.args]);
		expect([s.execPath, ...s.args]).toEqual([process.execPath, "/x/daemon.js"]);
		expect(s.env).toEqual(daemonLocation(start));
		expect(Object.keys(s.env).sort()).toEqual([...ROOST_LOCATION_ENV].sort());
		expect(s.name).toBe(`xpi-roost-${agentDirKey(start.agentDir)}`);
		expect(serviceName("launchd", start.agentDir)).toBe(`dev.xpi.roost.${agentDirKey(start.agentDir)}`);
		expect(s.logPath).toBe(join(dir, "agent", "xpi-roost", "service.log"));
	});
});

describe("install, uninstall, status with fakes", () => {
	interface Fake {
		calls: string[][];
		deps: ServiceDeps;
		/** The daemon's pid (the state lock's holder), launchd's pid for the job, starts done outside the service. */
		state: { pid?: number; jobPid?: number; started: number; sleeps: number };
	}
	/** A fake launchctl/systemctl: `bootout` of a job whose process is the daemon stops it after a few polls. */
	function fake(platform: NodeJS.Platform, opts: { pid?: number; jobPid?: number; fail?: string; uid?: number } = {}) {
		const calls: string[][] = [];
		const state: Fake["state"] = { pid: opts.pid, jobPid: opts.jobPid, started: 0, sleeps: 0 };
		let stopping = 0;
		const deps: ServiceDeps = {
			platform,
			home: join(dir, "home"),
			uid: opts.uid ?? 1000,
			run: (cmd, args): RunResult => {
				calls.push([cmd, ...args]);
				if (args.includes(opts.fail ?? "\0")) return { code: 1, stdout: "", stderr: `${opts.fail} refused` };
				if (args[0] === "print")
					return state.jobPid === undefined
						? { code: 113, stdout: "", stderr: "Could not find service" }
						: { code: 0, stdout: `x = {\n\tstate = running\n\tpid = ${state.jobPid}\n}\n`, stderr: "" };
				if (args[0] === "bootout" && state.jobPid !== undefined) {
					if (state.pid === state.jobPid) stopping = 3;
					state.jobPid = undefined;
				}
				if (args[0] === "bootstrap") calls.push([`daemon pid at bootstrap: ${state.pid ?? "none"}`]);
				return { code: 0, stdout: "", stderr: "" };
			},
			daemonPid: () => state.pid,
			startDaemon: async () => {
				state.started++;
				state.pid = 4242;
			},
			sleep: async () => {
				state.sleeps++;
				if (stopping > 0 && --stopping === 0) state.pid = undefined;
			},
		};
		return { calls, deps, state };
	}
	const start = () => {
		const daemonEntry = join(dir, "daemon.js");
		writeFileSync(daemonEntry, "");
		return { agentDir: join(dir, "agent"), daemonEntry, hostEntry: "/x/host.js" };
	};
	const verbs = (calls: string[][]) =>
		calls.map((c) => (c[0]!.startsWith("daemon pid") ? c[0]! : c.slice(0, 3).join(" ")));

	it("macOS: writes the plist and bootstraps it (starting the daemon); uninstall boots it out and removes it", async () => {
		const { calls, deps } = fake("darwin");
		const name = serviceName("launchd", start().agentDir);
		const file = servicePath("launchd", deps.home, name);
		expect(file).toBe(join(dir, "home", "Library", "LaunchAgents", `${name}.plist`));
		expect(serviceStatus(start(), deps)).toBe("not installed (xpi roost daemon install)");
		const text = await installService(start(), deps);
		expect(text).toBe(`installed ${file} (launchd ${name}): the daemon starts at each login; started now`);
		expect(readFileSync(file, "utf8")).toBe(launchdPlist(serviceSpec("launchd", start())));
		expect(calls).toEqual([
			["launchctl", "print", `gui/1000/${name}`],
			["launchctl", "bootout", `gui/1000/${name}`],
			["launchctl", "bootstrap", "gui/1000", file],
			["daemon pid at bootstrap: none"],
		]);
		expect(serviceStatus(start(), deps)).toBe(`installed (launchd ${name})`);
		calls.length = 0;
		expect(await uninstallService(start().agentDir, deps)).toBe(
			`removed ${file}: the daemon no longer starts at login`,
		);
		expect(verbs(calls)).toEqual([`launchctl print gui/1000/${name}`, `launchctl bootout gui/1000/${name}`]);
		expect(existsSync(file)).toBe(false);
	});

	it("macOS uninstall: the service's daemon is stopped by bootout, waited for, and started again outside it", async () => {
		const f = fake("darwin", { pid: 777 });
		await installService(start(), f.deps);
		f.state.jobPid = 777; // launchd started this daemon
		const file = servicePath("launchd", f.deps.home, serviceName("launchd", start().agentDir));
		const text = await uninstallService(start().agentDir, f.deps);
		expect(text).toBe(
			`removed ${file}: the daemon no longer starts at login; the daemon the service had started was stopped and started again outside the service (sessions kept running)`,
		);
		expect(f.state.sleeps).toBe(3); // until it let go of the lock
		expect(f.state.started).toBe(1);
		expect(f.state.pid).toBe(4242);
	});

	it("macOS uninstall: a daemon that does not stop, or does not start again, is said plainly", async () => {
		const f = fake("darwin", { pid: 777 });
		await installService(start(), f.deps);
		const file = servicePath("launchd", f.deps.home, serviceName("launchd", start().agentDir));
		f.state.jobPid = 777;
		f.deps.sleep = async () => {};
		f.deps.stopTimeoutMs = 200;
		await expect(uninstallService(start().agentDir, f.deps)).rejects.toThrow(
			"the service file is still in place: run xpi roost daemon uninstall again once it has stopped",
		);
		expect(existsSync(file)).toBe(true);

		const g = fake("darwin", { pid: 777 });
		await installService(start(), g.deps);
		g.state.jobPid = 777;
		g.deps.startDaemon = async () => {
			throw new DaemonError("daemon entry not found: /gone.js", "not_built");
		};
		await expect(uninstallService(start().agentDir, g.deps)).rejects.toMatchObject({
			code: "not_built",
			message: `removed ${file}: the daemon no longer starts at login, but starting the daemon again outside the service failed: daemon entry not found: /gone.js; any xpi roost command starts it`,
		});
		expect(existsSync(file)).toBe(false);
	});

	it("macOS uninstall: a daemon started outside the service is left alone", async () => {
		const f = fake("darwin", { pid: 777 });
		await installService(start(), f.deps);
		f.state.jobPid = 555; // the job's own daemon, about to exit on the lock another daemon holds
		const text = await uninstallService(start().agentDir, f.deps);
		expect(text).toContain("(the daemon running now keeps running)");
		expect(f.state.started).toBe(0);
		expect(f.state.sleeps).toBe(0);
	});

	it("macOS reinstall: bootout stops the old service's daemon, waits for its lock, then bootstraps", async () => {
		const f = fake("darwin", { pid: 777 });
		await installService(start(), f.deps);
		f.state.jobPid = 777;
		f.calls.length = 0;
		const text = await installService(start(), f.deps);
		expect(text).toContain(
			"the daemon it ran before was stopped and restarted under the new service (sessions kept running)",
		);
		const name = serviceName("launchd", start().agentDir);
		expect(verbs(f.calls)).toEqual([
			`launchctl print gui/1000/${name}`,
			`launchctl bootout gui/1000/${name}`,
			"launchctl bootstrap gui/1000",
			"daemon pid at bootstrap: none",
		]);
		expect(f.state.sleeps).toBe(3);
		expect(f.state.started).toBe(0); // RunAtLoad starts the new one
	});

	it("macOS: a daemon that does not stop after bootout is an error, not a second daemon", async () => {
		const f = fake("darwin", { pid: 777, jobPid: 777 });
		f.deps.sleep = async () => {
			f.state.sleeps++;
		};
		f.deps.stopTimeoutMs = 500;
		await expect(installService(start(), f.deps)).rejects.toThrow(
			"did not stop within 1 s after launchctl bootout; the service file is still in place: run xpi roost daemon install again once it has stopped",
		);
		expect(f.calls.some((c) => c[1] === "bootstrap")).toBe(false);
		expect(f.state.sleeps).toBe(5);
	});

	it("macOS: another daemon running at install keeps running; a failed bootstrap removes the plist", async () => {
		const f = fake("darwin", { pid: 777 });
		expect(await installService(start(), f.deps)).toContain(
			"the daemon running now (started outside the service) keeps running",
		);
		const bad = fake("darwin", { fail: "bootstrap" });
		await expect(installService(start(), bad.deps)).rejects.toThrow(
			"launchctl bootstrap failed (1): bootstrap refused",
		);
		expect(serviceStatus(start(), bad.deps)).toBe("not installed (xpi roost daemon install)");
	});

	it("Linux: enables the unit and starts it only when no daemon runs", async () => {
		const name = serviceName("systemd", start().agentDir);
		const idle = fake("linux");
		const file = servicePath("systemd", idle.deps.home, name);
		expect(file).toBe(join(dir, "home", ".config", "systemd", "user", `${name}.service`));
		expect(await installService(start(), idle.deps)).toContain("started now");
		expect(idle.calls).toEqual([
			["systemctl", "--user", "daemon-reload"],
			["systemctl", "--user", "enable", `${name}.service`],
			["systemctl", "--user", "start", `${name}.service`],
		]);
		expect(readFileSync(file, "utf8")).toBe(systemdUnit(serviceSpec("systemd", start())));

		// a daemon already runs: never a second one
		const busy = fake("linux", { pid: 777 });
		expect(await installService(start(), busy.deps)).toContain("the daemon running now keeps running");
		expect(busy.calls.map((c) => c[2])).toEqual(["daemon-reload", "enable"]);

		busy.calls.length = 0;
		expect(await uninstallService(start().agentDir, busy.deps)).toBe(
			`removed ${file}: the daemon no longer starts at login (the daemon running now keeps running)`,
		);
		expect(busy.calls).toEqual([
			["systemctl", "--user", "disable", `${name}.service`],
			["systemctl", "--user", "daemon-reload"],
		]);
		expect(existsSync(file)).toBe(false);
	});

	it("Linux: a failed daemon-reload or enable removes the unit, so status does not say installed", async () => {
		for (const fail of ["daemon-reload", "enable"]) {
			const f = fake("linux", { fail });
			await expect(installService(start(), f.deps)).rejects.toThrow(`systemctl --user ${fail} failed (1)`);
			expect(serviceStatus(start(), f.deps)).toBe("not installed (xpi roost daemon install)");
		}
	});

	it("refuses before touching anything: no daemon entry (not_built), root, other systems", async () => {
		const f = fake("darwin");
		const missing = { ...start(), daemonEntry: join(dir, "nope.js") };
		await expect(installService(missing, f.deps)).rejects.toMatchObject({ code: "not_built" });
		const root = fake("linux", { uid: 0 });
		await expect(installService(start(), root.deps)).rejects.toThrow("do not use sudo");
		await expect(uninstallService(start().agentDir, root.deps)).rejects.toThrow("do not use sudo");
		const win = fake("win32");
		expect(serviceStatus(start(), win.deps)).toBe("not available on this system");
		await expect(installService(start(), win.deps)).rejects.toThrow("not win32");
		await expect(uninstallService(start().agentDir, win.deps)).rejects.toThrow("not win32");
		expect([...f.calls, ...root.calls, ...win.calls]).toEqual([]);
		expect(existsSync(join(dir, "home"))).toBe(false);
	});

	it("status: a file for another xpi path says to install again", async () => {
		const { deps } = fake("linux", { pid: 777 });
		await installService(start(), deps);
		const moved = { ...start(), daemonEntry: "/elsewhere/daemon.js" };
		expect(serviceStatus(moved, deps)).toContain("run xpi roost daemon install again");
		writeFileSync(servicePath("systemd", deps.home, serviceName("systemd", start().agentDir)), "");
		expect(serviceStatus(start(), deps)).toContain("run xpi roost daemon install again");
	});
});
