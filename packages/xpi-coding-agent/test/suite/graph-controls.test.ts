// The controls of a graph: command nodes the engine runs, approvals, loop limits, the reminder, halts, `/graph goto`,
// and the limits of a node. The commands of the command nodes are run by a fake runner, so no shell is involved.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type Context, type FauxResponseStep, fauxAssistantMessage, fauxToolCall } from "xpi-ai";
import { GRAPH_BLOCKED, GRAPH_HALT, readState } from "xpi-graph";
import type { RunResult } from "../../src/extensions/checks/runner.ts";
import { createCodemodeExtension } from "../../src/extensions/codemode/index.ts";
import { createGraphExtension, GRAPH_MODEL, GRAPH_PROVIDER } from "../../src/extensions/graph/index.ts";
import { LIMITS_ENV } from "../../src/extensions/graph/limits.ts";
import { createHarness, createTestUiContext, getMessageText, getToolResult, type Harness } from "./harness.ts";

// build (small) -> ci (command) -> review (large) -> merge (command, after an approval) -> end.
const SHIP = `export default {
	name: "ship",
	start: "build",
	nodes: {
		build: { model: "faux/small", prompt: "Build it.", deny: ["gh pr merge"], readOnly: ["docs/**"] },
		ci: { run: "run-ci", timeout: "5s" },
		review: { model: "faux/large", prompt: "Review it.", deny: ["git push"] },
		merge: { run: "do-merge" },
	},
	edges: [
		{ from: "build", to: "ci", exit: "model" },
		{ from: "ci", to: "review", exit: "pass" },
		{ from: "ci", to: "build", exit: "fail", max: 1 },
		{ from: "review", to: "merge", exit: "approve", label: "no findings" },
		{ from: "review", to: "build", exit: "model", label: "findings to fix", max: 1 },
		{ from: "merge", to: "end", exit: "pass" },
	],
	requires: [{ before: "merge", passed: "ci", notAfter: ["build"] }],
};
`;

// Two command nodes and nothing else.
const COMMANDS = `export default {
	name: "cmds",
	start: "one",
	nodes: { one: { run: "first" }, two: { run: "second" } },
	edges: [
		{ from: "one", to: "two", exit: "pass" },
		{ from: "two", to: "end", exit: "pass" },
	],
};
`;

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

