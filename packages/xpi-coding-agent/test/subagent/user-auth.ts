// The by-hand suites (real, tui, evals, stress, cache) run on a copy of the user's auth.json in a temp agent dir.
// A copy that refreshes an OAuth token makes the provider rotate the refresh token: the copy gets the new one, and the
// user's own file is left with a refresh token that no longer works. So a copy is made only while the token is far
// from its expiry, and a run never has a reason to refresh.
import { copyFileSync, existsSync, readFileSync } from "node:fs";

const MARGIN_MS = 30 * 60_000;

/** Copy the user's auth.json to `to`. Throws when the file is missing or its Anthropic OAuth token expires soon. */
export function copyUserAuth(from: string, to: string, now = Date.now()): void {
	if (!existsSync(from)) throw new Error(`real-model runs need credentials at ${from}`);
	let anthropic: { type?: string; expires?: number } | undefined;
	try {
		anthropic = JSON.parse(readFileSync(from, "utf8")).anthropic;
	} catch {
		// not JSON: the child reports it
	}
	if (anthropic?.type === "oauth" && typeof anthropic.expires === "number" && anthropic.expires - now < MARGIN_MS) {
		const when = anthropic.expires < now ? "has expired" : "expires within 30 minutes";
		throw new Error(
			`the Anthropic OAuth token in ${from} ${when}. A copy that refreshes it would leave that file with a dead ` +
				"refresh token. Send one message in xpi (it refreshes the file), then run this again.",
		);
	}
	copyFileSync(from, to);
}
