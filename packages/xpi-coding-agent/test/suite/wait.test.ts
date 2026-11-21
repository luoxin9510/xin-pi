// builtin:wait (.scratch/xpi-durable/02-waits.md, milestone 1): a wait written when its run ends, woken by time, a
// check, a deadline, a user message or /continue, and found again when the session is reopened. Faux model, fake clock.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type FauxResponseStep, fauxAssistantMessage, fauxToolCall } from "xpi-ai";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { pendingWait, WAIT_CUSTOM_TYPE, WAKE_CUSTOM_TYPE, WOKE_CUSTOM_TYPE } from "../../src/core/waits.ts";
import { createCodemodeExtension } from "../../src/extensions/codemode/index.ts";
import { createWaitExtension, type WaitClock } from "../../src/extensions/wait/index.ts";
import { createHarness, createTestUiContext, type Harness } from "./harness.ts";

const START = new Date(2026, 10, 21, 12, 0, 0).getTime();
const MIN = 60_000;

function fakeClock(start = START) {
	let now = start;
	let next = 0;
	const timers = new Map<number, { at: number; fn: () => void }>();
	const clock: WaitClock & { advance(ms: number): Promise<void>; set(time: number): void } = {
		now: () => now,
		setTimeout: (fn, ms) => {
			const id = ++next;
			timers.set(id, { at: now + ms, fn });
			return id;
		},
		clearTimeout: (handle) => {
			timers.delete(handle as number);
		},
		set: (time) => {
			now = time;
		},
		async advance(ms) {
			const end = now + ms;
			for (;;) {
				const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
				if (!due) break;
				timers.delete(due[0]);
				now = Math.max(now, due[1].at);
				due[1].fn();
				await settle();
			}
			now = end;
			await settle();
		},
	};
	return clock;
}

