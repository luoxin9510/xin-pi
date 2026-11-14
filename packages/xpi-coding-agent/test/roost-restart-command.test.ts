// Spec 03: builtin:roost registers `/restart` in every session. In a session the daemon runs it asks for the restart
// (`restart.ts`, mocked here: the daemon side is tested in xpi-roost); in any other it says how to do it by hand.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const asked = vi.hoisted(() => ({ calls: [] as boolean[] }));
vi.mock("../src/extensions/roost/restart.ts", () => ({
	restartFromSession: async (all: boolean) => {
		asked.calls.push(all);
	},
}));
vi.mock("../src/extensions/roost/worker.ts", () => ({ registerWorker: () => {} }));
vi.mock("../src/utils/resume-command.ts", () => ({ formatResumeCommand: () => "xpi --session abc" }));

import roost from "../src/extensions/roost/index.ts";

const ENV = ["ROOST_JOB_ID", "ROOST_JOB_TOKEN", "ROOST_SOCKET", "ROOST_JOB_DIR", "XPI_SUBAGENT_DEPTH"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
	for (const k of ENV) {
		saved[k] = process.env[k];
		delete process.env[k];
	}
	asked.calls = [];
});
afterEach(() => {
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

async function runRestart(args: string): Promise<string[]> {
	let handler: ((args: string, ctx: any) => Promise<unknown>) | undefined;
	const pi = {
		registerFlag: () => {},
		registerCommand: (name: string, def: { handler: typeof handler }) => {
			if (name === "restart") handler = def.handler;
		},
		on: () => () => {},
		getFlag: () => undefined,
		events: { on: () => () => {}, emit: () => {} },
		getCommands: () => [],
	};
	await roost(pi as never);
	expect(handler).toBeDefined();
	const notes: string[] = [];
	const ctx = {
		sessionManager: { getSessionFile: () => undefined, isPersisted: () => false, usesDefaultSessionDir: () => true },
		ui: { notify: (m: string) => notes.push(m) },
	};
	await handler!(args, ctx);
	return notes;
}

const inRoostSession = () =>
	Object.assign(process.env, {
		ROOST_JOB_ID: "j1",
		ROOST_JOB_TOKEN: "t",
		ROOST_SOCKET: "/tmp/none.sock",
		ROOST_JOB_DIR: "/tmp/none",
	});

describe("/restart", () => {
	it("in a foreground session prints how to do it by hand", async () => {
		const notes = await runRestart("");
		expect(notes.join("\n")).toContain("quit it and start it again: xpi --session abc");
		expect(asked.calls).toEqual([]);
	});

	it("in a bare-ROOST_JOB_ID process (an xpi started from the agent's shell) is a foreground session too", async () => {
		process.env.ROOST_JOB_ID = "j1";
		await runRestart("");
		expect(asked.calls).toEqual([]);
	});

	it("in a session the daemon runs asks to restart this session; `all` the whole roost", async () => {
		inRoostSession();
		await runRestart("");
		await runRestart("all");
		expect(asked.calls).toEqual([false, true]);
	});

	it("takes nothing else", async () => {
		inRoostSession();
		expect((await runRestart("everything")).join("\n")).toContain("usage: /restart [all]");
		expect(asked.calls).toEqual([]);
	});
});
