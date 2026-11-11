/**
 * What `/bg` and `/bg-fork` (foreground.ts) load when they are used: the daemon connection and the dispatch request
 * for this conversation's session file or a copy of it.
 */

import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { buildLaunch, DaemonClient, DaemonError, fallbackName, messageText, requestOnce } from "xpi-roost";
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

/** The client a hand-off talks to: `connectRoost` or a test's fake. */
export type HandoffClient = Pick<DaemonClient, "request" | "close" | "isClosed">;

/**
 * What became of a hand-off dispatch:
 * - `started`: the daemon runs the session (its answer, or the list shows a running job on the file);
 * - `refused`: the daemon answered no: nothing runs, the file is free again;
 * - `absent`: no answer, and the list shows nothing running on the file: nothing runs;
 * - `unknown`: no answer and no list: a worker may be writing the file.
 */
export type HandoffOutcome =
	| { kind: "started"; id: string; name?: string }
	| { kind: "refused"; message: string }
	| { kind: "absent"; message: string }
	| { kind: "unknown"; message: string };

const samePath = (a: string, b: string) => resolveReal(a) === resolveReal(b);
function resolveReal(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		// the file may not exist yet (xpi writes lazily): its folder does
		try {
			return join(realpathSync(dirname(p)), basename(p));
		} catch {
			return resolve(p);
		}
	}
}

/**
 * Sends a hand-off's dispatch once (M51 request ids, as `xpi --bg`), and when its answer is lost asks the daemon's list
 * whether a worker runs on the session file before anyone falls back to it: two writers must never share the file.
 */
export async function dispatchHandoff(
	connect: () => Promise<HandoffClient>,
	request: ReturnType<typeof handoffRequest>,
	timeoutMs?: number,
): Promise<HandoffOutcome> {
	let client: HandoffClient | undefined;
	const via = async () => {
		if (client && !client.isClosed) return client;
		client?.close();
		client = await connect();
		return client;
	};
	try {
		try {
			const { id, name } = await requestOnce(via as () => Promise<DaemonClient>, "dispatch", request, {
				tag: request.origin,
				...(timeoutMs !== undefined ? { timeoutMs } : {}),
			});
			return { kind: "started", id, name };
		} catch (err) {
			const message = (err as Error).message;
			if (err instanceof DaemonError && err.fromDaemon) return { kind: "refused", message };
			if (!(err instanceof DaemonError && err.code === "lost")) return { kind: "absent", message };
			try {
				const { jobs } = await (await via()).request("list", { all: true });
				const job = jobs.find((j) => j.endedAt === null && samePath(j.sessionFile, request.sessionFile));
				return job ? { kind: "started", id: job.id, name: job.name } : { kind: "absent", message };
			} catch {
				return { kind: "unknown", message };
			}
		}
	} finally {
		client?.close();
	}
}
