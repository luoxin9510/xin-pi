// Spec 03: `/reload` in a process that runs an older build than the installed one says that xpi's own code is not
// loaded by it: a restart notice in a roost session, a quit-and-resume one in a foreground session.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const builds = vi.hoisted(() => ({ running: undefined as string | undefined, disk: undefined as string | undefined }));
vi.mock("xpi-roost/session", async (importOriginal) => ({
	...(await importOriginal<typeof import("xpi-roost/session")>()),
	get ROOST_BUILD() {
		return builds.running;
	},
	buildOnDisk: () => builds.disk,
}));
// the worker role is not what is tested here
vi.mock("../src/extensions/roost/worker.ts", () => ({ registerWorker: () => {} }));
vi.mock("../src/utils/resume-command.ts", () => ({ formatResumeCommand: () => "xpi --session abc" }));

import roost from "../src/extensions/roost/index.ts";
import { reloadNotice } from "../src/extensions/roost/stale.ts";

const ENV = ["ROOST_JOB_ID", "ROOST_JOB_TOKEN", "ROOST_SOCKET", "ROOST_JOB_DIR", "XPI_SUBAGENT_DEPTH"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
	for (const k of ENV) {
		saved[k] = process.env[k];
		delete process.env[k];
	}
	builds.running = "aaaaaaaaaaaaaaaa";
	builds.disk = "bbbbbbbbbbbbbbbb";
});
afterEach(() => {
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

describe("reloadNotice", () => {
	it("is silent unless both builds are known and differ", () => {
		expect(reloadNotice({ running: "a", onDisk: "a" })).toBeUndefined();
		expect(reloadNotice({ running: undefined, onDisk: "a" })).toBeUndefined();
		expect(reloadNotice({ running: "a", onDisk: undefined })).toBeUndefined();
	});

	it("names the session's id in a roost session and the resume command in a foreground one", () => {
		const roostSession = reloadNotice({ running: "a", onDisk: "b", roostId: "j1" });
		expect(roostSession).toContain("/reload does not load it");
		expect(roostSession).toContain("xpi roost respawn j1");
		const foreground = reloadNotice({ running: "a", onDisk: "b", resume: "xpi --session abc" });
		expect(foreground).toContain("/reload does not load it");
		expect(foreground).toContain("Quit and start it again: xpi --session abc");
		expect(reloadNotice({ running: "a", onDisk: "b" })).toContain("Quit and start xpi again");
	});
});

async function sessionStart(event: { reason: string }, hasUI = true) {
	const handlers: ((event: any, ctx: any) => unknown)[] = [];
	const pi = {
		registerFlag: () => {},
		registerCommand: () => {},
		on: (name: string, h: (event: any, ctx: any) => unknown) => {
			if (name === "session_start") handlers.push(h);
			return () => {};
		},
		getFlag: () => undefined,
		events: { on: () => () => {}, emit: () => {} },
		getCommands: () => [],
	};
	await roost(pi as never);
	const notes: { message: string; type: string }[] = [];
	const ctx = {
		hasUI,
		sessionManager: { getSessionFile: () => undefined },
		// the foreground role has its own session_start handler, which draws widgets: any other call does nothing
		ui: new Proxy(
			{ notify: (message: string, type: string) => notes.push({ message, type }) },
			{ get: (t, k) => (k in t ? (t as never)[k] : () => {}) },
		),
	};
	for (const h of handlers) await h(event, ctx);
	return notes;
}

describe("builtin:roost on /reload", () => {
	it("a foreground session is told to quit and given the resume command", async () => {
		const notes = await sessionStart({ reason: "reload" });
		expect(notes).toHaveLength(1);
		expect(notes[0]!.message).toContain("Quit and start it again: xpi --session abc");
	});

	it("a session the daemon runs is told to restart it", async () => {
		Object.assign(process.env, {
			ROOST_JOB_ID: "j1",
			ROOST_JOB_TOKEN: "t",
			ROOST_SOCKET: "/tmp/none.sock",
			ROOST_JOB_DIR: "/tmp/none",
		});
		const notes = await sessionStart({ reason: "reload" });
		expect(notes.map((n) => n.message).join("\n")).toContain("xpi roost respawn j1");
	});

	it("a bare ROOST_JOB_ID (an xpi started from the agent's shell) is a foreground session", async () => {
		process.env.ROOST_JOB_ID = "j1";
		const notes = await sessionStart({ reason: "reload" });
		expect(notes[0]!.message).toContain("Quit and start it again");
	});

	it("says nothing at startup, with equal builds, or without a terminal", async () => {
		expect(await sessionStart({ reason: "startup" })).toEqual([]);
		expect(await sessionStart({ reason: "reload" }, false)).toEqual([]);
		builds.disk = builds.running;
		expect(await sessionStart({ reason: "reload" })).toEqual([]);
	});
});
