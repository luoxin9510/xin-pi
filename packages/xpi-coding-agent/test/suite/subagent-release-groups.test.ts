// Spec 09 PR 1 ("start agents and let the script end") on a real session: faux model, real codemode sandbox, the
// subagent extension, fake subagent children (test/subagent/fake-pi.mjs). Agent calls still running when a script
// ends are released, not cancelled; the agents a script leaves running form its group, and main gets one message when
// the whole group has ended.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "xpi-ai";
import { emitSessionShutdownEvent } from "../../src/core/extensions/runner.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createCodemodeExtension } from "../../src/extensions/codemode/index.ts";
import { codemodeScripts } from "../../src/extensions/codemode/scripts.ts";
import type { CodemodeToolDetails } from "../../src/extensions/codemode/tool.ts";
import { scripts } from "../../src/extensions/subagent/background.ts";
import subagent from "../../src/extensions/subagent/index.ts";
import { Panel } from "../../src/extensions/subagent/panel.ts";
import { registry } from "../../src/extensions/subagent/registry.ts";
import { runs } from "../../src/extensions/subagent/runs.ts";
import { scriptHelpers } from "../../src/extensions/subagent/script-helpers.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";
import { ev, FAKE_PI, type Scenario } from "../subagent/helpers.ts";
import { createHarness, createTestUiContext, getToolResult, type Harness } from "./harness.ts";

initTheme("dark");

// The statuses of a codemode result's nested calls.
const statuses = (result: { details?: unknown }) =>
	((result.details as CodemodeToolDetails | undefined)?.calls ?? []).map((c) => c.status);

const text = (content: unknown) =>
	typeof content === "string"
		? content
		: ((content as { type: string; text?: string }[] | undefined) ?? []).map((c) => c.text ?? "").join("");

// A child that answers `<word> done` for a prompt naming that word, after `delayMs` per line.
const lines = (word: string, cost = 0.01) => [
	ev.session(),
	ev.assistant(`${word} done`, {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: cost / 2, output: cost / 2, cacheRead: 0, cacheWrite: 0, total: cost },
	}),
	ev.turnEnd(),
	ev.settled(),
];
const WORDS = ["alpha", "beta", "gamma", "delta"];
const scenario = (delayMs: number, extra: Partial<Scenario> = {}): Scenario => ({
	lines: lines("other"),
	byPrompt: Object.fromEntries(WORDS.map((w) => [w, lines(w)])),
	delayMs,
	...extra,
});

const agentCall = (word: string, extra = "") =>
	`tools.Agent({ description: "${word}", prompt: "${word} task"${extra ? `, ${extra}` : ""} });`;

