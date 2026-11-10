// subagent extension entry: register the `Agent` tool for codemode scripts.

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../../core/extensions/types.ts";
import { isStdoutTakenOver, writeRawStdout } from "../../core/output-guard.ts";
import { BUILTIN_SLASH_COMMANDS } from "../../core/slash-commands.ts";
import { codemodeAddons } from "../codemode/addons.ts";
import { createCodemodeExtension } from "../codemode/index.ts";
import { agentTool, describeAgents, parentContext } from "./agent-tool.ts";
import { scripts } from "./background.ts";
import { type Config, readConfig } from "./config.ts";
import { discoverAgents, setCliAgents } from "./discovery.ts";
import { bindHost, limitConcurrency } from "./exchange.ts";
import { installPanel } from "./panel.ts";
import { registry } from "./registry.ts";
import type { Run } from "./runs.ts";
import { scriptHelpers } from "./script-helpers.ts";
import { sendMessageTool } from "./send-message-tool.ts";
import { registerStructuredOutput } from "./structured-output.ts";
import { subagentsCommand } from "./subagents-command.ts";
import { startWorkflowCommand, workflowStartText } from "./workflow-run.ts";
import { saveScriptAsWorkflow } from "./workflow-save.ts";
import { describeWorkflows, runToRelaunch, workflowTool } from "./workflow-tool.ts";
import { discoverWorkflows, parseArgs, type Workflow } from "./workflows.ts";
import { workflowsCommand } from "./workflows-command.ts";

