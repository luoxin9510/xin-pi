// `xpi roost`: what xpi supplies to xpi-roost (entry files, the detach key from the keybindings, the settings
// section) and the messages when roost cannot run here. The commands themselves are tested in xpi-roost against a
// real daemon; the last test here runs two through runRoostCommand with xpi-roost's built entries.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Compile } from "typebox/compile";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonClient } from "xpi-roost";
import { resolveRoostEntries } from "../src/config.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { SettingsSchema } from "../src/core/settings-schema.ts";
import {
	BINARY_MESSAGE,
	detachMatcher,
	PTY_HINT,
	roostUnavailable,
	runRoostCommand,
	WINDOWS_MESSAGE,
} from "../src/extensions/roost/cli.ts";
import { roostSettings } from "../src/extensions/roost/settings.ts";

const made: string[] = [];
const ENV_NAMES = ["ROOST_AGENT_DIR", "ROOST_HOME", "ROOST_RUNTIME_DIR", "ROOST_HOST_ENTRY", "ROOST_PARENT_PID"];
const saved: Record<string, string | undefined> = {};
for (const k of ENV_NAMES) saved[k] = process.env[k];

afterEach(() => {
	for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

describe("where roost cannot run", () => {
	const entries = { daemonEntry: "/d.js", hostEntry: "/h.js" };
	it("Windows and a standalone binary: each says what to do", () => {
		expect(roostUnavailable({ platform: "win32", entries })).toBe(WINDOWS_MESSAGE);
		expect(WINDOWS_MESSAGE).toMatch(/not supported on Windows.*WSL/);
		expect(roostUnavailable({ platform: "win32", entries: undefined })).toBe(WINDOWS_MESSAGE);
		expect(roostUnavailable({ platform: "darwin", entries: undefined })).toBe(BINARY_MESSAGE);
		expect(BINARY_MESSAGE).toContain("npm install -g xpi-coding-agent");
		expect(roostUnavailable({ platform: "linux", entries })).toBeUndefined();
		// a missing node-pty is not one of them: see the last test
		expect(PTY_HINT).toMatch(/npm install -g xpi-coding-agent.*python3, make and a C\+\+ compiler/);
	});
});

describe("the daemon's and the host's entry files", () => {
	it("none in a standalone binary; next to the bundle's chunk; xpi-roost's built files unbundled", () => {
		expect(resolveRoostEntries("bun-binary", "file:///B:/~BUN/root/config.js")).toBeUndefined();
		expect(resolveRoostEntries("bundled-node", "file:///app/chunks/config.js")).toEqual({
			daemonEntry: "/app/chunks/roost-daemon.js",
			hostEntry: "/app/chunks/roost-host.js",
		});
		const unbundled = resolveRoostEntries("unbundled", import.meta.url)!;
		expect(unbundled.daemonEntry).toMatch(/packages\/xpi-roost\/dist\/daemon\/main\.js$/);
		expect(unbundled.hostEntry).toMatch(/packages\/xpi-roost\/dist\/host\/main\.js$/);
	});
});

describe("the detach key (decision 11)", () => {
	it("is the user's app.suspend in every encoding a terminal sends, pressed not released", () => {
		const isDetach = detachMatcher(new KeybindingsManager({}));
		for (const key of [
			"\x1a",
			"\x1b[122;5u",
			"\x1b[122;5:2u", // repeat
			"\x1b[122;69u", // Caps Lock
			"\x1b[122;133u", // Num Lock
			"\x1b[122:90;5u", // alternate keys
			"\x1b[122::122;5;26u", // associated text
			"\x1b[27;5;122~", // modifyOtherKeys
		])
			expect(isDetach(key), JSON.stringify(key)).toBe(true);
		for (const key of ["\x1b[122;5:3u", "\x1b[122;6u", "\x1b[122;7u", "z", "\x1b[122u", "\x03"])
			expect(isDetach(key), JSON.stringify(key)).toBe(false);
	});

	it("follows a rebound key, and none when it is unbound", () => {
		const rebound = detachMatcher(new KeybindingsManager({ "app.suspend": "ctrl+b" }));
		expect(rebound("\x02")).toBe(true);
		expect(rebound("\x1a")).toBe(false);
		const unbound = detachMatcher(new KeybindingsManager({ "app.suspend": [] }));
		expect(unbound("\x1a")).toBe(false);
	});
});

describe('the "roost" settings section (T12)', () => {
	it("is in the settings schema", () => {
		const check = Compile(SettingsSchema);
		expect(
			check.Check({ roost: { reapIdleMinutes: 30, workspaceEnv: "direnv", presets: { fast: { model: "a/b" } } } }),
		).toBe(true);
		expect(check.Check({ roost: { workspaceEnv: "sometimes" } })).toBe(false);
		expect(check.Check({ roost: { cleanupDays: -1 } })).toBe(false);
	});

	it("merges the user's and a project's, and a project cannot set the environment keys", () => {
		const global = SettingsManager.inMemory({ roost: { reapIdleMinutes: 30, envAllowList: ["MINE"] } } as never);
		expect(roostSettings(global)).toMatchObject({ reapIdleMinutes: 30, envAllowList: ["MINE"], cleanupDays: 30 });
		const both = {
			getGlobalSettings: () =>
				({ roost: { reapIdleMinutes: 30, inheritEnv: true, envAllowList: ["MINE"] } }) as never,
			getProjectSettings: () =>
				({
					roost: {
						reapIdleMinutes: 5,
						inheritEnv: false,
						envAllowList: ["AWS_SECRET_ACCESS_KEY"],
						envDenyList: ["X"],
					},
				}) as never,
		};
		expect(roostSettings(both)).toMatchObject({
			reapIdleMinutes: 5,
			inheritEnv: true,
			envAllowList: ["MINE"],
			envDenyList: [],
		});
	});
});

describe("xpi roost through xpi's wrapper", () => {
	it("starts xpi-roost's built daemon for the agent directory and stops it", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "xroost-ca-"));
		made.push(agentDir);
		writeFileSync(join(agentDir, "keybindings.json"), JSON.stringify({ "app.suspend": "ctrl+b" }));
		process.env.ROOST_PARENT_PID = String(process.pid);
		const out: string[] = [];
		const write = process.stdout.write.bind(process.stdout);
		process.stdout.write = ((s: string) => {
			out.push(String(s));
			return true;
		}) as typeof process.stdout.write;
		let code: number;
		try {
			expect(await runRoostCommand(["--help"], { agentDir })).toBe(0);
			code = await runRoostCommand(["ls"], { agentDir });
		} finally {
			process.stdout.write = write;
		}
		expect(out.join("")).toContain("ctrl+b detaches");
		expect(code).toBe(0);
		expect(out.join("")).toContain("no background sessions");
		expect(existsSync(join(agentDir, "xpi-roost", "jobs"))).toBe(true);

		// without node-pty here: listing still works, starting a session process is refused with the hint
		const err: string[] = [];
		const writeErr = process.stderr.write.bind(process.stderr);
		process.stdout.write = ((s: string) => {
			out.push(String(s));
			return true;
		}) as typeof process.stdout.write;
		process.stderr.write = ((s: string) => {
			err.push(String(s));
			return true;
		}) as typeof process.stderr.write;
		let lsCode: number;
		let respawnCode: number;
		try {
			lsCode = await runRoostCommand(["ls"], { agentDir, ptyInstalled: () => false });
			respawnCode = await runRoostCommand(["respawn", "--all"], { agentDir, ptyInstalled: () => false });
		} finally {
			process.stdout.write = write;
			process.stderr.write = writeErr;
		}
		expect(lsCode).toBe(0);
		expect(respawnCode).toBe(1);
		expect(err.join("")).toContain("xpi roost: respawn starts a session process, which needs node-pty.");
		expect(err.join("")).toContain("python3, make and a C++ compiler");
		const client = await DaemonClient.connect();
		const status = await client.request("status", {});
		made.push(status.socketDir);
		await client.request("shutdown", {});
		client.close();
	}, 30_000);
});
