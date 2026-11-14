import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "xpi-ai";
import type { ExtensionAPI, ExtensionContext, TurnEndEvent } from "../../src/core/extensions/types.ts";
import { createChecksExtension } from "../../src/extensions/checks/index.ts";
import type { CheckRunner, RunResult } from "../../src/extensions/checks/runner.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const TSC = "tsc-fake";

function tscLine(file: string, message: string, line = 1): string {
	return `${file}(${line},1): error TS1: ${message}`;
}

function result(command: string, output: string, extra: Partial<RunResult> = {}): RunResult {
	return { command, output, code: output === "" ? 0 : 1, timedOut: false, aborted: false, ...extra };
}

describe("checks extension", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	/**
	 * A harness with the extension on a fake runner. `outputs` is the queue of results the fake gives, one per run, in
	 * order (the baseline is the first); `setup` can add handlers that run before the extension's.
	 */
	async function setup(options: {
		outputs: Array<string | Partial<RunResult> | (() => Promise<RunResult>)>;
		checks?: { commands?: string[]; timeoutMs?: number; maxErrors?: number };
		before?: (pi: ExtensionAPI) => void;
		terminate?: boolean;
	}) {
		const runs: string[] = [];
		const queue = [...options.outputs];
		const runner: CheckRunner = async (command) => {
			runs.push(command);
			const next = queue.shift() ?? "";
			if (typeof next === "function") return next();
			return typeof next === "string" ? result(command, next) : { ...result(command, ""), ...next };
		};
		const executed: string[] = [];
		const tools = (pi: ExtensionAPI) => {
			const make = (name: string, effect: "read" | "write", terminate = false) =>
				pi.registerTool({
					name,
					label: name,
					description: name,
					parameters: Type.Object({}),
					effect,
					execute: async () => {
						executed.push(name);
						return { content: [{ type: "text" as const, text: "ok" }], details: {}, terminate };
					},
				});
			make("look", "read");
			make("change", "write");
			make("change_and_stop", "write", true);
		};
		const harness = await createHarness({
			settings: { checks: { commands: [TSC], ...options.checks } },
			extensionFactories: [tools, (pi) => options.before?.(pi), createChecksExtension(runner)],
			initialActiveToolNames: ["look", "change", "change_and_stop"],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const turn = (tool: string) => fauxAssistantMessage(fauxToolCall(tool, {}), { stopReason: "toolUse" });
		// The message is a custom entry that reaches the model as a user-role message.
		const checkMessages = () =>
			harness.session.messages
				.filter((message) => message.role === "custom")
				.map((message) => getMessageText(message))
				.filter((text) => text.startsWith("Checks after this turn"));
		return { harness, runs, executed, turn, checkMessages };
	}

	it("does nothing without commands: no baseline, no process", async () => {
		const { harness, runs, turn, checkMessages } = await setup({ outputs: [], checks: { commands: [] } });
		harness.setResponses([turn("change"), fauxAssistantMessage("done")]);
		await harness.session.prompt("go");
		expect(runs).toEqual([]);
		expect(checkMessages()).toEqual([]);
	});

	it("sends nothing after a read-only turn", async () => {
		const { harness, runs, turn, checkMessages } = await setup({ outputs: [""] });
		harness.setResponses([turn("look"), fauxAssistantMessage("done")]);
		await harness.session.prompt("go");
		// Only the baseline ran.
		expect(runs).toEqual([TSC]);
		expect(checkMessages()).toEqual([]);
	});

	it("reports the new errors after a write turn, before the next request, and keeps earlier entries", async () => {
		const { harness, runs, turn, checkMessages } = await setup({
			outputs: [tscLine("a.ts", "old"), `${tscLine("a.ts", "old", 9)}\n${tscLine("b.ts", "new one")}`],
			before: (pi) =>
				pi.on("turn_end", (event) => ({
					entries: [...event.entries, { type: "custom", customType: "earlier", data: 1 }],
				})),
		});
		let seenByModel = "";
		harness.setResponses([
			turn("change"),
			(context) => {
				seenByModel = JSON.stringify(context.messages);
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("go");

		expect(runs).toEqual([TSC, TSC]);
		const messages = checkMessages();
		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain("1 new error");
		expect(messages[0]).toContain("b.ts:1:1 TS1: new one (tsc-fake)");
		expect(messages[0]).not.toContain("old");
		expect(seenByModel).toContain("new one");
		const entries = harness.sessionManager.getEntries();
		expect(entries).toContainEqual(expect.objectContaining({ type: "custom", customType: "earlier" }));
		expect(entries).toContainEqual(
			expect.objectContaining({ type: "custom_message", customType: "checks", display: true }),
		);
	});

	it("announces an unfixed error once, not every turn", async () => {
		const bad = tscLine("a.ts", "bad");
		const { harness, turn, checkMessages } = await setup({ outputs: ["", bad, bad] });
		harness.setResponses([turn("change"), turn("change"), fauxAssistantMessage("done")]);
		await harness.session.prompt("go");
		expect(checkMessages()).toHaveLength(1);
	});

	it("checks once per turn however many writes ran", async () => {
		const { harness, runs } = await setup({ outputs: ["", ""] });
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("change", {}), fauxToolCall("change", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		expect(runs).toHaveLength(2);
	});

	it("sends nothing when every result of the turn terminates the run", async () => {
		const { harness, runs, turn, checkMessages } = await setup({ outputs: ["", tscLine("a.ts", "bad")] });
		harness.setResponses([turn("change_and_stop")]);
		await harness.session.prompt("go");
		expect(runs).toEqual([TSC]);
		expect(checkMessages()).toEqual([]);
	});

	it("sends nothing for a call another extension blocks", async () => {
		const { harness, runs, executed, turn, checkMessages } = await setup({
			outputs: ["", tscLine("a.ts", "bad")],
			before: (pi) => pi.on("tool_call", () => ({ block: true, reason: "no" })),
		});
		harness.setResponses([turn("change"), fauxAssistantMessage("done")]);
		await harness.session.prompt("go");
		expect(executed).toEqual([]);
		expect(runs).toEqual([TSC]);
		expect(checkMessages()).toEqual([]);
	});

	it("starts no check when the run was aborted during the tools", async () => {
		const { harness, runs, turn, checkMessages } = await setup({
			outputs: ["", tscLine("a.ts", "bad")],
			before: (pi) =>
				pi.on("tool_result", (_event, ctx) => {
					ctx.abort();
				}),
		});
		harness.setResponses([turn("change"), fauxAssistantMessage("done")]);
		await harness.session.prompt("go");
		expect(runs).toEqual([TSC]);
		expect(checkMessages()).toEqual([]);
	});

	it("makes the first write wait for the baseline", async () => {
		let release: (value: RunResult) => void = () => {};
		const slow = () =>
			new Promise<RunResult>((resolve) => {
				release = resolve;
			});
		const { harness, executed, turn } = await setup({ outputs: [slow, ""] });
		harness.setResponses([turn("change"), fauxAssistantMessage("done")]);
		const prompting = harness.session.prompt("go");
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(executed).toEqual([]);
		release(result(TSC, tscLine("a.ts", "old")));
		await prompting;
		expect(executed).toEqual(["change"]);
	});

	it("stops waiting for the baseline after the commands' timeouts and reports nothing for it once", async () => {
		const never = () => new Promise<RunResult>(() => {});
		const bad = tscLine("a.ts", "bad");
		const { harness, executed, turn, checkMessages } = await setup({
			outputs: [never, bad, `${bad}\n${tscLine("b.ts", "later")}`],
			checks: { timeoutMs: 100 },
		});
		harness.setResponses([turn("change"), turn("change"), fauxAssistantMessage("done")]);
		await harness.session.prompt("go");
		expect(executed).toEqual(["change", "change"]);
		// First check: no baseline, so it only becomes the baseline. Second check: b.ts is new.
		const messages = checkMessages();
		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain("b.ts");
		expect(messages[0]).not.toContain("a.ts");
	});

	it("says a command timed out and skips it", async () => {
		const { harness, turn, checkMessages } = await setup({
			outputs: ["", { timedOut: true, code: null }],
			checks: { timeoutMs: 60_000 },
		});
		harness.setResponses([turn("change"), fauxAssistantMessage("done")]);
		await harness.session.prompt("go");
		expect(checkMessages()).toEqual([`Checks after this turn:\n${TSC}: timed out after 60 s (skipped)`]);
	});

	it("lists at most maxErrors errors and says how many more", async () => {
		const many = Array.from({ length: 5 }, (_, i) => tscLine(`f${i}.ts`, "bad")).join("\n");
		const { harness, turn, checkMessages } = await setup({ outputs: ["", many], checks: { maxErrors: 2 } });
		harness.setResponses([turn("change"), fauxAssistantMessage("done")]);
		await harness.session.prompt("go");
		const [message] = checkMessages();
		expect(message).toContain("5 new errors");
		expect(message).toContain("f0.ts");
		expect(message).toContain("f1.ts");
		expect(message).not.toContain("f2.ts");
		expect(message).toContain("and 3 more");
	});
});

// The extension on a hand-made ExtensionAPI: what a session cannot easily produce (an error outcome, a shutdown).
describe("checks extension, driven by hand", () => {
	type Handler = (event: unknown, ctx: unknown) => unknown;

	function drive(runner: CheckRunner, commands: string[] = ["one"]) {
		const handlers = new Map<string, Handler>();
		const pi = {
			on: (name: string, handler: Handler) => handlers.set(name, handler),
			registerMessageRenderer: () => {},
			getSettings: () => ({ checks: { commands } }),
		} as unknown as ExtensionAPI;
		createChecksExtension(runner)(pi);
		let controller = new AbortController();
		const ctx = {
			cwd: "/work",
			hasUI: false,
			get signal() {
				return controller.signal;
			},
		} as unknown as ExtensionContext;
		const fire = (name: string, event: unknown) => handlers.get(name)?.(event, ctx);
		const write = async () => {
			await fire("tool_call", { toolCallId: "t", effect: "write" });
			await fire("tool_result", { toolCallId: "t" });
		};
		const turnEnd = (extra: Partial<TurnEndEvent> = {}) =>
			fire("turn_end", { entries: [], outcome: "completed", terminated: false, ...extra }) as Promise<
				{ entries: Array<{ content: string }> } | undefined
			>;
		return {
			fire,
			write,
			turnEnd,
			abort: () => controller.abort(),
			/** A new run after the user's Escape: a fresh signal. */
			renew: () => {
				controller = new AbortController();
			},
		};
	}

	it("starts no check when the turn's outcome is not completed", async () => {
		const runs: string[] = [];
		const run = drive(async (command) => {
			runs.push(command);
			return result(command, "");
		});
		await run.fire("session_start", {});
		await run.write();
		expect(await run.turnEnd({ outcome: "error" })).toBeUndefined();
		expect(runs).toEqual(["one"]);
	});

	it("kills a running check at session_shutdown and reports nothing", async () => {
		let seen: AbortSignal | undefined;
		let calls = 0;
		const run = drive(async (command, { signal }) => {
			if (calls++ === 0) return result(command, "");
			seen = signal;
			await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
			return result(command, "", { aborted: true });
		});
		await run.fire("session_start", {});
		await run.write();
		const ending = run.turnEnd();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(seen?.aborted).toBe(false);
		await run.fire("session_shutdown", {});
		expect(seen?.aborted).toBe(true);
		expect(await ending).toBeUndefined();
	});

	it("keeps errors found before an abort in the middle of a check as new for the next one", async () => {
		const found = tscLine("a.ts", "fresh");
		let phase: "baseline" | "aborted" | "again" = "baseline";
		const run = drive(
			async (command) => {
				if (phase === "baseline") return result(command, "");
				if (phase === "aborted" && command === "two") {
					run.abort();
					return result(command, "", { aborted: true });
				}
				return result(command, command === "one" ? found : "");
			},
			["one", "two"],
		);
		await run.fire("session_start", {});
		await run.write();
		// "one" finds an error, then Escape aborts "two": nothing is sent.
		phase = "aborted";
		expect(await run.turnEnd()).toBeUndefined();
		// The next check sees the same error; it was never reported, so it is still new.
		run.renew();
		phase = "again";
		await run.write();
		const sent = await run.turnEnd();
		expect(sent?.entries[0].content).toContain("a.ts:1:1 TS1: fresh");
	});
});
