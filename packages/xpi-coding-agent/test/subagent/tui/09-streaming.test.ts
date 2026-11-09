// Review fix Q2: the subagent screen streams the child's reply while it is being written, on real pi and real haiku.
import assert from "node:assert/strict";
import { test } from "node:test";
import { withPi } from "./harness.ts";

// A long reply with no tool use: the numbered lines arrive over several seconds.
const SCRIPT = `Use the codemode tool. Script:
const r = await tools.Agent({ description: "stream probe", prompt: "Do not use any tool. Reply with 150 lines. Line N is exactly: ROW-NNN followed by a space and the number N spelled in English words (NNN is N zero-padded to three digits). Nothing before or after the lines.", subagent_type: "general-purpose" });
return r.status;
After the script finishes, reply with the text RESULT: and the status it returned.`;

test("the reply appears on the screen while the subagent is still writing it, and the screen ends up complete", async () => {
	await withPi({ rows: 30 }, async (pi) => {
		await pi.waitFor("claude-haiku");
		pi.submit(SCRIPT);
		await pi.waitFor("● running · general-purpose(stream probe)", 90_000);
		pi.press("down", "down", "enter"); // the script row comes first
		await pi.waitFor(/main › general-purpose\(stream probe\)/);

		// some rows are on screen, the last is not, and the subagent is still running: text arrived before the message ended
		const partial = await pi.waitFor(
			(s) => /ROW-0[3-9]\d/.test(s) && !s.includes("ROW-150") && s.includes("● running"),
			90_000,
		);
		assert.doesNotMatch(partial, /ROW-150/);
		const early = partial.match(/ROW-(\d{3})/g)!;

		await pi.waitFor("ROW-150", 90_000);
		await pi.waitFor("✓ completed", 30_000);
		assert.ok(early.length > 0);
	});
});
