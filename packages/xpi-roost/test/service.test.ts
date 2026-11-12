// Spec 02, decision 5 (S11): the login service. The files are pure text; install, uninstall and status run with a fake
// launchctl/systemctl and a temporary home, so nothing touches the user's launchd or systemd.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { daemonCommand, daemonLocation } from "../src/lib/client.ts";
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
		expect(unit).toContain("Environment=ROOST_RUNTIME_DIR=/run/user/1000/x%%y$$z\n");
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
	function fake(platform: NodeJS.Platform, running: boolean, fail?: string) {
		const calls: string[][] = [];
		const deps: ServiceDeps = {
			platform,
			home: join(dir, "home"),
			uid: 1000,
			run: (cmd, args): RunResult => {
				calls.push([cmd, ...args]);
				return args.includes(fail ?? "\0")
					? { code: 1, stdout: "", stderr: `${fail} refused` }
					: { code: 0, stdout: "", stderr: "" };
			},
			daemonRunning: async () => running,
		};
		return { calls, deps };
	}
	const start = () => ({ agentDir: join(dir, "agent"), daemonEntry: "/x/daemon.js", hostEntry: "/x/host.js" });

	it("macOS: writes the plist, boots out an older one, bootstraps; uninstall boots out and removes it", async () => {
		const { calls, deps } = fake("darwin", false);
		const name = serviceName("launchd", start().agentDir);
		const file = servicePath("launchd", deps.home, name);
		expect(file).toBe(join(dir, "home", "Library", "LaunchAgents", `${name}.plist`));
		expect(serviceStatus(start(), deps)).toBe("not installed (xpi roost daemon install)");
		const text = await installService(start(), deps);
		expect(text).toContain(`installed ${file}`);
		expect(readFileSync(file, "utf8")).toBe(launchdPlist(serviceSpec("launchd", start())));
		expect(calls).toEqual([
			["launchctl", "bootout", `gui/1000/${name}`],
			["launchctl", "bootstrap", "gui/1000", file],
		]);
		expect(serviceStatus(start(), deps)).toBe(`installed (launchd ${name})`);
		calls.length = 0;
		await uninstallService(start().agentDir, deps);
		expect(calls).toEqual([["launchctl", "bootout", `gui/1000/${name}`]]);
		expect(existsSync(file)).toBe(false);
	});

	it("macOS: a failed bootstrap is an error", async () => {
		const { deps } = fake("darwin", false, "bootstrap");
		await expect(installService(start(), deps)).rejects.toThrow("launchctl bootstrap failed (1): bootstrap refused");
	});

	it("Linux: enables the unit and starts it only when no daemon runs", async () => {
		const name = serviceName("systemd", start().agentDir);
		const idle = fake("linux", false);
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
		const busy = fake("linux", true);
		expect(await installService(start(), busy.deps)).toContain("the one running now keeps running");
		expect(busy.calls.map((c) => c[2])).toEqual(["daemon-reload", "enable"]);

		busy.calls.length = 0;
		await uninstallService(start().agentDir, busy.deps);
		expect(busy.calls).toEqual([
			["systemctl", "--user", "disable", `${name}.service`],
			["systemctl", "--user", "daemon-reload"],
		]);
		expect(existsSync(file)).toBe(false);
	});

	it("status: a file for another xpi path says to install again; other systems are not supported", async () => {
		const { deps } = fake("linux", true);
		await installService(start(), deps);
		const moved = { ...start(), daemonEntry: "/elsewhere/daemon.js" };
		expect(serviceStatus(moved, deps)).toContain("run xpi roost daemon install again");
		writeFileSync(servicePath("systemd", deps.home, serviceName("systemd", start().agentDir)), "");
		expect(serviceStatus(start(), deps)).toContain("run xpi roost daemon install again");
		const win = fake("win32", false);
		expect(serviceStatus(start(), win.deps)).toBe("not available on this system");
		await expect(installService(start(), win.deps)).rejects.toThrow("not win32");
		await expect(uninstallService(start().agentDir, win.deps)).rejects.toThrow("not win32");
		expect(win.calls).toEqual([]);
	});
});