describe("graph extension: controls", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		delete process.env.XPI_SUBAGENT_DEPTH;
		delete process.env[LIMITS_ENV];
	});

	async function setup(options: { ui?: boolean; graphs?: Record<string, string> } = {}) {
		/** How each command ends, in order; a command with nothing left passes. */
		const results: Record<string, Partial<RunResult>[]> = {};
		const ran: { command: string; timeoutMs: number; cwd: string }[] = [];
		/** Commands that do not end by themselves: each runs until the test releases it or its signal aborts. */
		const held = new Set<string>();
		const release: Record<string, () => void> = {};
		const graphExtension = createGraphExtension({
			run: async (command, runOptions) => {
				ran.push({ command, timeoutMs: runOptions.timeoutMs, cwd: runOptions.cwd });
				const base = { command, output: `${command} output\n`, code: 0, timedOut: false, aborted: false };
				if (held.has(command)) {
					return new Promise<RunResult>((resolve) => {
						release[command] = () => resolve(base);
						runOptions.signal?.addEventListener("abort", () => resolve({ ...base, code: null, aborted: true }));
					});
				}
				return { ...base, ...(results[command]?.shift() ?? {}) };
			},
		});
		/** Wait until a held command has started. */
		const started = async (command: string) => {
			for (let i = 0; i < 300 && !release[command]; i++) await new Promise((resolve) => setTimeout(resolve, 10));
			if (!release[command]) throw new Error(`${command} did not start`);
		};
		const harness = await createHarness({
			// The first model is the one selected when a test starts.
			models: [{ id: "medium" }, { id: "small" }, { id: "large", reasoning: true }],
			initialActiveToolNames: ["read", "write", "bash", "codemode"],
			extensionFactories: [createCodemodeExtension(), graphExtension],
		});
		harnesses.push(harness);
		const runtime = harness.session.modelRuntime;
		harness.session.agent.streamFunction = (model, context, streamOptions) =>
			runtime.streamSimple(model, context, streamOptions);
		const notes: string[] = [];
		const statuses: (string | undefined)[] = [];
		/** What the user answers to an approval, in order. */
		const answers: (string | undefined)[] = [];
		const asked: string[] = [];
		if (options.ui ?? true) {
			await harness.session.bindExtensions({
				uiContext: createTestUiContext({
					notify: (message) => notes.push(message),
					setStatus: (key, text) => {
						if (key === "graph") statuses.push(text);
					},
					select: async (title) => {
						asked.push(title);
						return answers.shift();
					},
				}),
			});
		} else await harness.session.bindExtensions({});
		const dir = join(harness.tempDir, ".pi", "graphs");
		mkdirSync(dir, { recursive: true });
		for (const [name, text] of Object.entries(options.graphs ?? { ship: SHIP })) {
			writeFileSync(join(dir, `${name}.js`), text);
		}
		const seen: { model: string; text: string }[] = [];
		const reply =
			(message: ReturnType<typeof fauxAssistantMessage>): FauxResponseStep =>
			(context, _options, _state, model) => {
				seen.push({ model: model.id, text: textOf(context) });
				return message;
			};
		const code = (script: string) =>
			reply(fauxAssistantMessage(fauxToolCall("codemode", { code: script }), { stopReason: "toolUse" }));
		const move = (to: string, report = `done, on to ${to}`) =>
			code(
				`return (await tools.next({ to: ${JSON.stringify(to)}, report: ${JSON.stringify(report)} })).content[0].text;`,
			);
		/** A script that tries one tool call and returns what happened. */
		const attempt = (call: string) =>
			code(`try { await ${call}; return "allowed"; } catch (error) { return "refused: " + error.message; }`);
		const say = (text: string) => reply(fauxAssistantMessage(text));
		const state = () => readState(harness.sessionManager.getBranch());
		const running = () => {
			const current = state();
			if (current.status !== "running") throw new Error(`expected a running graph, got ${JSON.stringify(current)}`);
			return current;
		};
		const entries = (customType: string) =>
			harness.sessionManager
				.getBranch()
				.flatMap((entry) => (entry.type === "custom" && entry.customType === customType ? [entry.data] : []));
		const selected = () => `${harness.session.model?.provider}/${harness.session.model?.id}`;
		const toolText = () => getMessageText(getToolResult(harness, "codemode"));
		const models = () => seen.map((request) => request.model);
		const note = (part: string) => notes.find((text) => text.includes(part));
		const go = async (text: string) => {
			await harness.session.prompt(text);
			await harness.session.waitForIdle();
		};
		return {
			harness,
			notes,
			statuses,
			answers,
			asked,
			results,
			ran,
			held,
			release,
			started,
			seen,
			move,
			attempt,
			say,
			state,
			running,
			entries,
			selected,
			toolText,
			models,
			note,
			go,
		};
	}

	describe("command nodes", () => {
		it("runs a command node itself and follows its pass edge, to the end of the graph", async () => {
			const { harness, answers, asked, ran, seen, move, state, selected, models, note, go } = await setup();
			answers.push("Approve");
			harness.setResponses([move("ci", "built"), move("merge", "nothing to fix")]);
			await go("/graph start ship");

			expect(ran.map((call) => call.command)).toEqual(["run-ci", "do-merge"]);
			// The node's timeout, and the default; the session's directory.
			expect(ran.map((call) => call.timeoutMs)).toEqual([5000, 600_000]);
			expect(ran[0].cwd).toBe(harness.tempDir);
			// No request went to a model for a command node.
			expect(models()).toEqual(["small", "large"]);
			// The next node reads the command's result and the end of its output.
			expect(seen[1].text).toContain('[graph ship] Command node "ci" passed (exit 0).');
			expect(seen[1].text).toContain("$ run-ci");
			expect(seen[1].text).toContain("run-ci output");
			expect(seen[1].text).toContain('[graph ship] You are now in node "review".');
			expect(asked).toEqual(['Graph ship: let "review" go on to "merge"?']);
			expect(state()).toMatchObject({ status: "none", ended: { reason: "done" } });
			expect(selected()).toBe("faux/medium");
			expect(note("ship is finished")).toBeDefined();
		});

		it("follows the fail edge with the output, and halts on the command node when that edge is at its limit", async () => {
			const { harness, results, seen, move, running, entries, statuses, note, models, go } = await setup();
			results["run-ci"] = [
				{ code: 1, output: "1 test failed\n" },
				{ code: 1, output: "still failing\n" },
			];
			harness.setResponses([move("ci"), move("ci", "fixed, I think")]);
			await go("/graph start ship");

			expect(seen[1].text).toContain('[graph ship] Command node "ci" failed (exit 1).');
			expect(seen[1].text).toContain("1 test failed");
			expect(models()).toEqual(["small", "small"]);
			// `ci -> build` has max 1: the second failure has nowhere to go.
			const halted = running();
			expect(halted.node).toBe("ci");
			expect(halted.halted).toBe('"ci" failed and "ci" -> "build" was taken 1 times, its limit');
			expect(entries(GRAPH_HALT)).toHaveLength(1);
			expect(note("Run /graph goto <node> to go on")).toBeDefined();
			// `build -> ci` was taken twice; it is on a loop, so it has the default limit of 3.
			expect(statuses.at(-1)).toBe("graph ship: ci (2/3) (halted)");
		});

		it("halted on a command node: the pre-graph model answers, the model cannot move, every deny holds, goto leaves", async () => {
			const { harness, results, move, attempt, say, running, toolText, models, entries, go } = await setup();
			results["run-ci"] = [{ code: 1 }, { code: 1 }];
			harness.setResponses([move("ci"), move("ci")]);
			await go("/graph start ship");
			expect(running().node).toBe("ci");

			// The user talks to the session. No node is at work, so the model selected before the graph answers.
			harness.setResponses([move("review", "let me through"), say("I cannot move the graph.")]);
			await go("look at the log");
			expect(models().slice(-2)).toEqual(["medium", "medium"]);
			expect(toolText()).toContain('The graph is on the command node "ci". Only the user moves it from here');
			// A message does not leave this halt.
			expect(running().halted).toBeDefined();

			// The deny lists of every node hold: `build` denies the merge, `review` the push.
			harness.setResponses([attempt('tools.bash({ command: "gh pr merge 12" })'), say("Blocked.")]);
			await go("merge it anyway");
			expect(toolText()).toContain('refused: `gh pr merge` is not allowed in node "ci" of graph ship.');
			harness.setResponses([attempt('tools.bash({ command: "git push origin main" })'), say("Blocked.")]);
			await go("push it then");
			expect(toolText()).toContain("refused: `git push` is not allowed");
			expect(entries(GRAPH_BLOCKED)).toEqual([
				{ tool: "bash", rule: "deny: gh pr merge", node: "ci" },
				{ tool: "bash", rule: "deny: git push", node: "ci" },
			]);

			// The user's jump leaves the halt, and the counts start again.
			harness.setResponses([say("Building again."), say("Still building.")]);
			await go("/graph goto build");
			expect(running().node).toBe("build");
			expect(running().counts.every((count) => count === 0)).toBe(true);
			expect(models().at(-1)).toBe("small");
		});

		it("halts when a command's result has no edge", async () => {
			const { harness, answers, results, move, running, go } = await setup();
			answers.push("Approve");
			results["do-merge"] = [{ code: 2, output: "merge conflict\n" }];
			harness.setResponses([move("ci"), move("merge")]);
			await go("/graph start ship");
			expect(running().node).toBe("merge");
			expect(running().halted).toBe('"merge" failed and has no fail edge');
		});

		it("takes a timeout for a failure, and says so", async () => {
			const { harness, results, seen, move, say, running, go } = await setup();
			results["run-ci"] = [{ code: null, timedOut: true, output: "waiting...\n" }];
			harness.setResponses([move("ci"), say("Looking at it."), say("Still looking.")]);
			await go("/graph start ship");
			expect(seen[1].text).toContain('[graph ship] Command node "ci" timed out.');
			expect(running().node).toBe("build");
		});

		it("halts when the command is stopped while it runs", async () => {
			const { harness, results, move, running, go } = await setup();
			results["run-ci"] = [{ code: null, aborted: true }];
			harness.setResponses([move("ci")]);
			await go("/graph start ship");
			expect(running().node).toBe("ci");
			expect(running().halted).toBe('"ci" was stopped while its command ran');
		});

		it("keeps the last 200 lines of a long output", async () => {
			const { harness, results, seen, move, say, go } = await setup();
			const lines = Array.from({ length: 450 }, (_, index) => `line ${index + 1}`).join("\n");
			results["run-ci"] = [{ code: 1, output: `${lines}\n` }];
			harness.setResponses([move("ci"), say("Reading."), say("Still reading.")]);
			await go("/graph start ship");
			expect(seen[1].text).toContain("(the last 200 of 450 lines)");
			expect(seen[1].text).toContain("line 251\n");
			expect(seen[1].text).toContain("line 450");
			expect(seen[1].text).not.toContain("line 250\n");
		});

		it("stops a command that runs at a turn's end with /graph stop, and runs nothing after it", async () => {
			const { harness, answers, held, started, ran, move, state, selected, models, entries } = await setup();
			answers.push("Approve");
			held.add("run-ci");
			harness.setResponses([move("ci")]);
			const turn = harness.session.prompt("/graph start ship");
			await started("run-ci");
			// While the command runs the graph is on the command node: every node's deny is in force, for children too.
			expect(JSON.parse(process.env[LIMITS_ENV] ?? "null")).toMatchObject({
				node: "ci",
				deny: ["gh pr merge", "git push"],
				readOnly: [],
			});
			await harness.session.prompt("/graph stop");
			await turn;
			await harness.session.waitForIdle();
			// The command was aborted, the graph is over, and nothing went on from the command's result.
			expect(ran.map((call) => call.command)).toEqual(["run-ci"]);
			expect(state()).toMatchObject({ status: "none", ended: { reason: "stopped" } });
			expect(models()).toEqual(["small"]);
			expect(selected()).toBe("faux/medium");
			expect(entries("graph.node")).toEqual([{ node: "build", via: "start" }]);
			expect(process.env[LIMITS_ENV]).toBeUndefined();
		});

		it("stops a command started by /graph goto with /graph stop", async () => {
			const { harness, held, started, ran, say, state, go } = await setup();
			harness.setResponses([say("Building."), say("Still building.")]);
			await go("/graph start ship");
			held.add("run-ci");
			const jump = harness.session.prompt("/graph goto ci");
			await started("run-ci");
			// A second jump has to wait for the command.
			await harness.session.prompt("/graph goto review");
			await harness.session.prompt("/graph stop");
			await jump;
			expect(ran.map((call) => call.command)).toEqual(["run-ci"]);
			expect(state()).toMatchObject({ status: "none", ended: { reason: "stopped" } });
		});

		it("starts in a command node, and runs a graph of command nodes to its end without a model", async () => {
			const { harness, ran, state, models, selected, go } = await setup({ graphs: { cmds: COMMANDS } });
			await go("/graph start cmds");
			expect(ran.map((call) => call.command)).toEqual(["first", "second"]);
			expect(models()).toEqual([]);
			expect(state()).toMatchObject({ status: "none", ended: { reason: "done" } });
			expect(selected()).toBe("faux/medium");
			expect(harness.getPendingResponseCount()).toBe(0);
		});
	});

	describe("approval", () => {
		const toReview = async (context: Awaited<ReturnType<typeof setup>>) => {
			context.harness.setResponses([context.move("ci")]);
			await context.go("/graph start ship");
		};

		it("sent back: the node stays, the user's comment is the next message, and the model may ask again", async () => {
			const context = await setup();
			const { harness, answers, ran, move, running, toolText, state, go } = context;
			answers.push("Send back");
			harness.setResponses([move("ci"), move("merge", "looks fine")]);
			await go("/graph start ship");
			expect(toolText()).toContain("The user sent this back and will say why.");
			expect(running().node).toBe("review");
			expect(running().pending).toBeUndefined();
			expect(running().halted).toBeUndefined();
			expect(ran.map((call) => call.command)).toEqual(["run-ci"]);

			answers.push("Approve");
			harness.setResponses([move("merge", "checked the migration too")]);
			await go("you missed the migration");
			expect(ran.map((call) => call.command)).toEqual(["run-ci", "do-merge"]);
			expect(state().status).toBe("none");
		});

		it("dismissed: not an approval", async () => {
			const context = await setup();
			context.answers.push(undefined);
			await toReview(context);
			context.harness.setResponses([context.move("merge")]);
			await context.go("go on");
			expect(context.running().node).toBe("review");
			expect(context.ran.map((call) => call.command)).toEqual(["run-ci"]);
		});

		it("stopped: the graph ends and the selection is given back", async () => {
			const context = await setup();
			context.answers.push("Stop the graph");
			context.harness.setResponses([context.move("ci"), context.move("merge")]);
			await context.go("/graph start ship");
			expect(context.state()).toMatchObject({ status: "none", ended: { reason: "stopped" } });
			expect(context.selected()).toBe("faux/medium");
			expect(context.ran.map((call) => call.command)).toEqual(["run-ci"]);
		});

		it("without a UI: the graph halts, nobody approves", async () => {
			const context = await setup({ ui: false });
			context.harness.setResponses([context.move("ci"), context.move("merge")]);
			await context.go("/graph start ship");
			expect(context.running().node).toBe("review");
			expect(context.running().halted).toBe(
				'"review" -> "merge" needs the user\'s approval, and there is no UI to ask',
			);
			expect(context.ran.map((call) => call.command)).toEqual(["run-ci"]);
		});
	});

	describe("a turn that ends without a move", () => {
		it("gets one reminder, then the graph halts; the user's message leaves the halt", async () => {
			const { harness, seen, say, move, running, note, go, models } = await setup();
			harness.setResponses([say("I think it is built."), say("Yes, built.")]);
			await go("/graph start ship");
			expect(models()).toEqual(["small", "small"]);
			expect(seen[1].text).toContain('You ended your turn in node "build" without leaving it.');
			expect(running().node).toBe("build");
			expect(running().halted).toBe('"build" ended its turn twice without a move');
			expect(note("Answer to go on in this node")).toBeDefined();

			harness.setResponses([move("ci")]);
			await go("then hand it to ci");
			expect(running().node).toBe("review");
		});

		it("is left alone in a node that has an approval exit: it talks with the user", async () => {
			const { harness, move, say, running, go } = await setup();
			harness.setResponses([move("ci"), say("Shall I let it through?")]);
			await go("/graph start ship");
			expect(running().node).toBe("review");
			expect(running().halted).toBeUndefined();
			expect(running().reminded).toBe(false);
			expect(harness.getPendingResponseCount()).toBe(0);
		});
	});

	describe("the limits of a node", () => {
		it("blocks a denied command and a write to a read-only path, in a codemode script, and records them", async () => {
			const { harness, seen, attempt, say, toolText, entries, note, go } = await setup();
			harness.setResponses([
				attempt('tools.bash({ command: "echo before && gh pr merge 12 --squash" })'),
				attempt('tools.write({ path: "docs/guide.md", content: "x" })'),
				attempt('tools.write({ path: "src.txt", content: "x" })'),
				attempt('tools.bash({ command: "echo allowed" })'),
				say("Done trying."),
				say("Nothing more."),
			]);
			await go("/graph start ship");
			const results = harness.session.messages
				.filter((message) => message.role === "toolResult")
				.map(getMessageText);
			expect(results[0]).toContain(
				'refused: `gh pr merge` is not allowed in node "build" of graph ship. The graph has its own step for it.',
			);
			expect(results[1]).toContain('refused: `docs/guide.md` cannot be written in node "build" of graph ship.');
			expect(results[2]).toContain("allowed");
			expect(results[3]).toContain("allowed");
			expect(toolText()).toBeDefined();
			expect(entries(GRAPH_BLOCKED)).toEqual([
				{ tool: "bash", rule: "deny: gh pr merge", node: "build" },
				{ tool: "write", rule: "readOnly", node: "build" },
			]);
			expect(note('blocked bash in "build" (deny: gh pr merge)')).toBeDefined();
			// The node is told its read-only paths, and that they hold for the shell too.
			expect(seen[0].text).toContain("In this node you must not write these paths (gitignore patterns): docs/**.");
			expect(seen[0].text).toContain("shell commands too");
		});

		it("applies each node's own list: what one node denies another may run", async () => {
			const { harness, move, attempt, say, go } = await setup();
			harness.setResponses([
				move("ci"),
				// `review` denies the push, not the merge.
				attempt('tools.bash({ command: "echo gh pr merge" })'),
				attempt('tools.bash({ command: "git push" })'),
				say("Reviewed."),
			]);
			await go("/graph start ship");
			const results = harness.session.messages
				.filter((message) => message.role === "toolResult")
				.map(getMessageText);
			expect(results.at(-2)).toContain("allowed");
			expect(results.at(-1)).toContain('refused: `git push` is not allowed in node "review"');
		});

		it("keeps the graph files read-only while a graph runs, and free again after it", async () => {
			const { harness, attempt, say, toolText, go } = await setup();
			const write = attempt('tools.write({ path: ".pi/graphs/ship.js", content: "export default {};" })');
			harness.setResponses([write, say("Tried."), say("Nothing more.")]);
			await go("/graph start ship");
			const results = harness.session.messages
				.filter((message) => message.role === "toolResult")
				.map(getMessageText);
			expect(results[0]).toContain("refused: `.pi/graphs/ship.js` cannot be written while a graph runs");
			await go("/graph stop");
			harness.setResponses([write, say("Tried again.")]);
			await go("now write it");
			// The graph no longer stands in the way (the file tools' own rule about unread files still does).
			expect(toolText()).not.toContain("cannot be written while a graph runs");
		});

		it("leaves the node's limits in the environment for a subagent child, and takes them away at the end", async () => {
			const { harness, say, go } = await setup();
			harness.setResponses([say("Building."), say("Still building.")]);
			await go("/graph start ship");
			expect(JSON.parse(process.env[LIMITS_ENV] ?? "null")).toMatchObject({
				graph: "ship",
				node: "build",
				deny: ["gh pr merge"],
				readOnly: ["docs/**"],
			});
			await go("/graph stop");
			expect(process.env[LIMITS_ENV]).toBeUndefined();
			expect(harness.session.model?.id).toBe("medium");
		});

		it("in a subagent child: the parent's limits hold, and nothing else of the extension exists", async () => {
			process.env.XPI_SUBAGENT_DEPTH = "1";
			process.env[LIMITS_ENV] = JSON.stringify({
				graph: "ship",
				node: "review",
				deny: ["gh pr merge"],
				readOnly: ["docs/**"],
				protected: [],
			});
			const { harness, attempt, say, go } = await setup();
			expect(harness.session.modelRuntime.getModel(GRAPH_PROVIDER, GRAPH_MODEL)).toBeUndefined();
			harness.setResponses([
				attempt('tools.bash({ command: "gh pr merge 12" })'),
				attempt('tools.write({ path: "docs/a.md", content: "x" })'),
				attempt('tools.bash({ command: "echo fine" })'),
				say("Reviewed."),
			]);
			await go("review the change");
			const results = harness.session.messages
				.filter((message) => message.role === "toolResult")
				.map(getMessageText);
			expect(results[0]).toContain('refused: `gh pr merge` is not allowed in node "review" of graph ship.');
			expect(results[1]).toContain("refused: `docs/a.md` cannot be written");
			expect(results[2]).toContain("allowed");
		});

		it("in a subagent child with limits it cannot read: nothing is blocked, nothing breaks", async () => {
			process.env.XPI_SUBAGENT_DEPTH = "1";
			process.env[LIMITS_ENV] = "{ not json";
			const { harness, attempt, say, toolText, go } = await setup();
			harness.setResponses([attempt('tools.bash({ command: "echo gh pr merge" })'), say("Done.")]);
			await go("go");
			expect(toolText()).toContain("allowed");
		});
	});

	describe("/graph goto", () => {
		it("jumps to any node, whatever the edges say, and records it", async () => {
			const { harness, say, running, entries, note, models, go } = await setup();
			harness.setResponses([say("Building."), say("Still building.")]);
			await go("/graph start ship");
			harness.setResponses([say("Reviewing."), say("Reviewed, waiting.")]);
			await go("/graph goto review");
			expect(running().node).toBe("review");
			expect(running().visited).toEqual(["build", "review"]);
			expect(models().at(-1)).toBe("large");
			expect(entries("graph.node").at(-1)).toEqual({ node: "review", via: "goto" });
			expect(note('"build" -> "review" (goto)')).toBeDefined();
		});

		it("runs the command of a command node it jumps to, and goes on from its result", async () => {
			const { harness, ran, say, running, models, go } = await setup();
			harness.setResponses([say("Building."), say("Still building.")]);
			await go("/graph start ship");
			harness.setResponses([say("Reviewing.")]);
			await go("/graph goto ci");
			expect(ran.map((call) => call.command)).toEqual(["run-ci"]);
			expect(running().node).toBe("review");
			expect(models().at(-1)).toBe("large");
		});

		it("refuses a node the graph does not have, and a jump with no graph running", async () => {
			const { harness, notes, say, running, go } = await setup();
			await go("/graph goto build");
			expect(notes.at(-1)).toContain("no graph is running");
			harness.setResponses([say("Building."), say("Still building.")]);
			await go("/graph start ship");
			await go("/graph goto deploy");
			expect(notes.at(-1)).toContain('no node "deploy" (nodes: build, ci, review, merge)');
			expect(running().node).toBe("build");
		});
	});
});
