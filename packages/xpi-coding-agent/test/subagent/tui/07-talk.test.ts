// Ticket v2-07: typing on a subagent screen, in real interactive pi (pty + headless xterm), on real haiku.
// The replies are tokens the typed text only spells out in pieces, so a match on screen is the subagent's own answer.
import assert from "node:assert/strict";
import { test } from "node:test";
import { withPi } from "./harness.ts";

const script = (prompt: string) => `Use the codemode tool. Script:
const r = await tools.Agent({ description: "talk probe", prompt: ${JSON.stringify(prompt)}, subagent_type: "general-purpose" });
return r.status;
After the script finishes, reply with the text RESULT: and the status it returned.`;

const HEAD = /main › general-purpose\(talk probe\)/;

test("typing to a running subagent steers it: its reply shows on the screen, and main gets the note", async () => {
	await withPi({}, async (pi) => {
		await pi.waitFor("claude-haiku");
		pi.submit(
			script("Run the bash command 'sleep 12' with the codemode tool, then reply with the single word DONE."),
		);
		await pi.waitFor("● running · general-purpose(talk probe)", 90_000);
		pi.press("down", "down", "enter"); // the script row comes first
		await pi.waitFor((s) => HEAD.test(s) && s.includes("main: running"));

		pi.submit(
			"STOP. Run nothing else. Your final message must be exactly the word made of TOKEN, a hyphen and xyz, and nothing more.",
		);
		await pi.waitFor("sent: the subagent gets it", 20_000);
		await pi.waitFor("TOKEN-xyz", 90_000); // the subagent's reply, on its screen

		pi.press("esc");
		await pi.waitGone("main ›");
		// the note steered main, which may answer it instead of the script's status: only the note is checked
		const v = await pi.waitFor(/It replied: TOKEN-xyz/, 90_000);
		assert.match(v, /User said to general-purpose\(/);
	});
});

test("typing to a finished subagent continues it: the answer streams onto the screen, the note waits in idle main", async () => {
	await withPi({ lingerMs: 1000 }, async (pi) => {
		await pi.waitFor("claude-haiku");
		pi.submit(script("Reply with the single word OK. Do not call any tool."));
		await pi.waitFor(/RESULT: completed/, 120_000);

		pi.submit("/subagents");
		await pi.waitFor("enter select");
		pi.press("enter");
		await pi.waitFor((s) => HEAD.test(s) && s.includes("main: idle"), 20_000);

		pi.submit("What is 17 times 23? Reply with only the number, no tool.");
		const v = await pi.waitFor(/391/, 90_000); // only the answer has it: the question does not
		assert.match(v, /17 times 23/, "the user's message is on the screen too");

		pi.submit("/main");
		await pi.waitGone("main ›");
		await pi.waitFor(/It replied:[^\n]*391/, 30_000); // haiku sometimes answers "17 × 23 = 391"
		assert.doesNotMatch(pi.viewport(), /Working/, "an idle main did not start a turn for the note");
	});
});
