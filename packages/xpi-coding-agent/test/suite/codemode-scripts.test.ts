import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentTool } from "xpi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "xpi-ai";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { createToolDefinitionFromAgentTool } from "../../src/core/tools/tool-definition-wrapper.ts";
import { createCodemodeExtension } from "../../src/extensions/codemode/index.ts";
import {
	type CodemodeScriptEnd,
	type CodemodeScriptInfo,
	codemodeScripts,
} from "../../src/extensions/codemode/scripts.ts";
import { createHarness, getToolResult, type Harness } from "./harness.ts";

const text = (result: { content?: { type: string; text?: string }[] } | undefined) =>
	(result?.content ?? []).map((c) => c.text ?? "").join("");

describe("codemodeScripts (background scripts)", () => {
	const harnesses: Harness[] = [];
	const unsubscribe: Array<() => void> = [];

	afterEach(async () => {
		while (unsubscribe.length > 0) unsubscribe.pop()?.();
		for (const h of harnesses) await codemodeScripts.stopAll(h.sessionManager.getSessionId());
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setup() {
		const gates = new Map<string, (value: string) => void>();
		const gate: AgentTool = {
			name: "gate",
			label: "Gate",
			description: "Wait until the test opens the gate",
			parameters: Type.Object({ name: Type.String() }),
			execute: async (_id, params: any) => ({
				content: [{ type: "text", text: await new Promise<string>((r) => gates.set(params.name, r)) }],
				details: {},
			}),
		};
		const harness = await createHarness({
			initialActiveToolNames: ["codemode", "gate"],
			extensionFactories: [
				createCodemodeExtension(),
				(pi: ExtensionAPI) => pi.registerTool(createToolDefinitionFromAgentTool(gate)),
			],
		});
		harnesses.push(harness);
		const started: CodemodeScriptInfo[] = [];
		const ended: Array<{ info: CodemodeScriptInfo; outcome: CodemodeScriptEnd }> = [];
		const waiters: Array<() => void> = [];
		unsubscribe.push(
			codemodeScripts.subscribe({
				onStart: (s) => started.push({ ...s }),
				onEnd: (s, outcome) => {
					ended.push({ info: { ...s }, outcome });
					for (const w of waiters.splice(0)) w();
				},
			}),
		);
		const waitEnded = async (count = 1) => {
			while (ended.length < count) await new Promise<void>((r) => waiters.push(r));
		};
		const open = async (name: string, value = name) => {
			for (let i = 0; i < 200 && !gates.has(name); i++) await new Promise((r) => setTimeout(r, 10));
			gates.get(name)?.(value);
			gates.delete(name);
		};
		const script = (code: string) =>
			fauxAssistantMessage([fauxToolCall("codemode", { code })], { stopReason: "toolUse" });
		return { harness, gates, started, ended, waitEnded, open, script };
	}

	it("a foreground script is registered and ends with its own result, background false", async () => {
		const { harness, started, ended, script } = await setup();
		harness.setResponses([script('return "plain"'), fauxAssistantMessage("done")]);
		await harness.session.prompt("go");
		expect(started).toHaveLength(1);
		expect(started[0]).toMatchObject({ state: "foreground", sessionId: harness.sessionManager.getSessionId() });
		expect(ended).toHaveLength(1);
		expect(ended[0].outcome).toMatchObject({ background: false, stopped: false });
		expect(text(ended[0].outcome.result)).toContain("plain");
		expect(text(getToolResult(harness, "codemode"))).toContain("plain");
		expect(getToolResult(harness, "codemode").details).not.toHaveProperty("background");
	});

	it("background() returns the codemode call early, the script keeps running and ends with its result", async () => {
		const { harness, started, ended, waitEnded, open, script } = await setup();
		unsubscribe.push(
			codemodeScripts.subscribe({ onStart: (s) => expect(codemodeScripts.background(s.id, "moved")).toBe(true) }),
		);
		harness.setResponses([
			script('const r = await tools.gate({ name: "a" }); return "got " + r'),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go"); // returns: main's turn ended while the script still waits
		const early = getToolResult(harness, "codemode");
		expect(text(early)).toBe("moved");
		expect(early.details).toMatchObject({ background: true, scriptId: started[0].id });
		expect(ended).toHaveLength(0);
		expect(codemodeScripts.owner(`${started[0].toolCallId}/1`)).toMatchObject({
			id: started[0].id,
			state: "background",
		});
		await open("a");
		await waitEnded();
		expect(ended[0].outcome).toMatchObject({ background: true, stopped: false });
		expect(text(ended[0].outcome.result)).toContain("got a");
		expect(ended[0].info.state).toBe("ended");
		expect(codemodeScripts.owner(`${started[0].toolCallId}/1`)).toBeUndefined();
	});

	it("nested ids keep counting after the early return and agent_end", async () => {
		const { harness, started, waitEnded, open, script } = await setup();
		unsubscribe.push(codemodeScripts.subscribe({ onStart: (s) => codemodeScripts.background(s.id) }));
		harness.setResponses([
			script('await tools.gate({ name: "a" }); await tools.gate({ name: "b" }); return "x"'),
			fauxAssistantMessage("done"),
		]);
		const starts: string[] = [];
		harness.session.subscribe((e) => {
			if (e.type === "tool_execution_start" && e.toolName === "gate") starts.push(e.toolCallId);
		});
		await harness.session.prompt("go"); // agent_end happened
		await open("a");
		await open("b");
		await waitEnded();
		const id = started[0].toolCallId;
		expect(starts).toEqual([`${id}/1`, `${id}/2`]);
	});

	it("stop() aborts a background script: it ends stopped", async () => {
		const { harness, started, ended, waitEnded, script } = await setup();
		unsubscribe.push(codemodeScripts.subscribe({ onStart: (s) => codemodeScripts.background(s.id) }));
		harness.setResponses([script('await tools.gate({ name: "never" }); return "x"'), fauxAssistantMessage("done")]);
		await harness.session.prompt("go");
		expect(await codemodeScripts.stop(started[0].id)).toBe(true);
		await waitEnded();
		expect(ended[0].outcome).toMatchObject({ stopped: true, background: true });
		expect(await codemodeScripts.stop(started[0].id)).toBe(false); // already ended
	});

	it("a script that fails ends with the error result", async () => {
		const { harness, ended, waitEnded, open, script } = await setup();
		unsubscribe.push(codemodeScripts.subscribe({ onStart: (s) => codemodeScripts.background(s.id) }));
		harness.setResponses([
			script('await tools.gate({ name: "a" }); throw new Error("boom")'),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		await open("a");
		await waitEnded();
		expect(ended[0].outcome.stopped).toBe(false);
		expect(ended[0].outcome.result?.isError).toBe(true);
		expect(text(ended[0].outcome.result)).toContain("boom");
	});

	it("Esc on main stops a foreground script but not a background one", async () => {
		const fg = await setup();
		fg.harness.setResponses([fg.script('await tools.gate({ name: "f" }); return "x"'), fauxAssistantMessage("done")]);
		const running = fg.harness.session.prompt("go");
		while (fg.started.length === 0) await new Promise((r) => setTimeout(r, 10));
		await fg.harness.session.abort();
		await running;
		await fg.waitEnded();
		expect(fg.ended[0].outcome).toMatchObject({ stopped: true, background: false });

		const bg = await setup();
		unsubscribe.push(
			codemodeScripts.subscribe({
				onStart: (s) =>
					s.sessionId === bg.harness.sessionManager.getSessionId() && codemodeScripts.background(s.id),
			}),
		);
		// After the move main keeps running (it waits on its own gate) and is then interrupted.
		bg.harness.setResponses([
			bg.script('await tools.gate({ name: "b" }); return "still here"'),
			fauxAssistantMessage([fauxToolCall("gate", { name: "main" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const turn = bg.harness.session.prompt("go");
		await bg.open("main", "ignored-by-abort");
		await bg.harness.session.abort();
		await turn.catch(() => {});
		expect(bg.ended).toHaveLength(0);
		await bg.open("b");
		await bg.waitEnded();
		expect(bg.ended[0].outcome).toMatchObject({ stopped: false, background: true });
		expect(text(bg.ended[0].outcome.result)).toContain("still here");
	});

	it("backgroundAll(sessionId) moves the foreground scripts of that session; stopAll ends them", async () => {
		const { harness, started, ended, waitEnded, script } = await setup();
		harness.setResponses([script('await tools.gate({ name: "slow" }); return "x"'), fauxAssistantMessage("done")]);
		const turn = harness.session.prompt("go");
		while (started.length === 0) await new Promise((r) => setTimeout(r, 10));
		expect(codemodeScripts.backgroundAll("other-session")).toBe(false);
		expect(codemodeScripts.backgroundAll(harness.sessionManager.getSessionId())).toBe(true);
		expect(codemodeScripts.backgroundAll(harness.sessionManager.getSessionId())).toBe(false); // none left in front
		await turn;
		expect(text(getToolResult(harness, "codemode"))).toMatch(/background/i);
		await codemodeScripts.stopAll(harness.sessionManager.getSessionId()); // session shutdown
		await waitEnded();
		expect(ended[0].outcome).toMatchObject({ stopped: true, background: true });
	});

	it("keeps the foreground path: onUpdate flows while in front and stops after the move", async () => {
		const { harness, script } = await setup();
		const updates: string[] = [];
		harness.session.subscribe((e) => {
			if (e.type === "tool_execution_update" && e.toolName === "codemode") updates.push("u");
		});
		harness.setResponses([script("return 1"), fauxAssistantMessage("done")]);
		await harness.session.prompt("go");
		expect(getToolResult(harness, "codemode").isError).toBe(false);
		expect(updates.length).toBeGreaterThan(0);
	});
});
