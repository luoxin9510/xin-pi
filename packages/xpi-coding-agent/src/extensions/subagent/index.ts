// subagent extension entry: register the `Agent` tool for codemode scripts.

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../../core/extensions/types.ts";
import { isStdoutTakenOver, writeRawStdout } from "../../core/output-guard.ts";
import { BUILTIN_SLASH_COMMANDS } from "../../core/slash-commands.ts";
import { codemodeAddons } from "../codemode/addons.ts";
import { createCodemodeExtension } from "../codemode/index.ts";
import { agentTool, describeAgents, parentContext } from "./agent-tool.ts";
import { scripts } from "./background.ts";
import { type Config, readConfig } from "./config.ts";
import { discoverAgents, parseCliAgents, setCliAgents } from "./discovery.ts";
import { bindHost, limitConcurrency } from "./exchange.ts";
import { installPanel } from "./panel.ts";
import { registry } from "./registry.ts";
import { setBuiltinMcp } from "./resolve.ts";
import type { Run } from "./runs.ts";
import { scriptHelpers } from "./script-helpers.ts";
import { sendMessageTool } from "./send-message-tool.ts";
import { registerStructuredOutput } from "./structured-output.ts";
import { subagentsCommand } from "./subagents-command.ts";
import { continueAgent } from "./talk.ts";
import { teams } from "./team.ts";
import { readTeamSettings, teamsAllowed } from "./team-config.ts";
import { registerTeamTools } from "./team-send.ts";
import { LEAD_PROMPT } from "./team-text.ts";
import { checkStalls, runningLine, statusText } from "./waiting.ts";
import { startWorkflowCommand, workflowStartText } from "./workflow-run.ts";
import { saveScriptAsWorkflow } from "./workflow-save.ts";
import { describeWorkflows, runToRelaunch, workflowTool } from "./workflow-tool.ts";
import { discoverWorkflows, parseArgs, type Workflow } from "./workflows.ts";
import { workflowsCommand } from "./workflows-command.ts";

// How often running agents are checked for stalls (spec 09).
const STALL_CHECK_MS = 30_000;

// A message for the user: a notification with a UI, a line on stderr without one (print mode), where it does not mix
// with the answer on stdout.
function tell(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
	if (ctx.hasUI) ctx.ui.notify(message, level);
	else process.stderr.write(`${message}\n`);
}

