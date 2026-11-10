// subagent extension entry: register the `Agent` tool for codemode scripts.

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../../core/extensions/types.ts";
import { isStdoutTakenOver, writeRawStdout } from "../../core/output-guard.ts";
import { BUILTIN_SLASH_COMMANDS } from "../../core/slash-commands.ts";
import { codemodeAddons } from "../codemode/addons.ts";
import { createCodemodeExtension } from "../codemode/index.ts";
import { agentTool, describeAgents, parentContext } from "./agent-tool.ts";
import { scripts } from "./background.ts";
import { type Config, readConfig } from "./config.ts";
import { discoverAgents } from "./discovery.ts";
import { bindHost, limitConcurrency } from "./exchange.ts";
import { installPanel } from "./panel.ts";
import { registry } from "./registry.ts";
import { scriptHelpers } from "./script-helpers.ts";
import { registerStructuredOutput } from "./structured-output.ts";
import { subagentsCommand } from "./subagents-command.ts";
import { startWorkflow, workflowStartText } from "./workflow-run.ts";
import { discoverWorkflows, parseArgs } from "./workflows.ts";

export default function subagent(pi: ExtensionAPI) {
	// Children run with XPI_SUBAGENT_DEPTH=1. Nesting is fixed at one level, so they get no Agent tool. A codemode-only child
	// gets `codemode` in mode "only" here, which replaces pi's built-in codemode extension.
	if (process.env.XPI_SUBAGENT_DEPTH) {
		if (process.env.XPI_SUBAGENT_CHILD_CODEMODE === "only") createCodemodeExtension({ mode: "only" })(pi);
		registerStructuredOutput(pi); // only when the call passed a schema
		return;
	}
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
	const runWorkflowCommand = async (name: string, text: string, ctx: ExtensionCommandContext) => {
		const workflow = discoverWorkflows(ctx.cwd, ctx.isProjectTrusted()).workflows.get(name);
		if (!workflow) {
			const message = `workflow ${name} is not available here (removed, or a project workflow in an untrusted project)`;
			if (ctx.hasUI) ctx.ui.notify(message, "error");
			else process.stderr.write(`${message}\n`);
			return;
		}
		const background = config?.backgroundScripts !== false && ctx.hasUI;
		const start = await startWorkflow(ctx, workflow, parseArgs(text), background);
		if (start.background) {
			ctx.ui.notify(workflowStartText(name, start.scriptId), "info");
			return;
		}
		const output = start.result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
		if (ctx.hasUI) deliver(`Workflow ${name} ${start.result.isError ? "failed" : "completed"}.\n${output}`);
		// Print mode keeps stdout for the answer and moves other writes to stderr; the workflow's result is the answer.
		else if (isStdoutTakenOver()) writeRawStdout(`${output}\n`);
		else process.stdout.write(`${output}\n`);
	};
	const registerWorkflows = (ctx: ExtensionContext): string[] => {
		const { workflows, warnings } = discoverWorkflows(ctx.cwd, ctx.isProjectTrusted());
		const taken = new Set([
			...BUILTIN_SLASH_COMMANDS.map((c) => c.name),
			...pi
				.getCommands()
				.map((c) => c.name)
				.filter((n) => !workflowCommands.has(n)),
		]);
		for (const { meta, path } of workflows.values()) {
			if (taken.has(meta.name)) {
				warnings.push(`workflow ${path} skipped: /${meta.name} is already a command`);
				continue;
			}
			if (workflowCommands.has(meta.name)) continue;
			workflowCommands.add(meta.name);
			pi.registerCommand(meta.name, {
				description: `${meta.description} (workflow)`,
				handler: (args, cctx) => runWorkflowCommand(meta.name, args, cctx),
			});
		}
		return warnings;
	};

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
		const warnings = [...registry.rebuild(parentContext(ctx)), ...registerWorkflows(ctx)];
		const discovery = discoverAgents(ctx.cwd);
		pi.registerTool(
			agentTool(() => config!, describeAgents(discovery, config.backgroundScripts, ctx.hasUI), deliver),
		);
		if (ctx.hasUI) {
			installPanel(() => current!, config);
			for (const warning of [...warnings, ...discovery.warnings]) ctx.ui.notify(`subagent: ${warning}`, "warning");
		}
	});
}