describe("spec 09: agents outlive their script", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		for (const h of harnesses) {
			const id = h.sessionManager.getSessionId();
			// The session's end, as quitting does: its scripts and agents stop, and its extension stops following the
			// process-wide script registry.
			await emitSessionShutdownEvent(h.session.extensionRunner, { type: "session_shutdown", reason: "quit" });
			await codemodeScripts.stopAll(id);
		}
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		vi.unstubAllEnvs();
	});

	// `held`: Agent calls with these descriptions wait (on their way through the host, before Agent's execute) until
	// `open(description)`. `blocked`: Agent calls with these descriptions are blocked by a tool_call hook.
	async function setup(
		options: {
			settings?: Record<string, unknown>;
			ui?: boolean;
			scenario?: Scenario;
			saved?: boolean;
			held?: string[];
			blocked?: string[];
			workflow?: string;
		} = {},
	) {
		const root = mkdtempSync(join(tmpdir(), "release-groups-"));
		const agentDir = join(root, "agent");
		mkdirSync(join(agentDir, "workflows"), { recursive: true });
		vi.stubEnv("HOME", join(root, "home"));
		vi.stubEnv("XPI_CODING_AGENT_DIR", agentDir);
		vi.stubEnv("FAKE_PI_SCENARIO", join(root, "scenario.json"));
		vi.stubEnv("FAKE_PI_RECORD", join(root, "record.json"));
		writeFileSync(join(root, "scenario.json"), JSON.stringify(options.scenario ?? scenario(150)));
		if (options.workflow) writeFileSync(join(agentDir, "workflows", "fan.js"), options.workflow);
		const gates = new Map<string, () => void>();
		const waiting = new Set<string>();
		const hooks = (pi: ExtensionAPI) => {
			pi.on("tool_execution_start", async (event) => {
				const description = (event.args as { description?: string } | undefined)?.description;
				if (event.toolName !== "Agent" || !description || !options.held?.includes(description)) return;
				waiting.add(description);
				await new Promise<void>((resolve) => gates.set(description, resolve));
			});
			pi.on("tool_call", (event) => {
				const description = (event.input as { description?: string }).description;
				if (event.toolName === "Agent" && description && options.blocked?.includes(description))
					return { block: true, reason: `blocked ${description}` };
				return undefined;
			});
		};
		const harness = await createHarness({
			settings: {
				subagent: { piCommand: FAKE_PI, staggerStart: false, panelLingerMs: 60_000, ...options.settings },
			} as never,
			initialActiveToolNames: ["codemode"],
			extensionFactories: [createCodemodeExtension(), subagent, hooks],
			...(options.saved ? { sessionManager: SessionManager.create(root, join(root, "sessions")) } : {}),
		});
		harnesses.push(harness);
		await harness.session.bindExtensions(options.ui === false ? {} : { uiContext: createTestUiContext() });
		const sessionId = () => harness.sessionManager.getSessionId();
		const messages = () =>
			harness.session.messages
				.filter((m) => m.role === "custom" && (m as { customType?: string }).customType === "subagent")
				.map((m) => text((m as { content: unknown }).content));
		const groupMessages = () => messages().filter((m) => /^Agents left running by script|^Background script/.test(m));
		const run = async (code: string, extra: Record<string, unknown> = {}) => {
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("codemode", { code, ...extra })], { stopReason: "toolUse" }),
				fauxAssistantMessage("started"),
				fauxAssistantMessage("noted 1"),
				fauxAssistantMessage("noted 2"),
				fauxAssistantMessage("noted 3"),
				fauxAssistantMessage("noted 4"),
			]);
			await harness.session.prompt("go");
			return getToolResult(harness, "codemode");
		};
		const open = async (description: string) => {
			await vi.waitFor(() => expect(gates.has(description)).toBe(true));
			gates.get(description)!();
			gates.delete(description);
		};
		const script = () => scripts.list(sessionId()).at(-1)!;
		const childStarted = () => existsSync(join(root, "record.json"));
		return { root, harness, sessionId, messages, groupMessages, run, open, waiting, script, childStarted };
	}

	describe("start and end", () => {
		it("a script that starts two agents without await and returns at once: both run, the panel shows the group, they count toward maxAgentsPerScript, and main wakes once", async () => {
			// Held on their way through the host until the script has returned.
			const t = await setup({
				settings: { maxAgentsPerScript: 2 },
				scenario: scenario(200),
				held: ["alpha", "beta", "gamma"],
			});
			const result = await t.run(
				`${agentCall("alpha")} ${agentCall("beta")} ${agentCall("gamma")} return "started";`,
			);
			expect(t.script().state).toBe("ended");
			for (const d of ["alpha", "beta", "gamma"]) await t.open(d);
			// The script returned before any call reached Agent's execute: its calls were released, not cancelled.
			expect(statuses(result)).toEqual(["released", "released", "released"]);
			expect(text(result.content)).toContain("Script completed");
			// The group runs: the script row stays open, marked ended, with its agents.
			await vi.waitFor(() => expect(t.script().agents).toHaveLength(2));
			expect(t.script().state).toBe("ended");
			expect(codemodeScripts.owner(`${t.script().callId}/1`)).toMatchObject({ state: "ended", ended: "returned" });
			const panel = new Panel(
				t.sessionId(),
				theme,
				() => {},
				() => {},
				{ lingerMs: 60_000, viewable: true },
			);
			const rows = panel.render(200).join("\n");
			panel.dispose();
			// The rows carry the theme's colors.
			const plain = rows.replace(/\u001b\[[0-9;]*m/g, "");
			expect(plain).toMatch(/● ended · script S\d+ · \d\/3 agents done/);
			expect(rows).toContain("alpha");
			await vi.waitFor(() => expect(t.groupMessages()).toHaveLength(1), { timeout: 10_000 });
			const message = t.groupMessages()[0]!;
			expect(message).toMatch(/^Agents left running by script S\d+ have ended\./);
			expect(message).toMatch(/- \w+ general-purpose "alpha" completed \$0\.0100/);
			expect(message).toMatch(/- \w+ general-purpose "beta" completed \$0\.0100/);
			// The third call is past maxAgentsPerScript: a line with its error.
			expect(message).toMatch(
				/- \(not started\) general-purpose "gamma" failed[^\n]*\n {2}Error: this script already started 2 agents/,
			);
			expect(message).toContain("alpha done");
			expect(message).toContain("beta done");
			expect(message).toMatch(/Total: \$0\.0200, \d+s/);
			// One message for the group, none per agent.
			expect(t.messages()).toHaveLength(1);
			// Their usage is in the session, and the released agents are no longer in the detached table.
			await vi.waitFor(() => expect(t.harness.session.getSessionStats().cost).toBeCloseTo(0.02));
			const detached = (registry as unknown as { detached: Map<string, unknown> }).detached;
			for (const id of t.script().agents) expect(detached.has(id)).toBe(false);
			expect(t.script().state).toBe("completed");
			expect(codemodeScripts.list(t.sessionId())).toHaveLength(0);
		});

		it("the same through agent() and parallel()", async () => {
			const t = await setup({ held: ["alpha", "beta"] });
			const result = await t.run(
				'agent("alpha task", { label: "alpha" }); parallel([() => agent("beta task", { label: "beta" })]); return 1;',
			);
			for (const d of ["alpha", "beta"]) await t.open(d);
			expect(statuses(result)).toEqual(["released", "released"]);
			await vi.waitFor(() => expect(t.groupMessages()).toHaveLength(1), { timeout: 10_000 });
			const message = t.groupMessages()[0]!;
			expect(message).toMatch(/"alpha" completed/);
			expect(message).toMatch(/"beta" completed/);
			expect(message).toContain("alpha done");
			expect(message).toContain("beta done");
			expect(t.messages()).toHaveLength(1);
		});

		it("an un-awaited call that fails validation or is blocked after the script ended is a group line, and the group ends", async () => {
			const t = await setup({ held: ["bad", "blocked", "alpha"], blocked: ["blocked"] });
			await t.run(`tools.Agent({ description: "bad" }); ${agentCall("blocked")} ${agentCall("alpha")} return 1;`);
			expect(t.script().state).toBe("ended");
			for (const d of ["bad", "blocked", "alpha"]) await t.open(d);
			await vi.waitFor(() => expect(t.groupMessages()).toHaveLength(1), { timeout: 10_000 });
			const message = t.groupMessages()[0]!;
			expect(message).toMatch(/- \(not started\) "bad" failed\s+Error: Validation failed/);
			expect(message).toMatch(/- \(not started\) "blocked" failed\s+Error: blocked blocked/);
			expect(message).toMatch(/"alpha" completed/);
		});

		it("x while kept calls are on their way: no child starts, and main hears the stop once", async () => {
			const t = await setup({ held: ["alpha"] });
			await t.run(`${agentCall("alpha")} return 1;`);
			await vi.waitFor(() => expect(t.waiting.has("alpha")).toBe(true));
			expect(await scripts.stop(t.script().id)).toBe(true);
			await t.open("alpha");
			await vi.waitFor(() => expect(t.groupMessages()).toHaveLength(1), { timeout: 10_000 });
			expect(t.groupMessages()[0]).toMatch(/"alpha" failed[^\n]*\n {2}Error: script S\d+ is being stopped/);
			expect(t.childStarted()).toBe(false);
			expect(t.script().state).toBe("stopped");
		});

		it("/new (a session end) while kept calls are on their way: no child starts and nothing reaches main", async () => {
			const t = await setup({ held: ["alpha"] });
			await t.run(`${agentCall("alpha")} return 1;`);
			await vi.waitFor(() => expect(t.waiting.has("alpha")).toBe(true));
			const before = t.messages().length;
			const old = t.script();
			await t.harness.session.reload(); // session_shutdown, then a new session_start: the path /new and resume take
			await t.open("alpha");
			await vi.waitFor(() =>
				expect(codemodeScripts.list()).not.toContainEqual(expect.objectContaining({ id: old.id })),
			);
			await new Promise((r) => setTimeout(r, 200));
			expect(t.childStarted()).toBe(false);
			expect(t.messages()).toHaveLength(before);
			expect(old.state).toBe("stopped");
		});

		it("a paused script that ends: its waiting calls and those that reach the gate later do not start; they are group lines", async () => {
			const t = await setup({ held: ["late"], scenario: scenario(100) });
			const resultPromise = t.run(
				`const a = tools.Agent({ description: "alpha", prompt: "alpha task" }); await a; ${agentCall("beta")} ${agentCall("late")} return 1;`,
			);
			// Pause while alpha runs, so beta waits at the gate when the script ends.
			await vi.waitFor(() => expect(t.script()?.agents.length).toBe(1));
			expect(scripts.togglePause(t.script().id)).toBe(true);
			await resultPromise;
			await vi.waitFor(() => expect(t.script().state).toBe("ended"), { timeout: 10_000 });
			expect(t.script().paused).toBe(false);
			await t.open("late");
			await vi.waitFor(() => expect(t.groupMessages()).toHaveLength(1), { timeout: 10_000 });
			const message = t.groupMessages()[0]!;
			expect(message).toMatch(/- \(not started\) "beta" failed\s+Error: not started: the script was paused/);
			expect(message).toMatch(/- \(not started\) "late" failed\s+Error: not started: the script was paused/);
			// alpha ended before the script did: its line only.
			expect(message).toMatch(/"alpha" completed/);
			expect(message).not.toContain("alpha done");
		});

		it.each([
			["throw", `${agentCall("alpha")} throw new Error("boom");`, /Error: Error: boom|Error: boom/],
			["exit()", `${agentCall("alpha")} exit();`, /Return value:/],
			["a deadline", `// @options: {"timeout_ms": 400}\n${agentCall("alpha")} for (;;) await null;`, /timed out/],
		])("after %s the agents are released too", async (_how, code, outcome) => {
			const t = await setup({ scenario: scenario(150) });
			const result = await t.run(code);
			// The script moved to the background at its first Agent call, or ended in front: either way, not cancelled.
			expect(statuses(result)).not.toContain("cancelled");
			await vi.waitFor(() => expect(t.groupMessages()).toHaveLength(1), { timeout: 10_000 });
			const message = t.groupMessages()[0]!;
			expect(message).toMatch(/"alpha" completed/);
			expect(message).toContain("alpha done");
			if (message.startsWith("Background script")) expect(message).toMatch(outcome);
		});

		it("an abort still stops them: Esc on a foreground script, x on a running script, the session end", async () => {
			// Esc: a pinned foreground script waiting for its agent.
			const esc = await setup({ scenario: scenario(300, { abortSettles: true }) });
			const pending = esc.run(`${agentCall("alpha", "run_in_background: false")} await new Promise(() => {});`);
			await vi.waitFor(() => expect(esc.script()?.agents.length).toBe(1));
			await esc.harness.session.abort();
			await pending;
			expect(statuses(getToolResult(esc.harness, "codemode"))).toEqual(["cancelled"]);
			await vi.waitFor(() => expect(registry.get(esc.script().agents[0]!)?.status).toBe("stopped"), {
				timeout: 5000,
			});
			expect(esc.groupMessages()).toHaveLength(0);

			// x on a script whose code still runs.
			const x = await setup({ scenario: scenario(300, { abortSettles: true }) });
			await x.run(`${agentCall("alpha")} await new Promise(() => {});`);
			await vi.waitFor(() => expect(x.script()?.agents.length).toBe(1));
			await scripts.stop(x.script().id);
			await vi.waitFor(() => expect(x.script().state).toBe("stopped"));
			expect(x.script().group).toBeUndefined();
			expect(registry.get(x.script().agents[0]!)?.status).not.toBe("running");
		});
	});

	describe("groups", () => {
		it("a member that settles before the script ends: only its line; members still running at the end: their output", async () => {
			const t = await setup({ scenario: scenario(100) });
			await t.run(
				`await tools.Agent({ description: "alpha", prompt: "alpha task" }); ${agentCall("beta")} return 1;`,
			);
			await vi.waitFor(() => expect(t.groupMessages()).toHaveLength(1), { timeout: 10_000 });
			const message = t.groupMessages()[0]!;
			// It moved to the background at its first agent: the script's outcome is part of the message.
			expect(message).toMatch(/^Background script S\d+ completed\.\nReturn value:\n/);
			expect(message).toMatch(/"alpha" completed/);
			expect(message).not.toContain("alpha done");
			expect(message).toContain("Output of");
			expect(message).toContain("beta done");
			expect(t.messages()).toHaveLength(1);
		});

		it("an un-awaited member that fails to start (unknown type) is in the group message, and the group ends", async () => {
			const t = await setup();
			await t.run(`${agentCall("alpha", 'subagent_type: "nope"')} ${agentCall("beta")} return 1;`);
			await vi.waitFor(() => expect(t.groupMessages()).toHaveLength(1), { timeout: 10_000 });
			const message = t.groupMessages()[0]!;
			expect(message).toMatch(
				/- \(not started\) nope "alpha" failed[^\n]*\n {2}Error: unknown subagent_type "nope"/,
			);
			expect(message).toMatch(/"beta" completed/);
		});

		it('wake: "each": not a member, it reports on its own', async () => {
			const t = await setup({ scenario: scenario(100) });
			await t.run(`${agentCall("alpha", 'wake: "each"')} ${agentCall("beta")} return 1;`);
			await vi.waitFor(
				() => {
					expect(t.groupMessages()).toHaveLength(1);
					expect(t.messages().filter((m) => m.startsWith("Background agent"))).toHaveLength(1);
				},
				{ timeout: 10_000 },
			);
			expect(t.groupMessages()[0]).not.toMatch(/"alpha"/);
			expect(t.messages().find((m) => m.startsWith("Background agent"))).toContain("alpha done");
		});

		it("run_in_background members end with their run and report through the group", async () => {
			const t = await setup({ scenario: scenario(150) });
			const result = await t.run(
				`const a = await tools.Agent({ description: "alpha", prompt: "alpha task", run_in_background: true }); return a.status;`,
			);
			expect(text(result.content)).toContain("running");
			await vi.waitFor(() => expect(t.groupMessages()).toHaveLength(1), { timeout: 10_000 });
			expect(t.groupMessages()[0]).toMatch(/^Agents left running by script S\d+ have ended\./);
			expect(t.groupMessages()[0]).toContain("alpha done");
			expect(t.messages().filter((m) => m.startsWith("Background agent"))).toHaveLength(0);
		});

		it("a background script's end message joins the group message, with its state computed at the group's end", async () => {
			// Its only agent fails, after the script's code has ended.
			const t = await setup({ held: ["alpha"], scenario: { lines: [ev.session()], exitCode: 1, delayMs: 50 } });
			await t.run(`${agentCall("alpha")} return "ok";`, { run_in_background: true });
			await t.open("alpha");
			await vi.waitFor(() => expect(t.groupMessages()).toHaveLength(1), { timeout: 10_000 });
			// Its only agent failed after the script's code ended: the script failed, which only the group's end knows.
			expect(t.groupMessages()[0]).toMatch(/^Background script S\d+ failed\.\nError: every agent failed/);
			expect(t.messages()).toHaveLength(1);
		});

		it("a foreground script whose agents all settled before it ended has no group message", async () => {
			const t = await setup();
			const result = await t.run(
				`return (await tools.Agent({ description: "alpha", prompt: "alpha task", run_in_background: false })).output;`,
			);
			expect(text(result.content)).toContain("alpha done");
			await new Promise((r) => setTimeout(r, 300));
			expect(t.messages()).toHaveLength(0);
			expect(t.script().group).toBeUndefined();
			expect(t.script().state).toBe("completed");
		});

		it("output over 8000 bytes is cut, the rest in a file under subagents/<session id>/", async () => {
			const big = "x".repeat(9000);
			const t = await setup({
				saved: true,
				scenario: { lines: [ev.session(), ev.assistant(big), ev.turnEnd(), ev.settled()], delayMs: 100 },
			});
			await t.run(`${agentCall("alpha")} return 1;`);
			await vi.waitFor(() => expect(t.groupMessages()).toHaveLength(1), { timeout: 10_000 });
			const match = /\(cut, 9000 bytes; all of it is in (\S+)\)/.exec(t.groupMessages()[0]!);
			expect(match).not.toBeNull();
			expect(match![1]).toContain(join("subagents", t.sessionId()));
			expect(readFileSync(match![1]!, "utf8")).toBe(big);
		});

		it("usage of the agents is added to the session at the group's end", async () => {
			const t = await setup({ scenario: scenario(150) });
			await t.run(`${agentCall("alpha")} ${agentCall("beta")} return 1;`);
			const before = t.harness.session.getSessionStats().cost;
			await vi.waitFor(() => expect(t.groupMessages()).toHaveLength(1), { timeout: 10_000 });
			await vi.waitFor(() => expect(t.harness.session.getSessionStats().cost - before).toBeCloseTo(0.02));
		});

		it("an agent continued later from another script is a member of that script's group", async () => {
			const t = await setup({ saved: true, scenario: scenario(100) });
			await t.run(`${agentCall("alpha", 'name: "worker"')} return 1;`);
			await vi.waitFor(() => expect(t.groupMessages()).toHaveLength(1), { timeout: 10_000 });
			const first = t.script();
			await t.run(`tools.Agent({ description: "again", prompt: "alpha again", resume: "worker" }); return 2;`);
			await vi.waitFor(() => expect(t.groupMessages()).toHaveLength(2), { timeout: 10_000 });
			const second = t.script();
			expect(second.id).not.toBe(first.id);
			expect(t.groupMessages()[1]).toMatch(new RegExp(`^Background script ${second.id} [\\s\\S]*"again" completed`));
			expect(first.members.map((m) => m.description)).toEqual(["alpha"]);
		});

		it("stop-all during a group stops its agents; main hears one message", async () => {
			const t = await setup({ scenario: scenario(400, { abortSettles: true }) });
			await t.run(`${agentCall("alpha")} ${agentCall("beta")} return 1;`);
			await vi.waitFor(() => expect(t.script().agents).toHaveLength(2));
			await vi.waitFor(() => expect(registry.get(t.script().agents[0]!)?.status).toBe("running"));
			const { stopEverything } = await import("../../src/extensions/subagent/stop-all.ts");
			await stopEverything(t.sessionId());
			await vi.waitFor(() => expect(t.groupMessages()).toHaveLength(1), { timeout: 10_000 });
			expect(t.groupMessages()[0]).toMatch(/"alpha" failed/);
			expect(t.script().state).toBe("stopped");
			expect(t.messages()).toHaveLength(1);
		});

		it("/new or resume during a group: its agents stop and no message reaches the new session", async () => {
			const t = await setup({ scenario: scenario(400) });
			await t.run(`${agentCall("alpha")} return 1;`);
			await vi.waitFor(() => expect(registry.get(t.script().agents[0] ?? "")?.status).toBe("running"));
			const old = t.script();
			await t.harness.session.reload();
			await vi.waitFor(() =>
				expect(codemodeScripts.list()).not.toContainEqual(expect.objectContaining({ id: old.id })),
			);
			await new Promise((r) => setTimeout(r, 200));
			expect(t.groupMessages()).toHaveLength(0);
			expect(registry.get(old.agents[0]!)?.status).not.toBe("running");
		});
	});

	describe("a group of run_in_background members", () => {
		it("/new during it: no message reaches the new session", async () => {
			const t = await setup({ scenario: scenario(300) });
			await t.run(
				`await tools.Agent({ description: "alpha", prompt: "alpha task", run_in_background: true }); return 1;`,
			);
			await vi.waitFor(() => expect(t.script().state).toBe("ended"));
			const old = t.script();
			await t.harness.session.reload();
			await vi.waitFor(() => expect(old.members[0]?.status).not.toBe("running"), { timeout: 5000 });
			await new Promise((r) => setTimeout(r, 200));
			expect(t.groupMessages()).toHaveLength(0);
			expect(t.messages().filter((m) => m.startsWith("Background agent"))).toHaveLength(0);
		});
	});

	describe("where it is off", () => {
		it.each([
			["subagent.backgroundScripts: false", { settings: { backgroundScripts: false } }],
			["print mode", { ui: false }],
		])("%s: a script's pending agents are cancelled as today", async (_name, options) => {
			const t = await setup({ ...options, scenario: scenario(200) });
			const result = await t.run(`${agentCall("alpha")} return 1;`);
			expect(statuses(result)).toEqual(["cancelled"]);
			await new Promise((r) => setTimeout(r, 300));
			expect(t.groupMessages()).toHaveLength(0);
			expect(codemodeScripts.list(t.sessionId())).toHaveLength(0);
		});
	});

	describe("workflows", () => {
		it("a workflow's agents form its own group; its run stays running and cannot be relaunched until the group ends", async () => {
			const t = await setup({
				scenario: scenario(200),
				workflow: [
					"export const meta = { name: 'fan', description: 'Start two agents' }",
					`${agentCall("alpha")} ${agentCall("beta")}`,
					"return 'started';",
				].join("\n"),
			});
			await t.run("return await tools.Workflow({ name: 'fan' })");
			const session = { sessionFile: t.harness.sessionManager.getSessionFile(), sessionId: t.sessionId() };
			await vi.waitFor(() =>
				expect(scripts.list(t.sessionId()).find((s) => s.workflow === "fan")?.state).toBe("ended"),
			);
			const run = runs.list(session)[0]!;
			expect(run.state).toBe("running");
			expect(runs.relaunchRefusal(session, run.id, () => false)).toBe(`run ${run.id} is still running`);
			await vi.waitFor(() => expect(t.messages().filter((m) => m.includes("(workflow fan"))).toHaveLength(1), {
				timeout: 10_000,
			});
			const message = t.messages().find((m) => m.includes("(workflow fan"))!;
			expect(message).toMatch(/^Background script S\d+ \(workflow fan, run R\d+\) completed\./);
			expect(message).toContain("alpha done");
			expect(message).toContain("beta done");
			expect(runs.get(session, run.id)!.state).toBe("completed");
		});
	});

	describe("the subagent add-on", () => {
		it("lets only Agent calls and agent()'s global outlive a script, and only where background scripts are on", () => {
			const off = codemodeScripts.provideBackground({ sessionId: () => "addon-session", enabled: () => true });
			try {
				const outlives = (kind: "tool" | "global", name: string, session = "addon-session") =>
					scriptHelpers.outlives!({ kind, name }, session);
				expect(outlives("tool", "Agent")).toBe(true);
				expect(outlives("global", "__subagentAgent")).toBe(true);
				expect(outlives("tool", "SendMessage")).toBe(false);
				expect(outlives("tool", "Workflow")).toBe(false);
				expect(outlives("tool", "bash")).toBe(false);
				expect(outlives("global", "__subagentNote")).toBe(false);
				expect(outlives("global", "Agent")).toBe(false);
				expect(outlives("tool", "Agent", "another-session")).toBe(false);
				expect(scriptHelpers.describe!("addon-session").replace?.cancelledOnEnd).toMatch(/^`Agent` calls/);
				expect(scriptHelpers.describe!("another-session")).toEqual({});
			} finally {
				off();
			}
		});
	});

	describe("descriptions", () => {
		const codemodeDescription = (h: Harness) =>
			h.session.agent.state.tools.find((t) => t.name === "codemode")!.description;
		const agentDescription = (h: Harness) => h.session.getAllTools().find((t) => t.name === "Agent")!.description;

		it("with the subagent extension and background scripts on: agents keep running, and the rules say to start and end", async () => {
			const t = await setup();
			await t.run("return 1");
			expect(codemodeDescription(t.harness)).toContain(
				"`Agent` calls still running when the script ends keep running and report to you together when all have ended; other calls are cancelled.",
			);
			expect(codemodeDescription(t.harness)).not.toContain(
				"Calls still running when the script ends are cancelled.",
			);
			expect(agentDescription(t.harness)).toContain(
				"To delegate, start the agents (`tools.Agent(...)` without `await`)",
			);
			expect(agentDescription(t.harness)).toContain('`wake: "each"`');
		});

		it.each([
			["print mode", { ui: false }],
			["subagent.backgroundScripts: false", { settings: { backgroundScripts: false } }],
		])("%s: unchanged", async (_name, options) => {
			const t = await setup(options);
			await t.run("return 1");
			expect(codemodeDescription(t.harness)).toContain("Calls still running when the script ends are cancelled.");
			expect(agentDescription(t.harness)).not.toContain("To delegate");
			expect(agentDescription(t.harness)).not.toContain('`wake: "each"`');
		});

		it("without the subagent extension: unchanged", async () => {
			const harness = await createHarness({
				initialActiveToolNames: ["codemode"],
				extensionFactories: [createCodemodeExtension()],
			});
			harnesses.push(harness);
			await harness.session.bindExtensions({ uiContext: createTestUiContext() });
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("codemode", { code: "return 1" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("go");
			expect(codemodeDescription(harness)).toContain("Calls still running when the script ends are cancelled.");
		});
	});
});
