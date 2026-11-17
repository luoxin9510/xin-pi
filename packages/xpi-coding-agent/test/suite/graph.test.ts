import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentTool } from "xpi-agent-core";
import { type Context, type FauxResponseStep, fauxAssistantMessage, fauxToolCall } from "xpi-ai";
import { GRAPH_END, GRAPH_HALT, GRAPH_MOVE, GRAPH_NODE, GRAPH_START, readState } from "xpi-graph";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createToolDefinitionFromAgentTool } from "../../src/core/tools/tool-definition-wrapper.ts";
import { createCodemodeExtension } from "../../src/extensions/codemode/index.ts";
import { codemodeScripts } from "../../src/extensions/codemode/scripts.ts";
import graphExtension, { GRAPH_MODEL, GRAPH_PROVIDER, GRAPH_SECTION } from "../../src/extensions/graph/index.ts";
import { createHarness, createTestUiContext, getMessageText, getToolResult, type Harness } from "./harness.ts";

// Three model nodes: `plan` on the large model, `build` on the small one, `check` on the model selected at the start.
const FLOW = `// A test flow.
export default {
	name: "flow",
	start: "plan",
	nodes: {
		plan: { model: "faux/large", prompt: "Plan the change." },
		build: { model: "faux/small", prompt: "Build the plan." },
		check: { prompt: "Check the build." },
	},
	edges: [
		{ from: "plan", to: "build", exit: "model" },
		{ from: "build", to: "check", exit: "model" },
		{ from: "check", to: "build", exit: "model", label: "problems found", max: 1 },
		{ from: "check", to: "end", exit: "model", label: "all fine" },
	],
};
`;

const graphFile = (name: string, body: string) => `export default { name: "${name}", start: "a", ${body} };\n`;
const TWO_NODES = 'edges: [{ from: "a", to: "b", exit: "model" }, { from: "b", to: "end", exit: "model" }]';

function textOf(context: Context): string {
	return context.messages
		.map((message) => {
			if (message.role === "assistant") {
				return message.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
			}
			if (typeof message.content === "string") return message.content;
			return message.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
		})
		.join("\n");
}

