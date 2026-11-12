// Spec 09 PR 2 ("waiting without model turns") on a real session: faux model, real codemode sandbox, the subagent
// extension, fake subagent children (test/subagent/fake-pi.mjs). While a script's group runs, a user message that
// starts a turn gets one line naming the agents still running; stalls are marked, told to the user and listed in the
// group message; the `subagents` status follows running agents and groups.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "xpi-ai";
import { emitSessionShutdownEvent } from "../../src/core/extensions/runner.ts";
import { createCodemodeExtension } from "../../src/extensions/codemode/index.ts";
import { codemodeScripts } from "../../src/extensions/codemode/scripts.ts";
import { scripts } from "../../src/extensions/subagent/background.ts";
import subagent from "../../src/extensions/subagent/index.ts";
import { registry } from "../../src/extensions/subagent/registry.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { ev, FAKE_PI, type Scenario } from "../subagent/helpers.ts";
import { createHarness, createTestUiContext, type Harness } from "./harness.ts";

initTheme("dark");

const text = (content: unknown) =>
	typeof content === "string"
		? content
		: ((content as { type: string; text?: string }[] | undefined) ?? []).map((c) => c.text ?? "").join("");

// A child that answers `<word> done` after `steps` tool starts, one line per scenario delay.
const lines = (word: string, steps: number) => [
	ev.session(),
	...Array.from({ length: steps }, () => ev.tool("bash")),
	ev.assistant(`${word} done`),
	ev.turnEnd(),
	ev.settled(),
];
const scenario = (delayMs: number): Scenario => ({
	lines: lines("other", 0),
	byPrompt: { alpha: lines("alpha", 10), beta: lines("beta", 10), gamma: lines("gamma", 0), delta: lines("delta", 0) },
	delayMs,
});

const agentCall = (word: string, extra = "") =>
	`tools.Agent({ description: "${word}", prompt: "${word} task"${extra ? `, ${extra}` : ""} });`;