export default function subagent(pi: ExtensionAPI) {
	// Children run with XPI_SUBAGENT_DEPTH=1. Nesting is fixed at one level, so they get no Agent tool. A codemode-only child
	// gets `codemode` in mode "only" here, which replaces pi's built-in codemode extension.
	if (process.env.XPI_SUBAGENT_DEPTH) {
		if (process.env.XPI_SUBAGENT_CHILD_CODEMODE === "only") createCodemodeExtension({ mode: "only" })(pi);
		registerStructuredOutput(pi); // only when the call passed a schema
		registerTeamTools(pi); // only for a teammate (XPI_TEAM_DIR): SendMessage to its team
		return;
	}
	pi.registerFlag("agents", {
		type: "string",
		description:
			'Subagents for this run: a JSON object {"<name>": {"description", "prompt", ...agent-file fields}} or the path of a JSON file. They rank above agent files.',
		// JSON or a file that does not parse stops the start.
		validate: (value, cwd) => {
			if (value.trim() !== "") parseCliAgents(value, cwd);
			return undefined;
		},
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
	// The stall timer and the `subagents` status of the current session (spec 09); stopped, and the status cleared, when
	// the session ends.
	let unwatch: (() => void) | undefined;
	const watch = (ctx: ExtensionContext) => {
		unwatch?.();
		const sessionId = ctx.sessionManager.getSessionId();
		const timer = setInterval(() => {
			checkStalls(sessionId, config!.stallMs, (m) => tell(current!, m, "warning"));
		}, STALL_CHECK_MS);
		timer.unref();
		let shown: string | undefined;
		const publish = () => {
			const text = statusText(sessionId);
			if (text === shown) return;
			shown = text;
			current?.ui.setStatus("subagents", text);
		};
		const offRegistry = registry.subscribe(publish);
		const offScripts = scripts.subscribe(publish);
		publish();
		unwatch = () => {
			clearInterval(timer);
			offRegistry();
			offScripts();
		};
	};

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
			tell(
				ctx,
				`workflow ${name} is not available here (removed, or a project workflow in an untrusted project)`,
				"error",
			);
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
				tell(ctx, `subagent: ${(err as Error).message}`, "error");
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
		const say = (message: string, level: "info" | "error") => tell(ctx, message, level);
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
	// The tool calls a script makes are kept on its record, for the script screen.
	pi.on("tool_execution_start", (event) => scripts.nested(event));
	pi.on("tool_execution_update", (event) => scripts.nested(event));
	pi.on("tool_execution_end", (event) => scripts.nested(event));

	// Quit, reload, /new, resume and fork all emit session_shutdown before the runtime is torn down. Everything of this
	// session still running in the background stops (agents end stopped, resumable) and main hears nothing about it.
	pi.on("session_shutdown", async (_event, ctx) => {
		closing = true;
		teams.beginClose(); // no more deliveries; the running teammates stop with the other subagents below
		const sessionId = ctx.sessionManager.getSessionId();
		unwatch?.();
		unwatch = undefined;
		ctx.ui.setStatus("subagents", undefined);
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
		await teams.finishClose(); // the team's config.json and mailboxes; its tasks stay
	});

	pi.on("session_start", async (_event, ctx) => {
		closing = false;
		track(_event, ctx);
		try {
			const settings = pi.getSettings() as { subagent?: unknown; models?: unknown };
			config = readConfig(settings.subagent, settings.models);
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
		let teamSettings: ReturnType<typeof readTeamSettings>;
		try {
			teamSettings = readTeamSettings((pi.getSettings() as { agentTeams?: unknown }).agentTeams);
		} catch (err) {
			if (ctx.hasUI) ctx.ui.notify(`subagent: ${(err as Error).message}`, "error");
			throw err;
		}
		// Teams are decided here and fixed until /reload: the lead's tools and prompt section are set up now.
		const teamsOn =
			teamSettings.enabled && teamsAllowed({ mode: ctx.mode, sessionFile: ctx.sessionManager.getSessionFile() });
		teams.configure(
			teamsOn
				? {
						settings: teamSettings,
						parent: () => parentContext(current!),
						// A custom message with triggerTurn: a steer while the lead is in a turn, a new turn when it is idle.
						toLead: (content) => {
							if (closing) return false;
							pi.sendMessage(
								{ customType: "subagent", content, display: true },
								{ triggerTurn: true, deliverAs: "steer" },
							);
							return true;
						},
						warn: (message) => tell(current!, `subagent: ${message}`, "warning"),
						wake: (member, prompt, signal) => {
							const record = registry.get(member.agentId);
							if (!record) throw new Error(`no record of agent ${member.agentId}`);
							return continueAgent(parentContext(current!), record, prompt, undefined, signal);
						},
					}
				: undefined,
		);
		setBuiltinMcp(pi.getCommands().some((c) => c.name === "mcp" && c.sourceInfo?.path === "builtin:mcp"));
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
			describeAgents(discovery, config.backgroundScripts, ctx.hasUI, forkable, teamsOn),
			deliver,
			teamsOn,
		);
		subtask = (task, cctx) => runSubtask(agent, task, cctx);
		pi.registerTool(agent);
		pi.registerTool(sendMessageTool(agent, teamsOn));
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
		}
		watch(ctx);
		for (const warning of [...warnings, ...discovery.warnings]) tell(ctx, `subagent: ${warning}`, "warning");
	});

	// A user message that starts a turn while a group runs: one line after it naming the agents still running, so main
	// knows without a tool call. A custom message, so the cached prefix is unchanged. Not on steers or follow-ups (they
	// start no run) or on custom messages, such as a group's own message.
	pi.on("before_agent_start", (event, ctx) => {
		// While teams are on, the lead's prompt says how they work (a section, the same every turn).
		if (teams.on) event.systemPromptOptions.sections["agent-teams"] = LEAD_PROMPT;
		if (event.messageType !== "user") return undefined;
		const line = runningLine(ctx.sessionManager.getSessionId());
		return line ? { message: { customType: "subagent-status", content: line, display: false } } : undefined;
	});
}