/** Until `fn` holds (a check runs a real shell, which a loaded machine makes slow). */
async function until(fn: () => boolean, ms = 10_000) {
	const start = Date.now();
	while (!fn()) {
		if (Date.now() - start > ms) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/** Let timers' follow-ups (setImmediate, a started run) finish. */
async function settle() {
	for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

const harnesses: Harness[] = [];
afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

async function setup(
	options: {
		clock?: ReturnType<typeof fakeClock>;
		sessionManager?: SessionManager;
		extra?: (pi: ExtensionAPI) => void;
	} = {},
) {
	const clock = options.clock ?? fakeClock();
	const harness = await createHarness({
		initialActiveToolNames: ["read", "bash", "codemode"],
		extensionFactories: [
			createCodemodeExtension(),
			createWaitExtension(clock),
			...(options.extra ? [options.extra] : []),
		],
		...(options.sessionManager ? { sessionManager: options.sessionManager } : {}),
	});
	harnesses.push(harness);
	const notes: string[] = [];
	await harness.session.bindExtensions({
		mode: "tui",
		uiContext: createTestUiContext({ notify: (message) => notes.push(message) }),
	});
	const seen: string[] = [];
	const reply =
		(message: ReturnType<typeof fauxAssistantMessage>): FauxResponseStep =>
		(context) => {
			seen.push(
				context.messages
					.map((m) =>
						typeof m.content === "string"
							? m.content
							: m.content.map((b) => ("text" in b ? (b as { text: string }).text : "")).join(""),
					)
					.join("\n"),
			);
			return message;
		};
	const code = (script: string) =>
		reply(fauxAssistantMessage(fauxToolCall("codemode", { code: script }), { stopReason: "toolUse" }));
	const wait = (args: Record<string, string>) => code(`await tools.wait(${JSON.stringify(args)}); return "after";`);
	const say = (text: string) => reply(fauxAssistantMessage(text));
	const custom = (customType: string) =>
		harness.sessionManager
			.getBranch()
			.flatMap((entry) => (entry.type === "custom" && entry.customType === customType ? [entry.data as any] : []));
	const woke = () =>
		harness.sessionManager
			.getBranch()
			.flatMap((entry) =>
				entry.type === "custom_message" && entry.customType === WOKE_CUSTOM_TYPE ? [String(entry.content)] : [],
			);
	const idle = async () => {
		await settle();
		await harness.session.waitForIdle();
		await settle();
	};
	return { harness, clock, notes, seen, code, wait, say, custom, woke, idle };
}

describe("tools.wait", () => {
	it("is written when its run ends, and the run makes no further request", async () => {
		const t = await setup();
		t.harness.setResponses([t.wait({ after: "20m", reason: "wait for CI" }), t.say("never asked")]);
		await t.harness.session.prompt("ship it");
		await t.idle();
		expect(t.harness.faux.state.callCount).toBe(1);
		const [data] = t.custom(WAIT_CUSTOM_TYPE);
		expect(data).toMatchObject({ reason: "wait for CI", wakeAt: START + 20 * MIN, at: START });
		expect(pendingWait(t.harness.sessionManager.getBranch())?.id).toBe(data.id);
	});

	it("wakes when its time comes: a run starts with the note", async () => {
		const t = await setup();
		t.harness.setResponses([t.wait({ after: "20m", reason: "wait for CI" }), t.say("Woke up.")]);
		await t.harness.session.prompt("ship it");
		await t.idle();
		await t.clock.advance(19 * MIN);
		expect(t.harness.faux.state.callCount).toBe(1);
		await t.clock.advance(MIN);
		await t.idle();
		expect(t.custom(WAKE_CUSTOM_TYPE)).toMatchObject([{ why: "due" }]);
		expect(t.woke()[0]).toContain("[xpi] The wait you asked for ended: its time came. Reason: wait for CI.");
		expect(t.harness.faux.state.callCount).toBe(2);
		expect(t.seen[1]).toContain("its time came");
		expect(pendingWait(t.harness.sessionManager.getBranch())).toBeUndefined();
	});

	it("runs the check every interval; wakes when it passes, with its output", async () => {
		const t = await setup();
		const flag = join(t.harness.tempDir, "ready");
		t.harness.setResponses([
			t.wait({ after: "1h", every: "2m", check: `test -f ${flag} && echo green`, reason: "wait for CI" }),
			t.say("CI is green."),
		]);
		await t.harness.session.prompt("ship it");
		await t.idle();
		await t.clock.advance(2 * MIN);
		await t.idle();
		expect(t.custom(WAKE_CUSTOM_TYPE)).toEqual([]);
		writeFileSync(flag, "");
		await t.clock.advance(2 * MIN);
		await until(() => t.custom(WAKE_CUSTOM_TYPE).length > 0);
		await t.idle();
		expect(t.custom(WAKE_CUSTOM_TYPE)).toMatchObject([{ why: "check", output: "green" }]);
		expect(t.woke()[0]).toContain("the check passed");
		expect(t.woke()[0]).toContain("Last check output:\ngreen");
		expect(t.harness.faux.state.callCount).toBe(2);
	});

	it("wakes at the deadline when the check never passed, with its last output", async () => {
		const t = await setup();
		const marks = join(t.harness.tempDir, "checks.log");
		const checksRun = () => (existsSync(marks) ? readFileSync(marks, "utf8").split("\n").length - 1 : 0);
		t.harness.setResponses([
			t.wait({ after: "5m", every: "2m", check: `echo pending; echo x >> ${marks}; exit 1`, reason: "wait for CI" }),
			t.say("Still pending."),
		]);
		await t.harness.session.prompt("ship it");
		await t.idle();
		for (let i = 0; i < 4 && t.custom(WAKE_CUSTOM_TYPE).length === 0; i++) {
			const checks = checksRun();
			await t.clock.advance(2 * MIN);
			// Each check runs a real shell: let it end before the clock moves on.
			await until(() => checksRun() > checks || t.custom(WAKE_CUSTOM_TYPE).length > 0);
			await t.idle();
		}
		await until(() => t.custom(WAKE_CUSTOM_TYPE).length > 0);
		expect(t.custom(WAKE_CUSTOM_TYPE)).toMatchObject([{ why: "deadline", output: "pending" }]);
		expect(t.woke()[0]).toContain("the deadline came and the check never passed");
	});

	it("a check a protection blocks ends the wait as blocked", async () => {
		const t = await setup({
			extra: (pi) => {
				pi.on("tool_call", (event) =>
					event.toolName === "bash" && String((event.input as { command?: string }).command).includes("forbidden")
						? { block: true, reason: "forbidden here" }
						: undefined,
				);
			},
		});
		t.harness.setResponses([
			t.wait({ after: "1h", check: "forbidden-command", reason: "wait" }),
			t.say("Blocked, then."),
		]);
		await t.harness.session.prompt("go");
		await t.idle();
		await t.clock.advance(2 * MIN);
		await until(() => t.custom(WAKE_CUSTOM_TYPE).length > 0);
		await t.idle();
		expect(t.custom(WAKE_CUSTOM_TYPE)).toMatchObject([{ why: "blocked" }]);
		expect(t.woke()[0]).toContain("the check was blocked (forbidden-command): forbidden here");
	});

	it("a user message ends the wait; the wake and the note come before the message", async () => {
		const t = await setup();
		t.harness.setResponses([t.wait({ after: "20m", reason: "wait for CI" }), t.say("Answered.")]);
		await t.harness.session.prompt("ship it");
		await t.idle();
		await t.harness.session.prompt("what is the status?");
		await t.idle();
		const branch = t.harness.sessionManager.getBranch();
		const wake = branch.findIndex((e) => e.type === "custom" && e.customType === WAKE_CUSTOM_TYPE);
		const note = branch.findIndex((e) => e.type === "custom_message" && e.customType === WOKE_CUSTOM_TYPE);
		const user = branch.findLastIndex((e) => e.type === "message" && e.message.role === "user");
		expect(wake).toBeGreaterThan(0);
		expect(note).toBeGreaterThan(wake);
		expect(user).toBeGreaterThan(note);
		expect(t.custom(WAKE_CUSTOM_TYPE)).toMatchObject([{ why: "user" }]);
		expect(t.woke()[0]).toContain("a user message came in");
		// The timer is gone: nothing more runs when the time comes.
		await t.clock.advance(30 * MIN);
		await t.idle();
		expect(t.harness.faux.state.callCount).toBe(2);
	});

	it("/continue wakes it now, without the check", async () => {
		const t = await setup();
		t.harness.setResponses([t.wait({ after: "1h", check: "exit 1", reason: "wait for CI" }), t.say("Going on.")]);
		await t.harness.session.prompt("ship it");
		await t.idle();
		expect(await t.harness.session.continueRun()).toEqual({ ran: true });
		expect(t.custom(WAKE_CUSTOM_TYPE)).toMatchObject([{ why: "continue" }]);
		expect(t.woke()[0]).toContain("the user woke it early with /continue");
		expect(t.harness.faux.state.callCount).toBe(2);
		// Without a wait, /continue has nothing to continue, as before.
		expect(await t.harness.session.continueRun()).toEqual({ ran: false, reason: "finished" });
	});

	it("/wait shows it; /wait cancel ends it and starts nothing", async () => {
		const t = await setup();
		t.harness.setResponses([t.wait({ at: "14:20", reason: "wait for the deploy" })]);
		await t.harness.session.prompt("deploy");
		await t.idle();
		await t.harness.session.prompt("/wait");
		expect(t.notes.at(-1)).toBe("Waiting until 14:20: wait for the deploy");
		await t.harness.session.prompt("/wait cancel");
		expect(t.custom(WAKE_CUSTOM_TYPE)).toMatchObject([{ why: "cancel" }]);
		expect(t.notes.at(-1)).toBe("The wait was cancelled.");
		await t.clock.advance(3 * 60 * MIN);
		await t.idle();
		expect(t.harness.faux.state.callCount).toBe(1);
		await t.harness.session.prompt("/wait");
		expect(t.notes.at(-1)).toBe("No wait is pending.");
	});

	it("refuses a direct call and arguments over the limits", async () => {
		const t = await setup();
		t.harness.setResponses([t.say("unused")]);
		const tries = [
			`tools.wait({ after: "8d", reason: "x" })`,
			`tools.wait({ reason: "x" })`,
			`tools.wait({ after: "1h", check: "true", every: "10s", reason: "x" })`,
			`tools.wait({ after: "1h", reason: "" })`,
		];
		t.harness.setResponses([
			...tries.map((call) =>
				t.code(`try { await ${call}; return "allowed"; } catch (error) { return "refused: " + error.message; }`),
			),
			t.say("done"),
		]);
		await t.harness.session.prompt("try");
		await t.idle();
		const results = t.harness.sessionManager
			.getBranch()
			.flatMap((e) =>
				e.type === "message" && e.message.role === "toolResult" ? [JSON.stringify(e.message.content)] : [],
			);
		expect(results.join("\n")).toContain("A wait is at most 7 days.");
		expect(results.join("\n")).toContain("exactly one of after");
		expect(results.join("\n")).toContain("every is at least 30s.");
		expect(results.join("\n")).toContain("wait needs a reason");
		expect(t.custom(WAIT_CUSTOM_TYPE)).toEqual([]);
	});

	it("a wait with another tool in the same batch is written when the run ends, after the run went on", async () => {
		const t = await setup();
		t.harness.setResponses([
			() =>
				fauxAssistantMessage(
					[
						fauxToolCall("codemode", { code: `await tools.wait({ after: "20m", reason: "later" });` }),
						fauxToolCall("read", { path: "missing.txt" }),
					],
					{ stopReason: "toolUse" },
				),
			t.say("Both done."),
		]);
		await t.harness.session.prompt("go");
		await t.idle();
		expect(t.harness.faux.state.callCount).toBe(2);
		expect(t.custom(WAIT_CUSTOM_TYPE)).toMatchObject([{ reason: "later" }]);
	});

	it("a run stopped at its end leaves no pending wait (the one written is cancelled)", async () => {
		const t = await setup({
			extra: (pi) => {
				pi.on("agent_before_settle", (_event, ctx) => {
					ctx.abort();
					return undefined;
				});
			},
		});
		t.harness.setResponses([t.wait({ after: "20m", reason: "later" })]);
		await t.harness.session.prompt("go");
		await t.idle();
		expect(pendingWait(t.harness.sessionManager.getBranch())).toBeUndefined();
		expect(t.custom(WAKE_CUSTOM_TYPE)).toMatchObject([{ why: "cancel" }]);
		expect(t.notes.join("\n")).toContain("The wait was cancelled: the run was stopped.");
	});

	it("reopened after it was due: it wakes at once, saying when it was planned", async () => {
		const first = await setup();
		first.harness.setResponses([first.wait({ after: "20m", reason: "wait for CI" })]);
		await first.harness.session.prompt("ship it");
		await first.idle();
		const header = first.harness.sessionManager.getHeader();
		if (!header) throw new Error("no header");
		const disk = SessionManager.inMemory(undefined, undefined, [
			header,
			...first.harness.sessionManager.getEntries(),
		]);
		const clock = fakeClock(START + 5 * 60 * MIN);
		const second = await setup({ clock, sessionManager: disk });
		second.harness.setResponses([second.say("Back.")]);
		await second.idle();
		expect(second.custom(WAKE_CUSTOM_TYPE)).toMatchObject([{ why: "due" }]);
		expect(second.woke()[0]).toContain("planned 12:20, woke 17:00");
		expect(second.harness.faux.state.callCount).toBe(1);
	});

	it("reopened before it was due: it says so and waits", async () => {
		const first = await setup();
		first.harness.setResponses([first.wait({ after: "20m", reason: "wait for CI" })]);
		await first.harness.session.prompt("ship it");
		await first.idle();
		const header = first.harness.sessionManager.getHeader();
		if (!header) throw new Error("no header");
		const disk = SessionManager.inMemory(undefined, undefined, [
			header,
			...first.harness.sessionManager.getEntries(),
		]);
		const clock = fakeClock(START + 5 * MIN);
		const second = await setup({ clock, sessionManager: disk });
		second.harness.setResponses([second.say("Back.")]);
		await second.idle();
		expect(second.notes.join("\n")).toContain(
			"Waiting until 12:20: wait for CI (/wait cancel to stop, /continue to wake now).",
		);
		expect(second.custom(WAKE_CUSTOM_TYPE)).toEqual([]);
		await clock.advance(15 * MIN);
		await second.idle();
		expect(second.custom(WAKE_CUSTOM_TYPE)).toMatchObject([{ why: "due" }]);
	});

	it("a run something else starts keeps the wait; a wake due during it comes after it, never into it", async () => {
		const clock = fakeClock();
		let during = "";
		const t = await setup({
			clock,
			extra: (pi) => {
				pi.registerCommand("poke", {
					description: "start a run as an extension would",
					handler: async () => {
						pi.sendMessage(
							{ customType: "poke", content: "a background result", display: true },
							{ triggerTurn: true },
						);
					},
				});
			},
		});
		t.harness.setResponses([
			t.wait({ after: "20m", reason: "wait for CI" }),
			(context) => {
				during = JSON.stringify(context.messages);
				// The wait's time comes while this run is on.
				void clock.advance(25 * MIN);
				return fauxAssistantMessage("Noted the background result.");
			},
			t.say("Woke up."),
		]);
		await t.harness.session.prompt("ship it");
		await t.idle();
		await t.harness.session.prompt("/poke");
		await t.idle();
		await t.idle();
		expect(t.custom(WAKE_CUSTOM_TYPE)).toMatchObject([{ why: "due" }]);
		expect(t.harness.faux.state.callCount).toBe(3);
		// The note is in the third request, not in the run that was on when the time came.
		expect(during).toContain("a background result");
		expect(during).not.toContain("its time came");
		expect(t.seen.at(-1)).toContain("its time came");
	});

	it("a user message during a check stops the check; its result is ignored", async () => {
		const t = await setup();
		t.harness.setResponses([
			t.wait({ after: "1h", every: "2m", check: "sleep 20; echo late", reason: "wait for CI" }),
			t.say("Answered."),
		]);
		await t.harness.session.prompt("ship it");
		await t.idle();
		void t.clock.advance(2 * MIN);
		await settle();
		await t.harness.session.prompt("status?");
		await t.idle();
		await new Promise((resolve) => setTimeout(resolve, 200));
		await t.idle();
		expect(t.custom(WAKE_CUSTOM_TYPE)).toMatchObject([{ why: "user" }]);
		expect(t.harness.faux.state.callCount).toBe(2);
	});

	it("a user's steer after the call drops the wait the run has not written yet", async () => {
		let steered = false;
		const t = await setup({
			extra: (pi) => {
				pi.on("tool_result", (event) => {
					if (event.toolName !== "codemode" || steered) return undefined;
					steered = true;
					void t.harness.session.prompt("actually, do not wait", { streamingBehavior: "steer" });
					return undefined;
				});
			},
		});
		t.harness.setResponses([t.wait({ after: "20m", reason: "later" }), t.say("Not waiting.")]);
		await t.harness.session.prompt("go");
		await t.idle();
		expect(t.harness.faux.state.callCount).toBe(2);
		expect(t.custom(WAIT_CUSTOM_TYPE)).toEqual([]);
	});

	it("a fork does not take a pending wait with it", async () => {
		const t = await setup();
		t.harness.setResponses([t.wait({ after: "20m", reason: "later" })]);
		await t.harness.session.prompt("go");
		await t.idle();
		const leaf = t.harness.sessionManager.getLeafId();
		if (!leaf) throw new Error("no leaf");
		const forked = SessionManager.inMemory(undefined, undefined, [
			t.harness.sessionManager.getHeader()!,
			...t.harness.sessionManager.getEntries(),
		]);
		forked.createBranchedSession(leaf);
		expect(pendingWait(forked.getBranch(), forked.getEntries())).toBeUndefined();
	});
});

describe("ctx.runTool (spec 02, D3)", () => {
	it("runs a tool through the session's hooks, outside any model call, and writes nothing", async () => {
		const seenCalls: string[] = [];
		let run: ((name: string, args: unknown) => Promise<any>) | undefined;
		const harness = await createHarness({
			initialActiveToolNames: ["read", "bash", "codemode"],
			extensionFactories: [
				createCodemodeExtension(),
				(pi) => {
					pi.on("tool_call", (event) => {
						seenCalls.push(event.toolCallId);
						return String((event.input as { command?: string }).command).includes("nope")
							? { block: true, reason: "not here" }
							: undefined;
					});
					pi.on("session_start", (_event, ctx) => {
						run = (name, args) => ctx.runTool(name, args);
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const before = harness.sessionManager.getEntries().length;
		const ok = await run!("bash", { command: "echo hi" });
		expect(ok.isError).toBe(false);
		expect(ok.result.structuredContent).toMatchObject({ exit_code: 0, output: "hi\n" });
		const blocked = await run!("bash", { command: "echo nope" });
		expect(blocked).toMatchObject({ isError: true, blocked: true });
		const failed = await run!("bash", { command: "exit 3" });
		expect(failed.isError).toBe(true);
		expect(failed.blocked).toBeUndefined();
		expect(seenCalls).toEqual(["ext:1", "ext:2", "ext:3"]);
		expect(harness.sessionManager.getEntries().length).toBe(before);
	});
});