describe("spec 09: waiting without model turns", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		vi.useRealTimers();
		for (const h of harnesses) {
			const id = h.sessionManager.getSessionId();
			await emitSessionShutdownEvent(h.session.extensionRunner, { type: "session_shutdown", reason: "quit" });
			await codemodeScripts.stopAll(id);
		}
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		vi.unstubAllEnvs();
	});

	async function setup(options: { settings?: Record<string, unknown>; delayMs?: number } = {}) {
		const root = mkdtempSync(join(tmpdir(), "waiting-"));
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		vi.stubEnv("HOME", join(root, "home"));
		vi.stubEnv("XPI_CODING_AGENT_DIR", agentDir);
		vi.stubEnv("FAKE_PI_SCENARIO", join(root, "scenario.json"));
		vi.stubEnv("FAKE_PI_RECORD", join(root, "record.json"));
		writeFileSync(join(root, "scenario.json"), JSON.stringify(scenario(options.delayMs ?? 150)));
		const statuses: (string | undefined)[] = [];
		const notices: string[] = [];
		const harness = await createHarness({
			settings: {
				subagent: { piCommand: FAKE_PI, staggerStart: false, panelLingerMs: 60_000, ...options.settings },
			} as never,
			initialActiveToolNames: ["codemode"],
			extensionFactories: [createCodemodeExtension(), subagent],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({
				setStatus: (key, value) => {
					if (key === "subagents") statuses.push(value);
				},
				notify: (message) => notices.push(message),
			}),
		});
		const sessionId = () => harness.sessionManager.getSessionId();
		const custom = (type: string) =>
			harness.session.messages
				.filter((m) => m.role === "custom" && (m as { customType?: string }).customType === type)
				.map((m) => text((m as { content: unknown }).content));
		const groupMessages = () =>
			custom("subagent").filter((m) => /^Agents left running by script|^Background script/.test(m));
		const script = () => scripts.list(sessionId()).at(-1)!;
		// Main starts the script, which leaves its agents running, and answers "started".
		const run = async (code: string, after: Parameters<Harness["setResponses"]>[0] = []) => {
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("codemode", { code })], { stopReason: "toolUse" }),
				...after,
				fauxAssistantMessage("started"),
			]);
			await harness.session.prompt("go");
			// The calls reach Agent's execute one at a time: the script's code ends once both are on their way.
			await vi.waitFor(() => expect(scripts.list(sessionId()).at(-1)?.state).not.toBe("background"));
		};
		return { harness, sessionId, custom, groupMessages, script, run, statuses, notices };
	}

	describe("a user message during a group", () => {
		it("gets one line after it naming the agents still running; a steer does not, and none once the group ended", async () => {
			const t = await setup();
			// While main answers after the script, the user steers: the steer starts no run, so it gets no line.
			let steered = false;
			await t.run(`${agentCall("alpha")} ${agentCall("beta")} return 1;`, [
				async () => {
					if (!steered) {
						steered = true;
						await t.harness.session.steer("a steer while main runs");
					}
					return fauxAssistantMessage("noted the steer");
				},
			]);
			expect(steered).toBe(true);
			expect(t.script().state).toBe("ended");
			await vi.waitFor(() => expect(t.harness.session.isStreaming).toBe(false));
			expect(t.custom("subagent-status")).toEqual([]);

			t.harness.appendResponses([fauxAssistantMessage("they are still on it")]);
			await t.harness.session.prompt("how is it going?");
			const status = t.custom("subagent-status");
			expect(status).toHaveLength(1);
			expect(status[0]).toMatch(/^\[agents still running: \S+ \S+ "alpha" \d+s; \S+ \S+ "beta" \d+s\]$/);
			// Placed after the user's message, and not shown in the transcript.
			const messages = t.harness.session.messages;
			const at = messages.findIndex(
				(m) => m.role === "custom" && (m as { customType?: string }).customType === "subagent-status",
			);
			expect(text((messages[at - 1] as { content: unknown }).content)).toBe("how is it going?");
			expect((messages[at] as { display?: boolean }).display).toBe(false);

			t.harness.appendResponses([fauxAssistantMessage("group noted")]);
			await vi.waitFor(() => expect(t.groupMessages()).toHaveLength(1), { timeout: 15_000 });
			await vi.waitFor(() => expect(t.harness.session.isStreaming).toBe(false));
			t.harness.appendResponses([fauxAssistantMessage("nothing runs")]);
			await t.harness.session.prompt("and now?");
			expect(t.custom("subagent-status")).toHaveLength(1);
		});

		it('a run started by a custom message (a wake: "each" agent reporting) gets no line; the line names only running members', async () => {
			const t = await setup();
			// gamma reports on its own (wake: "each"); beta too, later; delta is a member that ends early; alpha keeps the
			// group running.
			await t.run(
				`${agentCall("gamma", 'wake: "each"')} ${agentCall("beta", 'wake: "each"')} ${agentCall("delta")} ${agentCall("alpha")} return 1;`,
				[fauxAssistantMessage("gamma noted")],
			);
			await vi.waitFor(
				() =>
					expect(
						t
							.custom("subagent")
							.some((m) => m.includes("gamma done") && !/^Agents left|^Background script/.test(m)),
					).toBe(true),
				{ timeout: 15_000 },
			);
			await vi.waitFor(() =>
				expect(t.script().members.find((m) => m.description === "delta")?.status).toBe("completed"),
			);
			await vi.waitFor(() => expect(t.harness.session.isStreaming).toBe(false));
			expect(t.script().state).toBe("ended");
			expect(t.custom("subagent-status")).toEqual([]);

			t.harness.appendResponses([
				fauxAssistantMessage("alpha is still on it"),
				fauxAssistantMessage("noted"),
				fauxAssistantMessage("noted"),
			]);
			await t.harness.session.prompt("status?");
			// Only the members still running: not delta (ended), not beta (running, but not a member).
			const status = t.custom("subagent-status");
			expect(status).toHaveLength(1);
			expect(status[0]).toMatch(/^\[agents still running: \S+ \S+ "alpha" \d+s\]$/);
			await vi.waitFor(() => expect(t.groupMessages()).toHaveLength(1), { timeout: 15_000 });
			await vi.waitFor(() => expect(t.custom("subagent").some((m) => m.includes("beta done"))).toBe(true), {
				timeout: 15_000,
			});
		});

		it("a background script whose code still runs is not a group: no line", async () => {
			const t = await setup();
			t.harness.setResponses([
				fauxAssistantMessage([fauxToolCall("codemode", { code: `await ${agentCall("alpha")} return 1;` })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("started"),
			]);
			await t.harness.session.prompt("go");
			expect(t.script().state).toBe("background");
			t.harness.appendResponses([fauxAssistantMessage("still on it"), fauxAssistantMessage("noted")]);
			await t.harness.session.prompt("status?");
			expect(t.custom("subagent-status")).toEqual([]);
			await vi.waitFor(() => expect(t.groupMessages()).toHaveLength(1), { timeout: 15_000 });
		});
	});

	describe("the subagents status", () => {
		it("counts running agents and groups while they run, and is cleared when nothing runs", async () => {
			const t = await setup();
			await t.run(`${agentCall("alpha")} ${agentCall("beta")} return 1;`, [fauxAssistantMessage("group noted")]);
			expect(t.statuses).toContain("2 agents running · 1 group");
			await vi.waitFor(() => expect(t.groupMessages()).toHaveLength(1), { timeout: 15_000 });
			await vi.waitFor(() => expect(t.statuses.at(-1)).toBeUndefined());
			// Published only when it changes.
			expect(t.statuses.filter((s, i) => i > 0 && s === t.statuses[i - 1])).toEqual([]);
		});

		it("the session's end clears it", async () => {
			const t = await setup();
			await t.run(`${agentCall("alpha")} return 1;`);
			expect(t.statuses.at(-1)).toMatch(/1 group/);
			await emitSessionShutdownEvent(t.harness.session.extensionRunner, {
				type: "session_shutdown",
				reason: "quit",
			});
			expect(t.statuses.at(-1)).toBeUndefined();
		});
	});

	describe("stalls", () => {
		it("the 30 s check marks a quiet agent, tells the user (not main), and the group message lists the stall", async () => {
			vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
			const t = await setup({ settings: { stallMs: 1 }, delayMs: 300 });
			await t.run(`${agentCall("alpha")} return 1;`, [fauxAssistantMessage("group noted")]);
			const agentId = () => t.script().members[0]!.agentId!;
			// Its child process runs and has sent an event; the next one comes 300 ms later.
			await vi.waitFor(() => expect(registry.get(t.script().members[0]?.agentId ?? "")?.lastTool).toBe("bash"));
			await new Promise((r) => setTimeout(r, 20));
			vi.advanceTimersByTime(30_000);
			expect(t.notices.filter((n) => n.includes("has done nothing"))).toHaveLength(1);
			expect(t.notices.find((n) => n.includes("has done nothing"))).toContain(agentId());
			expect(t.statuses.at(-1)).toMatch(/1 stalled/);
			await vi.waitFor(() => expect(registry.stalledFor(agentId())).toBeUndefined(), { timeout: 5_000 });
			await vi.waitFor(() => expect(t.groupMessages()).toHaveLength(1), { timeout: 15_000 });
			expect(t.groupMessages()[0]).toMatch(
				new RegExp(`- ${agentId()} \\S+ "alpha" completed \\$\\S+ \\d+s stalled 0m`),
			);
			expect(t.custom("subagent").some((m) => m.includes("has done nothing"))).toBe(false);
		});

		it("stallMs 0: never marked", async () => {
			vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
			const t = await setup({ settings: { stallMs: 0 }, delayMs: 300 });
			await t.run(`${agentCall("alpha")} return 1;`, [fauxAssistantMessage("group noted")]);
			// Its child process runs and has sent an event; the next one comes 300 ms later.
			await vi.waitFor(() => expect(registry.get(t.script().members[0]?.agentId ?? "")?.lastTool).toBe("bash"));
			await new Promise((r) => setTimeout(r, 20));
			vi.advanceTimersByTime(30_000);
			expect(t.notices.filter((n) => n.includes("has done nothing"))).toEqual([]);
			await vi.waitFor(() => expect(t.groupMessages()).toHaveLength(1), { timeout: 15_000 });
			expect(t.groupMessages()[0]).not.toMatch(/stalled/);
		});
	});
});
