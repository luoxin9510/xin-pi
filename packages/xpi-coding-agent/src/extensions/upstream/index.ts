// upstream extension entry: the `/upstream` command. It gathers upstream facts into a data file and injects a prompt
// into the main agent, which writes the comparison report. Read-only by instruction.

import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir, VERSION } from "../../config.ts";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { type FetchFn, gather } from "./data.ts";
import { buildPrompt } from "./prompt.ts";

export const DEFAULT_SOURCE_DIR = "~/Developer/xin-pi";

export function expandHome(p: string): string {
	return p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

/** The `upstream` settings block. A boundary: wrong types throw, naming the key. */
export function readSourceDir(raw: unknown): string {
	if (raw === undefined) return expandHome(DEFAULT_SOURCE_DIR);
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new Error("upstream settings must be an object");
	}
	const dir = (raw as Record<string, unknown>).sourceDir;
	if (dir === undefined) return expandHome(DEFAULT_SOURCE_DIR);
	if (typeof dir !== "string" || dir === "") throw new Error("upstream.sourceDir must be a non-empty string");
	return expandHome(dir);
}

export interface UpstreamTestHooks {
	fetch?: FetchFn;
	agentDir?: string;
	version?: string;
	now?: Date;
}

export function createUpstreamExtension(hooks: UpstreamTestHooks = {}) {
	return function upstream(pi: ExtensionAPI) {
		// Subagent children are workers: they never get the command.
		if (process.env.XPI_SUBAGENT_DEPTH) return;
		pi.registerCommand("upstream", {
			description: "Compare upstream pi with xin-pi and write a report of what to port, adapt or skip",
			handler: async (_args, ctx) => {
				const notify = (m: string, level: "info" | "warning" | "error" = "info") => {
					if (ctx.hasUI) ctx.ui.notify(m, level);
				};
				try {
					const sourceDir = readSourceDir((pi.getSettings() as { upstream?: unknown }).upstream);
					const result = await gather({
						sourceDir,
						agentDir: hooks.agentDir ?? getAgentDir(),
						version: hooks.version ?? VERSION,
						fetch: hooks.fetch,
						now: hooks.now,
					});
					notify(`upstream: ${result.summary}. Data: ${result.dataPath}`);
					for (const n of result.notes) notify(`upstream: ${n}`, "warning");
					// Idle: this starts a turn. Busy: it steers the running one.
					pi.sendUserMessage(buildPrompt(result), { deliverAs: "steer" });
				} catch (err) {
					notify(`upstream: ${(err as Error).message}`, "error");
				}
			},
		});
	};
}

export default createUpstreamExtension();
