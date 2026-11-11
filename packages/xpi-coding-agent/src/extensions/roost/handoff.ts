/**
 * What `/bg` and `/bg-fork` (foreground.ts) load when they are used: the daemon connection and the dispatch request
 * for this conversation's session file or a copy of it.
 */

import { buildLaunch, DaemonClient, fallbackName, messageText } from "xpi-roost";
import { getAgentDir, VERSION } from "../../config.ts";
import type { ExtensionContext } from "../../core/extensions/types.ts";
import { sessionTrust } from "./background.ts";
import { roostStart } from "./hub-options.ts";
import { launchSettings } from "./settings.ts";

export const connectRoost = (): Promise<DaemonClient> => DaemonClient.connectOrStart(roostStart(getAgentDir()));

/** DI-9 fallback for an unnamed conversation: its first user message. */
export function conversationName(ctx: ExtensionContext): string {
	const named = ctx.sessionManager.getSessionName();
	if (named) return named;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const text = messageText(entry.message as { content?: unknown });
		if (text.trim()) return fallbackName(text);
	}
	return "conversation";
}

export interface HandoffInput {
	task: string;
	sessionFile: string;
	name: string;
	origin: "adopt" | "fork";
	/** M8: the model and thinking level this xpi runs now (a session file does not always record them). */
	model?: string;
	thinking?: string;
	/** This xpi's answer about the project folder (undefined: none); `sessionTrust` decides what the session gets. */
	trusted?: boolean;
}

/** The daemon's dispatch request for a session file this xpi hands over. */
export function handoffRequest(ctx: ExtensionContext, o: HandoffInput) {
	const settings = launchSettings(ctx.cwd, o.trusted ?? false);
	// the same rule as `xpi --bg`: only a decision somebody made goes with the session, otherwise --no-approve
	const trusted = sessionTrust(ctx.cwd, process.argv.slice(2), o.trusted, getAgentDir());
	return buildLaunch({
		task: o.task,
		cwd: ctx.cwd,
		sessionFile: o.sessionFile,
		name: o.name,
		origin: o.origin,
		argv: process.argv,
		execPath: process.execPath,
		env: process.env,
		trusted,
		...settings.env,
		piVersion: VERSION,
		...(o.model ? { model: o.model } : {}),
		...(o.thinking ? { thinking: o.thinking } : {}),
	});
}
