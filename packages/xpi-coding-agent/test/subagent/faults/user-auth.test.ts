// The credential copy of the by-hand suites: never copy an OAuth token that the copy would have to refresh.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { copyUserAuth } from "../user-auth.ts";

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

function files(auth: unknown) {
	const dir = mkdtempSync(join(tmpdir(), "subagent-auth-"));
	const from = join(dir, "auth.json");
	if (auth !== undefined) writeFileSync(from, typeof auth === "string" ? auth : JSON.stringify(auth));
	return { from, to: join(dir, "copy.json") };
}
const oauth = (expires: number) => ({ anthropic: { type: "oauth", refresh: "r", access: "a", expires } });

test("a token far from its expiry, an API key, and a file that is not JSON are copied as they are", () => {
	for (const auth of [oauth(NOW + 31 * MINUTE), { anthropic: { type: "api_key", key: "k" } }, { other: {} }, "{"]) {
		const { from, to } = files(auth);
		copyUserAuth(from, to, NOW);
		assert.equal(readFileSync(to, "utf8"), readFileSync(from, "utf8"));
	}
});

test("an expired token and one that expires within 30 minutes are not copied; the error says what to do", () => {
	for (const [expires, words] of [
		[NOW - MINUTE, /has expired/],
		[NOW + 29 * MINUTE, /expires within 30 minutes/],
	] as const) {
		const { from, to } = files(oauth(expires));
		assert.throws(() => copyUserAuth(from, to, NOW), words);
		assert.throws(() => copyUserAuth(from, to, NOW), /Send one message in xpi/);
		assert.equal(existsSync(to), false);
	}
});

test("a missing file is an error naming the path", () => {
	const { from, to } = files(undefined);
	assert.throws(() => copyUserAuth(from, to, NOW), new RegExp(from.replace(/[.\\/]/g, "\\$&")));
});
