import * as fs from "node:fs";
import { APP_NAME } from "../config.ts";
import type { SessionManager } from "../core/session-manager.ts";

export function quoteIfNeeded(value: string): string {
	if (value.length > 0 && !/[^a-zA-Z0-9_\-./~:@]/.test(value)) {
		return value;
	}
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The command that opens this session again, or undefined (not a terminal, a session that is not saved). Shared by
 * the interactive mode's exit line and builtin:roost's stale-build notice, so neither imports the other.
 */
export type ResumableSession = Pick<
	SessionManager,
	"isPersisted" | "getSessionFile" | "usesDefaultSessionDir" | "getSessionDir" | "getSessionId"
>;

export function formatResumeCommand(sessionManager: ResumableSession): string | undefined {
	if (!process.stdout.isTTY) return undefined;
	if (!sessionManager.isPersisted()) return undefined;

	const sessionFile = sessionManager.getSessionFile();
	if (!sessionFile || !fs.existsSync(sessionFile)) return undefined;

	const args = [APP_NAME];
	if (!sessionManager.usesDefaultSessionDir()) {
		args.push("--session-dir", quoteIfNeeded(sessionManager.getSessionDir()));
	}
	args.push("--session", sessionManager.getSessionId());
	return args.join(" ");
}
