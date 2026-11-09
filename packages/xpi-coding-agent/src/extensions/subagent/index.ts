// subagent extension entry: register the `Agent` tool for codemode scripts.

import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { createCodemodeExtension } from "../codemode/index.ts";
import { agentTool, describeAgents, parentContext } from "./agent-tool.ts";
import { installBackground, scripts } from "./background.ts";
import { type Config, readConfig } from "./config.ts";
import { discoverAgents } from "./discovery.ts";
import { bindHost, limitConcurrency } from "./exchange.ts";
import { installPanel } from "./panel.ts";
import { registry } from "./registry.ts";
import { subagentsCommand } from "./subagents-command.ts";

export default function subagent(pi: ExtensionAPI) {
	// Children run with XPI_SUBAGENT_DEPTH=1. Nesting is fixed at one level, so they get no Agent tool. A codemode-only child
	// gets `codemode` in mode "only" here, which replaces pi's built-in codemode extension.
	if (process.env.XPI_SUBAGENT_DEPTH) {
		if (process.env.XPI_SUBAGENT_CHILD_CODEMODE === "only") createCodemodeExtension({ mode: "only" })(pi);
		return;
	}

	let config: Config | undefined;
	// The context of the latest event: a session start (also after /new or a resume) or an agent run. Note delivery and
	// the screens read main's state through it, never through an older context.
	let current: ExtensionContext | undefined;
	const track = (_event: unknown, ctx: ExtensionContext) => {
		current = ctx;
	};

	// Wraps codemode so a script that starts an Agent moves to the background (unless subagent.backgroundScripts is false).
	// Delivery to main: a steer when it runs, else a turn starts.
	let closing = false; // the session is ending: its stops send nothing to main
	// pi routes `triggerTurn` + `steer` itself: streaming -> steer, otherwise (idle, compacting) a run starts.
	const deliver = (content: string) =>
		!closing &&
		pi.sendMessage({ customType: "subagent", content, display: true }, { triggerTurn: true, deliverAs: "steer" });
	installBackground(pi, deliver, () => config?.backgroundScripts !== false);

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
		const warnings = registry.rebuild(parentContext(ctx));
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