describe("graph extension", () => {
	const harnesses: Harness[] = [];
	const cleanups: (() => void)[] = [];

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0)) cleanup();
		for (const harness of harnesses) await codemodeScripts.stopAll(harness.sessionManager.getSessionId());
		for (const harness of harnesses.splice(0)) harness.cleanup();
		delete process.env.XPI_SUBAGENT_DEPTH;
	});

	async function setup(
		options: {
			codemode?: boolean;
			graph?: boolean;
			graphs?: Record<string, string>;
			sessionManager?: SessionManager;
			tools?: AgentTool[];
		} = {},
	) {
		const codemode = options.codemode ?? true;
		const harness = await createHarness({
			// The first model is the one selected when a test starts.
			models: [{ id: "medium" }, { id: "small" }, { id: "large", reasoning: true }],
			initialActiveToolNames: [
				"read",
				...(codemode ? ["codemode"] : []),
				...(options.tools ?? []).map((tool) => tool.name),
			],
			extensionFactories: [
				...(codemode ? [createCodemodeExtension()] : []),
				...((options.graph ?? true) ? [graphExtension] : []),
				...(options.tools ?? []).map(
					(tool) => (pi: ExtensionAPI) => pi.registerTool(createToolDefinitionFromAgentTool(tool)),
				),
			],
			...(options.sessionManager ? { sessionManager: options.sessionManager } : {}),
		});
		harnesses.push(harness);
		const runtime = harness.session.modelRuntime;
		harness.session.agent.streamFunction = (model, context, streamOptions) =>
			runtime.streamSimple(model, context, streamOptions);
		const notes: string[] = [];
		const statuses: (string | undefined)[] = [];
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({
				notify: (message) => notes.push(message),
				setStatus: (key, text) => {
					if (key === "graph") statuses.push(text);
				},
			}),
		});
		const dir = join(harness.tempDir, ".pi", "graphs");
		mkdirSync(dir, { recursive: true });
		for (const [name, text] of Object.entries(options.graphs ?? { flow: FLOW })) {
			writeFileSync(join(dir, `${name}.js`), text);
		}
		/** What each request saw, and which model got it. */
		const seen: { model: string; text: string; system: string; raw: string }[] = [];
		const reply =
			(message: ReturnType<typeof fauxAssistantMessage>): FauxResponseStep =>
			(context, _options, _state, model) => {
				seen.push({
					model: model.id,
					text: textOf(context),
					// The system prompt is the leading system message: its text and its named sections.
					system: context.messages
						.flatMap((message) =>
							message.role === "system"
								? [
										typeof message.content === "string"
											? message.content
											: message.content.map((block) => block.text).join("\n"),
										...Object.values(message.sections ?? {}).flatMap((section) =>
											section === null ? [] : [section],
										),
									]
								: [],
						)
						.join("\n"),
					// Everything the provider gets: the messages with their tool lists, without the timestamps.
					raw: JSON.stringify(context.messages, (key, value) => (key === "timestamp" ? undefined : value)),
				});
				return message;
			};
		const script = (to: string, report: string) =>
			`return (await tools.next({ to: ${JSON.stringify(to)}, report: ${JSON.stringify(report)} })).content[0].text;`;
		/** A turn that calls `next` from a codemode script. */
		const move = (to: string, report = `done, on to ${to}`) =>
			reply(fauxAssistantMessage(fauxToolCall("codemode", { code: script(to, report) }), { stopReason: "toolUse" }));
		const say = (text: string) => reply(fauxAssistantMessage(text));
		const state = () => readState(harness.sessionManager.getBranch());
		const running = () => {
			const current = state();
			if (current.status !== "running") throw new Error(`expected a running graph, got ${JSON.stringify(current)}`);
			return current;
		};
		const customTypes = () =>
			harness.sessionManager
				.getBranch()
				.flatMap((entry) =>
					entry.type === "custom" && entry.customType.startsWith("graph.") ? [entry.customType] : [],
				);
		const selected = () => `${harness.session.model?.provider}/${harness.session.model?.id}`;
		const toolText = () => getMessageText(getToolResult(harness, "codemode"));
		const models = () => seen.map((request) => request.model);
		const note = (part: string) => notes.find((text) => text.includes(part));
		return {
			harness,
			notes,
			statuses,
			seen,
			reply,
			script,
			move,
			say,
			state,
			running,
			customTypes,
			selected,
			toolText,
			models,
			note,
		};
	}

	it("runs a graph from start to end, each node on its own model", async () => {
		const { harness, notes, statuses, seen, move, state, customTypes, selected, models } = await setup();
		harness.setResponses([move("build", "the plan: two files"), move("check"), move("end")]);
		await harness.session.prompt("/graph start flow");
		await harness.session.waitForIdle();

		// plan on its model, build on its model, check on the model selected when the graph started.
		expect(models()).toEqual(["large", "small", "medium"]);
		expect(customTypes()).toEqual([
			GRAPH_START,
			GRAPH_NODE,
			GRAPH_MOVE,
			GRAPH_NODE,
			GRAPH_MOVE,
			GRAPH_NODE,
			GRAPH_MOVE,
			GRAPH_END,
		]);
		expect(state()).toEqual({
			status: "none",
			ended: { selection: { provider: "faux", id: "medium", thinking: expect.any(String) }, reason: "done" },
		});
		// The selection is back, and the footer followed the nodes.
		expect(selected()).toBe("faux/medium");
		expect(statuses).toEqual(
			expect.arrayContaining(["graph flow: plan", "graph flow: build", "graph flow: check (1/3)"]),
		);
		expect(statuses.at(-1)).toBeUndefined();
		expect(notes).toEqual(expect.arrayContaining(['graph: flow started in "plan"', "graph: flow is finished"]));

		// The first node is told its role and where it may go; the next node also has the report in its context.
		expect(seen[0].text).toContain('[graph flow] You are now in node "plan".');
		expect(seen[0].text).toContain("Plan the change.");
		expect(seen[0].text).toContain('- "build"');
		expect(seen[1].text).toContain('[graph flow] You are now in node "build".');
		expect(seen[1].text).toContain("the plan: two files");
		expect(seen[2].text).toContain('- "build": problems found');
		expect(seen[2].text).toContain('- "end" (the graph is finished): all fine');
		// The role prompt is a message. The system prompt carries one fixed section, the same in every node.
		const section = (text: string) => /<graph>[\s\S]*<\/graph>/.exec(text)?.[0];
		expect(section(seen[0].system)).toBeDefined();
		expect(section(seen[1].system)).toBe(section(seen[0].system));
		expect(seen[0].system).not.toContain("Plan the change.");
	});

	it("refuses a move to a node the current node has no edge to, and stays in the node", async () => {
		const { harness, move, say, running, toolText, models } = await setup();
		harness.setResponses([move("check"), say("I will plan first.")]);
		await harness.session.prompt("/graph start flow");
		await harness.session.waitForIdle();
		expect(toolText()).toContain('"check" is not a node "plan" may go to. It may go to: "build".');
		expect(running().node).toBe("plan");
		expect(running().pending).toBeUndefined();
		// The turn went on in the same node, on the same model.
		expect(models()).toEqual(["large", "large"]);
	});

	it("halts when an edge on a loop is at its limit, and the user's message leaves the halt", async () => {
		const { harness, move, say, running, toolText, note, customTypes, statuses } = await setup();
		harness.setResponses([
			move("build"),
			move("check"),
			move("build", "a test fails"),
			move("check"),
			// `check -> build` has max 1: the second time is refused.
			move("build", "it still fails"),
			// While halted, a move is refused, whatever its target.
			move("end"),
			say("I cannot go on."),
		]);
		await harness.session.prompt("/graph start flow");
		await harness.session.waitForIdle();
		const results = harness.session.messages.filter((message) => message.role === "toolResult").map(getMessageText);
		expect(results.at(-2)).toContain('The edge to "build" is at its limit of 1.');
		expect(toolText()).toContain("The graph is halted");
		expect(running().node).toBe("check");
		expect(running().halted).toBe('"check" -> "build" was taken 1 times, its limit');
		expect(customTypes().at(-1)).toBe(GRAPH_HALT);
		expect(note("halted")).toBeDefined();
		expect(statuses.at(-1)).toBe("graph flow: check (2/3) (halted)");

		// The user's next message leaves the halt: the node goes on and may finish the graph.
		harness.setResponses([move("end")]);
		await harness.session.prompt("accept it as it is");
		await harness.session.waitForIdle();
		expect(readState(harness.sessionManager.getBranch()).status).toBe("none");
	});

	it("shows the count of a looping edge in the footer", async () => {
		const { harness, move, say, statuses } = await setup();
		harness.setResponses([move("build"), move("check"), move("build"), say("building again")]);
		await harness.session.prompt("/graph start flow");
		await harness.session.waitForIdle();
		expect(statuses.at(-1)).toBe("graph flow: build (1/1)");
	});

	it("accepts one move per visit: a second call next to it is refused, and the move is entered when the turn ends", async () => {
		const { harness, reply, script, say, running, models, customTypes } = await setup();
		harness.setResponses([
			// Two scripts in one batch: the first moves, the second is refused, so the batch does not end the turn.
			reply(
				fauxAssistantMessage(
					[
						fauxToolCall("codemode", { code: script("build", "first") }),
						fauxToolCall("codemode", {
							code: `try { await tools.next({ to: "build", report: "second" }); return "moved twice"; } catch (error) { return error.message; }`,
						}),
					],
					{ stopReason: "toolUse" },
				),
			),
			say("Both calls are made."),
			say("Now building."),
		]);
		await harness.session.prompt("/graph start flow");
		await harness.session.waitForIdle();
		const results = harness.session.messages.filter((message) => message.role === "toolResult").map(getMessageText);
		expect(results.some((text) => text.includes("A move is already accepted for this visit."))).toBe(true);
		expect(results.some((text) => text.includes("moved twice"))).toBe(false);
		// The turn went on in `plan` (the node does not change in the middle of a turn), then `build` started.
		expect(models()).toEqual(["large", "large", "small"]);
		expect(customTypes().filter((type) => type === GRAPH_MOVE)).toHaveLength(1);
		expect(running().node).toBe("build");
	});

	it("refuses a move from a background script that calls it after its turn ended", async () => {
		let openGate: (() => void) | undefined;
		const gate: AgentTool = {
			name: "gate",
			label: "Gate",
			description: "Wait until the test opens the gate",
			parameters: Type.Object({}),
			execute: async () => {
				await new Promise<void>((resolve) => {
					openGate = resolve;
				});
				return { content: [{ type: "text", text: "open" }], details: {} };
			},
		};
		const { harness, reply, say, running, customTypes } = await setup({ tools: [gate] });
		cleanups.push(
			codemodeScripts.provideBackground({
				sessionId: () => harness.sessionManager.getSessionId(),
				enabled: () => true,
			}),
		);
		const outcomes: string[] = [];
		let scriptEnded: (() => void) | undefined;
		const ended = new Promise<void>((resolve) => {
			scriptEnded = resolve;
		});
		cleanups.push(
			codemodeScripts.subscribe({
				onStart: () => {},
				onEnd: (_info, outcome) => {
					outcomes.push(JSON.stringify(outcome));
					scriptEnded?.();
				},
			}),
		);
		harness.setResponses([
			reply(
				fauxAssistantMessage(
					fauxToolCall("codemode", {
						code: `await tools.gate({}); try { await tools.next({ to: "build", report: "late" }); return "moved"; } catch (error) { return error.message; }`,
						run_in_background: true,
					}),
					{ stopReason: "toolUse" },
				),
			),
			say("The script runs in the background."),
		]);
		await harness.session.prompt("/graph start flow");
		await harness.session.waitForIdle();
		for (let i = 0; i < 200 && !openGate; i++) await new Promise((resolve) => setTimeout(resolve, 10));
		openGate?.();
		await ended;
		expect(outcomes.join("\n")).toContain("A move is made in the turn of its node, not from a background script.");
		expect(customTypes()).not.toContain(GRAPH_MOVE);
		expect(running().node).toBe("plan");
	});

	it("refuses a move from a background script of an earlier node that calls it in a later node's turn", async () => {
		let openGate: (() => void) | undefined;
		const gate: AgentTool = {
			name: "gate",
			label: "Gate",
			description: "Wait until the test opens the gate",
			parameters: Type.Object({}),
			execute: async () => {
				await new Promise<void>((resolve) => {
					openGate = resolve;
				});
				return { content: [{ type: "text", text: "open" }], details: {} };
			},
		};
		const { harness, reply, script, say, running, customTypes, models } = await setup({ tools: [gate] });
		cleanups.push(
			codemodeScripts.provideBackground({
				sessionId: () => harness.sessionManager.getSessionId(),
				enabled: () => true,
			}),
		);
		const outcomes: string[] = [];
		let scriptEnded: (() => void) | undefined;
		const ended = new Promise<void>((resolve) => {
			scriptEnded = resolve;
		});
		cleanups.push(
			codemodeScripts.subscribe({
				onStart: () => {},
				onEnd: (info, outcome) => {
					// Only the script that waits at the gate: the node's own script ends too.
					if (!info.code?.includes("tools.gate")) return;
					outcomes.push(JSON.stringify(outcome));
					scriptEnded?.();
				},
			}),
		);
		harness.setResponses([
			// In `plan`: a background script that will ask for `check` later, and the node's own move to `build`.
			reply(
				fauxAssistantMessage(
					[
						fauxToolCall("codemode", {
							code: `await tools.gate({}); try { await tools.next({ to: "check", report: "from plan" }); return "moved"; } catch (error) { return error.message; }`,
							run_in_background: true,
						}),
						fauxToolCall("codemode", { code: script("build", "the plan") }),
					],
					{ stopReason: "toolUse" },
				),
			),
			say("The plan is handed on."),
			// In `build`, while its turn runs, the old script wakes up. `build -> check` is a declared edge.
			async (context, options, state, model) => {
				for (let i = 0; i < 200 && !openGate; i++) await new Promise((resolve) => setTimeout(resolve, 10));
				openGate?.();
				await ended;
				const step = say("Building.");
				return typeof step === "function" ? step(context, options, state, model) : step;
			},
		]);
		await harness.session.prompt("/graph start flow");
		await harness.session.waitForIdle();
		expect(models()).toEqual(["large", "large", "small"]);
		expect(outcomes.join("\n")).toContain("A move is made in the turn of its node, not from a background script.");
		expect(outcomes.join("\n")).not.toContain("moved");
		expect(customTypes().filter((type) => type === GRAPH_MOVE)).toHaveLength(1);
		expect(running().node).toBe("build");
		expect(running().pending).toBeUndefined();
	});

	it("is where its entries say after a resume, and goes on from there", async () => {
		const sessionManager = SessionManager.inMemory();
		const first = await setup({ sessionManager });
		first.harness.setResponses([first.move("build"), first.say("Half built.")]);
		await first.harness.session.prompt("/graph start flow");
		await first.harness.session.waitForIdle();
		expect(first.running().node).toBe("build");

		const second = await setup({ sessionManager });
		expect(second.running().node).toBe("build");
		expect(second.running().counts).toEqual(first.running().counts);
		expect(second.statuses).toContain("graph flow: build");
		// The resumed session selects the graph model again, as the core does from the session's last selection.
		const router = second.harness.session.modelRuntime.getModel(GRAPH_PROVIDER, GRAPH_MODEL);
		expect(router).toBeDefined();
		if (router) await second.harness.session.setModel(router);
		expect(second.running().node).toBe("build");
		second.harness.setResponses([second.move("check"), second.say("Checking.")]);
		await second.harness.session.prompt("go on");
		await second.harness.session.waitForIdle();
		expect(second.models()).toEqual(["small", "medium"]);
		expect(second.running().node).toBe("check");
	});

	it("enters a move whose turn never settled before the next run", async () => {
		const sessionManager = SessionManager.inMemory();
		const first = await setup({ sessionManager });
		first.harness.setResponses([first.say("Planning.")]);
		await first.harness.session.prompt("/graph start flow");
		await first.harness.session.waitForIdle();
		// The process died after `next` wrote the move and before the turn ended.
		sessionManager.appendCustomEntry(GRAPH_MOVE, { edge: 0, via: "model", report: "the plan" });
		expect(first.running().pending).toBeDefined();

		const second = await setup({ sessionManager });
		const router = second.harness.session.modelRuntime.getModel(GRAPH_PROVIDER, GRAPH_MODEL);
		if (router) await second.harness.session.setModel(router);
		second.harness.setResponses([second.say("Building.")]);
		await second.harness.session.prompt("continue");
		await second.harness.session.waitForIdle();
		expect(second.running().node).toBe("build");
		expect(second.running().pending).toBeUndefined();
		expect(second.models()).toEqual(["small"]);
		expect(second.seen[0].text).toContain('[graph flow] You are now in node "build".');
	});

	it("says the node's role again after a compaction", async () => {
		const { harness, say, running } = await setup();
		harness.setResponses([say("Planning."), say("Still planning.")]);
		await harness.session.prompt("/graph start flow");
		await harness.session.waitForIdle();
		await harness.session.prompt("go on");
		harness.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
		// A compaction asks for up to two summaries.
		harness.setResponses([
			fauxAssistantMessage("The summary so far."),
			fauxAssistantMessage("The summary of the turn."),
		]);
		await harness.session.compact();
		const enters = harness.sessionManager
			.getBranch()
			.flatMap((entry) =>
				entry.type === "custom_message" && entry.customType === "graph.enter" ? [String(entry.content)] : [],
			);
		expect(enters.at(-1)).toContain('[graph flow] You are still in node "plan".');
		expect(enters.at(-1)).toContain("Plan the change.");
		// A repeat is not a visit: the state is where it was.
		expect(running().visited).toEqual(["plan"]);
	});

	it("enters a move after an aborted turn without a request of its own", async () => {
		const { harness, reply, script, say, running, models } = await setup();
		harness.setResponses([
			// The move is accepted, and a second call in the batch keeps the turn going.
			reply(
				fauxAssistantMessage(
					[
						fauxToolCall("codemode", { code: script("build", "the plan") }),
						fauxToolCall("codemode", { code: 'return "another call";' }),
					],
					{ stopReason: "toolUse" },
				),
			),
			// The user presses Escape during the next request.
			() => {
				void harness.session.abort();
				return fauxAssistantMessage("cut off");
			},
		]);
		await harness.session.prompt("/graph start flow");
		await harness.session.waitForIdle();
		// No request went to `build`: the cut-off turn gets none of its own, and the move is not lost.
		expect(models()).toEqual(["large"]);
		const afterAbort = running();
		expect(afterAbort.node === "build" || afterAbort.pending !== undefined).toBe(true);
		// The node starts with the user's next message.
		harness.setResponses([say("Building.")]);
		await harness.session.prompt("go on");
		await harness.session.waitForIdle();
		expect(running().node).toBe("build");
		expect(running().pending).toBeUndefined();
		expect(models().at(-1)).toBe("small");
	});

	it("stops with /graph stop and gives the selection back", async () => {
		const { harness, say, state, selected, note, customTypes } = await setup();
		harness.setResponses([say("Planning.")]);
		await harness.session.prompt("/graph start flow");
		await harness.session.waitForIdle();
		expect(selected()).toBe(`${GRAPH_PROVIDER}/${GRAPH_MODEL}`);
		await harness.session.prompt("/graph stop");
		expect(state()).toMatchObject({ status: "none", ended: { reason: "stopped" } });
		expect(selected()).toBe("faux/medium");
		expect(note("graph: stopped")).toBeDefined();
		expect(customTypes().at(-1)).toBe(GRAPH_END);
		// A second graph can start after it.
		harness.setResponses([say("Planning again.")]);
		await harness.session.prompt("/graph start flow");
		await harness.session.waitForIdle();
		expect(state().status).toBe("running");
	});

	it("ends when the user selects another model, and not when the selection is the graph's own", async () => {
		const { harness, say, state, note } = await setup();
		harness.setResponses([say("Planning.")]);
		await harness.session.prompt("/graph start flow");
		await harness.session.waitForIdle();
		expect(state().status).toBe("running");
		const small = harness.getModel("small");
		if (small) await harness.session.setModel(small);
		expect(state()).toMatchObject({ status: "none", ended: { reason: "model_changed" } });
		expect(note("ended: another model was selected")).toBeDefined();
	});

	it("shows the graphs found, and the state of a running one, with /graph", async () => {
		const { harness, say, notes, move } = await setup();
		await harness.session.prompt("/graph");
		expect(notes.at(-1)).toContain("no graph is running");
		expect(notes.at(-1)).toContain(`flow (${join(harness.tempDir, ".pi", "graphs", "flow.js")})`);
		harness.setResponses([move("build"), move("check"), say("Checking.")]);
		await harness.session.prompt("/graph start flow");
		await harness.session.waitForIdle();
		await harness.session.prompt("/graph");
		expect(notes.at(-1)).toContain("node: check");
		expect(notes.at(-1)).toContain("visited: plan -> build -> check");
		expect(notes.at(-1)).toContain('"check" -> "build": 0/1');
		await harness.session.prompt("/graph begin flow");
		expect(notes.at(-1)).toContain("usage: /graph [start <name> | stop]");
	});

	describe("a start that is refused", () => {
		const refused = async (
			options: Parameters<typeof setup>[0],
			name: string,
			before?: (harness: Harness) => Promise<void>,
		) => {
			const context = await setup(options);
			await before?.(context.harness);
			await context.harness.session.prompt(`/graph start ${name}`);
			expect(context.state().status).toBe("none");
			expect(context.customTypes()).toEqual([]);
			return context.notes.at(-1) ?? "";
		};

		it("an unknown name lists the graphs there are", async () => {
			expect(await refused({}, "deploy")).toContain('no graph "deploy" (found: flow)');
		});

		it("codemode is off", async () => {
			expect(await refused({ codemode: false }, "flow")).toContain("a graph needs codemode");
		});

		it("a virtual model is selected", async () => {
			const text = await refused({}, "flow", async (harness) => {
				const router = harness.session.modelRuntime.getModel(GRAPH_PROVIDER, GRAPH_MODEL);
				if (router) await harness.session.setModel(router);
			});
			expect(text).toContain("select a physical model first");
		});

		it("a file that is not a plain literal, with the path", async () => {
			const text = await refused({ graphs: { flow: "export default buildGraph();\n" } }, "flow");
			expect(text).toContain("flow.js: the graph is not a plain literal");
		});

		it("a graph that fails the checks, with every problem", async () => {
			const broken = graphFile(
				"flow",
				'nodes: { a: { prompt: "A" }, b: { prompt: "B" } }, edges: [{ from: "a", to: "c", exit: "model" }]',
			);
			const text = await refused({ graphs: { flow: broken } }, "flow");
			expect(text).toContain('edges[0].to: no node "c"');
		});

		it("a name that differs from the file name", async () => {
			const other = graphFile("other", `nodes: { a: { prompt: "A" }, b: { prompt: "B" } }, ${TWO_NODES}`);
			expect(await refused({ graphs: { flow: other } }, "flow")).toContain(
				'name "other" differs from the file name "flow"',
			);
		});

		it("a node whose model does not exist, or is a virtual model", async () => {
			const withModel = (model: string) =>
				graphFile("flow", `nodes: { a: { prompt: "A", model: "${model}" }, b: { prompt: "B" } }, ${TWO_NODES}`);
			expect(await refused({ graphs: { flow: withModel("faux/huge") } }, "flow")).toContain(
				"nodes.a.model: no model faux/huge",
			);
			expect(await refused({ graphs: { flow: withModel("graph/auto") } }, "flow")).toContain(
				"nodes.a.model: graph/auto is a virtual model",
			);
		});

		it("a thinking level that is not one", async () => {
			const text = await refused(
				{
					graphs: {
						flow: graphFile(
							"flow",
							`nodes: { a: { prompt: "A", thinking: "deep" }, b: { prompt: "B" } }, ${TWO_NODES}`,
						),
					},
				},
				"flow",
			);
			expect(text).toContain("nodes.a.thinking: must be one of off, minimal, low, medium, high, xhigh, max");
		});

		it.each([
			[
				"a command node",
				`nodes: { a: { prompt: "A" }, b: { run: "true" } }, edges: [{ from: "a", to: "b", exit: "model" }, { from: "b", to: "end", exit: "pass" }]`,
				'node "b" is a command node',
			],
			[
				"a node with limits",
				`nodes: { a: { prompt: "A", deny: ["rm -rf"] }, b: { prompt: "B" } }, ${TWO_NODES}`,
				'node "a" has limits (deny, readOnly)',
			],
			[
				"an approval",
				`nodes: { a: { prompt: "A" }, b: { prompt: "B" } }, edges: [{ from: "a", to: "b", exit: "approve" }, { from: "b", to: "end", exit: "model" }]`,
				'the edge "a" -> "b" needs an approval',
			],
		])("%s, which this milestone does not run yet", async (_what, body, reason) => {
			const text = await refused({ graphs: { flow: graphFile("flow", body) } }, "flow");
			expect(text).toContain(`flow cannot run yet: ${reason}, which is not supported yet`);
		});

		it("a graph already runs", async () => {
			const { harness, say, notes, customTypes } = await setup();
			harness.setResponses([say("Planning.")]);
			await harness.session.prompt("/graph start flow");
			await harness.session.waitForIdle();
			await harness.session.prompt("/graph start flow");
			expect(notes.at(-1)).toContain("a graph already runs in this session");
			expect(customTypes().filter((type) => type === GRAPH_START)).toHaveLength(1);
		});
	});

	it("answers with the last model when graph/auto is selected by hand, and says how to start a graph", async () => {
		const { harness, say, note, models } = await setup();
		harness.setResponses([say("First."), say("Second.")]);
		await harness.session.prompt("hello");
		const router = harness.session.modelRuntime.getModel(GRAPH_PROVIDER, GRAPH_MODEL);
		if (router) await harness.session.setModel(router);
		expect(note("no graph is running: start one with /graph start <name>")).toBeDefined();
		await harness.session.prompt("hello again");
		expect(models()).toEqual(["medium", "medium"]);
	});

	it("changes nothing in a request while no graph was started", async () => {
		const without = await setup({ graph: false });
		const withGraph = await setup();
		for (const context of [without, withGraph]) {
			context.harness.setResponses([context.say("Hello.")]);
			await context.harness.session.prompt("hello");
		}
		// The two sessions differ only in their temporary directory.
		const plain = (context: typeof without) => context.seen[0].system.replaceAll(context.harness.tempDir, "<cwd>");
		expect(plain(withGraph)).toBe(plain(without));
		expect(plain(without)).toContain("<cwd>");
		expect(withGraph.seen[0].system).not.toContain(`<${GRAPH_SECTION}>`);
		expect(withGraph.seen[0].raw.replaceAll(withGraph.harness.tempDir, "<cwd>")).toBe(
			without.seen[0].raw.replaceAll(without.harness.tempDir, "<cwd>"),
		);
		expect(without.seen[0].raw).toContain("codemode");
		expect(withGraph.seen[0].text.replaceAll(withGraph.harness.tempDir, "<cwd>")).toBe(
			without.seen[0].text.replaceAll(without.harness.tempDir, "<cwd>"),
		);
		expect(withGraph.harness.session.getAllTools().some((tool) => tool.name === "next")).toBe(false);
	});

	it("gives a subagent child no command, no tool and no virtual model", async () => {
		process.env.XPI_SUBAGENT_DEPTH = "1";
		const { harness } = await setup();
		expect(harness.session.modelRuntime.getModel(GRAPH_PROVIDER, GRAPH_MODEL)).toBeUndefined();
		expect(harness.session.getAllTools().some((tool) => tool.name === "next")).toBe(false);
		expect(harness.session.extensionRunner?.getCommand("graph")).toBeUndefined();
	});
});