export default function subagent(pi: ExtensionAPI) {
	// Children run with XPI_SUBAGENT_DEPTH=1. Nesting is fixed at one level, so they get no Agent tool. A codemode-only child
	// gets `codemode` in mode "only" here, which replaces pi's built-in codemode extension.
	if (process.env.XPI_SUBAGENT_DEPTH) {
		if (process.env.XPI_SUBAGENT_CHILD_CODEMODE === "only") createCodemodeExtension({ mode: "only" })(pi);
		registerStructuredOutput(pi); // only when the call passed a schema
		return;
	}
	pi.registerFlag("agents", {
		type: "string",
		description:
			'Subagents for this run: a JSON object {"<name>": {"description", "prompt", ...agent-file fields}} or the path of a JSON file. They rank above agent files.',
	});

	// agent(), parallel(), pipeline(), phase(), log() in every script that can call Agent (script-helpers.ts). The add-on
	// is process-wide and the same for every session; registering it again replaces it.
	codemodeAddons.register(scriptHelpers);

	let config: Config | undefined;
	// The context of the latest event: a session start (also after /new or a resume) or an agent run. Note delivery and
	// the screens read main's state through it, never through an older context.
	let current: ExtensionContext | undefined;
	const track = (_event: unknown, ctx: ExtensionContext) => {
		current = ctx;
	};

	// A codemode script that starts an Agent moves to the background (codemode's `codemodeScripts` does the moving; unless
	// subagent.backgroundScripts is false, or there is no UI: print mode exits at the turn's end, so it stays in front).
	// Delivery to main: a steer when it runs, else a turn starts.
	let closing = false; // the session is ending: its stops send nothing to main
	// pi routes `triggerTurn` + `steer` itself: streaming -> steer, otherwise (idle, compacting) a run starts.
	const deliver = (content: string) =>
		!closing &&
		pi.sendMessage({ customType: "subagent", content, display: true }, { triggerTurn: true, deliverAs: "steer" });
	let disconnect: (() => void) | undefined;

	// Saved workflows become `/name` commands. A command cannot be unregistered: one registered for an earlier session
	// stays, and its handler looks the workflow up again when it runs (an edited file runs as edited).
	const workflowCommands = new Set<string>();
	// Names another command has (built-in, or another extension's): a workflow with one is skipped.
	const takenNames = () =>
		new Set([
			...BUILTIN_SLASH_COMMANDS.map((c) => c.name),
			...pi
				.getCommands()
				.map((c) => c.name)
				.filter((n) => !workflowCommands.has(n)),
		]);
	// The workflows runnable here now, looked up again at each run (an edited file runs as edited).
	const runnableWorkflows = (ctx: ExtensionContext) => {
		const found = discoverWorkflows(ctx.cwd, ctx.isProjectTrusted());
		const taken = takenNames();
		for (const name of [...found.workflows.keys()]) if (taken.has(name)) found.workflows.delete(name);
		return found.workflows;
	};
	const runsInBackground = (ctx: ExtensionContext) => config?.backgroundScripts !== false && ctx.hasUI;
	// `relaunch`: a run id of this workflow to start again from its saved results (its args are used, not `text`).
	const runWorkflowCommand = async (name: string, text: string, ctx: ExtensionCommandContext, relaunch?: string) => {
		const workflow = runnableWorkflows(ctx).get(name);
		if (!workflow) {
			const message = `workflow ${name} is not available here (removed, or a project workflow in an untrusted project)`;
			if (ctx.hasUI) ctx.ui.notify(message, "error");
			else process.stderr.write(`${message}\n`);
			return;
		}
		let earlier: Run | undefined;
		if (relaunch !== undefined) {
			try {
				earlier = runToRelaunch(
					{ sessionFile: ctx.sessionManager.getSessionFile(), sessionId: ctx.sessionManager.getSessionId() },
					name,
					relaunch,
				);
			} catch (err) {
				const message = `subagent: ${(err as Error).message}`;
				if (ctx.hasUI) ctx.ui.notify(message, "error");
				else process.stderr.write(`${message}\n`);
				return;
			}
		}
		const args = earlier ? earlier.args : parseArgs(text);
		const start = await startWorkflowCommand(ctx, workflow, args, runsInBackground(ctx), earlier);
		if (start.background) {
			ctx.ui.notify(workflowStartText(name, start.scriptId, start.run), "info");
			return;
		}
		const output = start.result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
		if (ctx.hasUI) deliver(`Workflow ${name} ${start.result.isError ? "failed" : "completed"}.\n${output}`);
		// Print mode keeps stdout for the answer and moves other writes to stderr; the workflow's result is the answer.
		else if (isStdoutTakenOver()) writeRawStdout(`${output}\n`);
		else process.stdout.write(`${output}\n`);
	};
	// Each runnable workflow becomes a `/name` command; the Workflow tool lists them. Returns the warnings.
	const registerWorkflows = (ctx: ExtensionContext): string[] => {
		const { workflows, warnings } = discoverWorkflows(ctx.cwd, ctx.isProjectTrusted());
		const taken = takenNames();
		const runnable: Workflow[] = [];
		for (const workflow of workflows.values()) {
			const { meta, path } = workflow;
			if (taken.has(meta.name)) {
				warnings.push(`workflow ${path} skipped: /${meta.name} is already a command`);
				continue;
			}
			runnable.push(workflow);
			if (workflowCommands.has(meta.name)) continue;
			workflowCommands.add(meta.name);
			pi.registerCommand(meta.name, {
				description: `${meta.description} (workflow)`,
				handler: (args, cctx) => runWorkflowCommand(meta.name, args, cctx),
			});
		}
		// Only offered when there is one to run (the description lists them; a workflow saved later is offered after a
		// reload). A tool cannot be unregistered: one from an earlier session stays, and finds nothing to run.
		if (runnable.length > 0) {
			pi.registerTool(
				workflowTool(
					describeWorkflows(runnable),
					(name, tctx) => runnableWorkflows(tctx).get(name),
					runsInBackground,
				),
			);
		}
		return warnings;
	};

	// `/subtask <task>`: the user starts a fork (fork.ts) with no model turn. With a UI it runs in the background and its
	// result arrives in main as a message; in print mode the command waits and prints it.
	let subtask: ((task: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
	let subtasks = 0;
	const runSubtask = async (agent: ReturnType<typeof agentTool>, task: string, ctx: ExtensionCommandContext) => {
		const say = (message: string, level: "info" | "error") =>
			ctx.hasUI ? ctx.ui.notify(message, level) : process.stderr.write(`${message}\n`);
		if (task.trim() === "") return void say("subagent: /subtask needs a task: /subtask <what to do>", "error");
		try {
			const result = await agent.execute(
				`subtask:${Date.now().toString(36)}-${++subtasks}`,
				{
					subagent_type: "fork",
					description: task.trim().split(/\s+/).slice(0, 5).join(" ").slice(0, 60),
					prompt: task.trim(),
					run_in_background: true,
				} as Parameters<typeof agent.execute>[1],
				undefined,
				undefined,
				ctx,
			);
			const r = result.details;
			if (r?.status === "running")
				return void say(`subagent: fork ${r.agentId} started; its result arrives as a message`, "info");
			const output = r?.status === "failed" ? `fork failed: ${r.error}` : (r?.output ?? "");
			if (isStdoutTakenOver()) writeRawStdout(`${output}\n`);
			else process.stdout.write(`${output}\n`);
		} catch (err) {
			say(`subagent: ${(err as Error).message}`, "error");
		}
	};
	pi.registerCommand("subtask", {
		description: "Start a fork: a copy of this conversation that does a side task and reports back",
		handler: async (args, ctx) => {
			if (!subtask) return ctx.ui.notify("subagent: the session has not started yet", "error");
			await subtask(args, ctx);
		},
	});
	pi.registerCommand("workflows", {
		description:
			"List saved workflows and this session's workflow runs; Enter runs a workflow, acts on a run that is going, or relaunches one that stopped",
		handler: (_args, ctx) =>
			workflowsCommand(ctx, runnableWorkflows(ctx), {
				run: (name) => runWorkflowCommand(name, "", ctx),
				relaunch: (name, runId) => runWorkflowCommand(name, "", ctx, runId),
			}),
	});
	pi.registerCommand("subagents", {
		description:
			"List this session's subagents; `stop` stops everything running; `worktrees` lists and removes kept worktrees",
		handler: (args, ctx) => subagentsCommand(ctx, args),
	});
	pi.on("agent_start", track);
	pi.on("agent_end", track);

	// Quit, reload, /new, resume and fork all emit session_shutdown before the runtime is torn down. Everything of this
	// session still running in the background stops (agents end stopped, resumable) and main hears nothing about it.
	pi.on("session_shutdown", async (_event, ctx) => {
		closing = true;
		const sessionId = ctx.sessionManager.getSessionId();
		await scripts.stopAll(sessionId);
		disconnect?.(); // an old session's script end must never reach a later session
		disconnect = undefined;
		registry.abortQueuedOf(sessionId);
		await registry.stopAll(
			registry
				.list(sessionId)
				.filter((r) => r.status === "running")
				.map((r) => r.id),
		);
	});

	pi.on("session_start", async (_event, ctx) => {
		closing = false;
		track(_event, ctx);
		try {
			config = readConfig((pi.getSettings() as { subagent?: unknown }).subagent);
		} catch (err) {
			if (ctx.hasUI) ctx.ui.notify(`subagent: ${(err as Error).message}`, "error");
			throw err;
		}
		let cliWarnings: string[];
		try {
			const flag = pi.getFlag("agents");
			cliWarnings = setCliAgents(typeof flag === "string" ? flag : undefined, ctx.cwd);
		} catch (err) {
			if (ctx.hasUI) ctx.ui.notify(`subagent: ${(err as Error).message}`, "error");
			throw err;
		}
		limitConcurrency(config.maxConcurrent);
		disconnect?.();
		disconnect = scripts.connect({
			sessionId: () => current?.sessionManager.getSessionId(),
			enabled: () => config?.backgroundScripts !== false && current?.hasUI === true,
			deliver,
			parent: () => ({
				sessionFile: current!.sessionManager.getSessionFile(),
				sessionId: current!.sessionManager.getSessionId(),
			}),
		});
		bindHost({
			config: () => config!,
			// Main running: the note steers it (no new turn). Main idle: it is stored, and no turn starts.
			note: (content) =>
				!closing &&
				pi.sendMessage(
					{ customType: "subagent", content, display: true },
					current!.isIdle() ? undefined : { deliverAs: "steer" },
				),
		});
		const warnings = [...cliWarnings, ...registry.rebuild(parentContext(ctx)), ...registerWorkflows(ctx)];
		const discovery = discoverAgents(ctx.cwd);
		const forkable = config.fork && ctx.sessionManager.getSessionFile() !== undefined;
		const agent = agentTool(
			() => config!,
			describeAgents(discovery, config.backgroundScripts, ctx.hasUI, forkable),
			deliver,
		);
		subtask = (task, cctx) => runSubtask(agent, task, cctx);
		pi.registerTool(agent);
		pi.registerTool(sendMessageTool(agent));
		if (ctx.hasUI) {
			installPanel(
				() => current!,
				config,
				(script) => {
					void saveScriptAsWorkflow(current!, script).then((path) => {
						// A new workflow is a command and in the Workflow tool's list at once.
						if (path)
							for (const w of registerWorkflows(current!)) current!.ui.notify(`subagent: ${w}`, "warning");
					});
				},
			);
			for (const warning of [...warnings, ...discovery.warnings]) ctx.ui.notify(`subagent: ${warning}`, "warning");
		}
	});
}
