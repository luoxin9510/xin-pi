// Ticket v2-06: the full-screen subagent screen in real interactive pi (pty + headless xterm), on real haiku.
import assert from "node:assert/strict";
import { test } from "node:test";
import { withPi } from "./harness.ts";

// Two bash calls in one subagent, seconds apart, so the screen can be opened between them.
const SCRIPT = `Use the codemode tool. Script:
const r = await tools.Agent({ description: "screen probe", prompt: "Step one: run the bash command 'echo TOKEN-ALPHA; sleep 12'. Step two: run the bash command 'echo TOKEN-BETA'. Then reply OK.", subagent_type: "general-purpose" });
return r.status;
After the script finishes, reply with the text RESULT: and the status it returned.`;

const PANEL_ROW = "● running · general-purpose(screen probe)";
const HEAD = /main › general-purpose\(screen probe\)/;

test("opening a running subagent shows its transcript growing while main runs; main finishes normally after leaving", async () => {
	await withPi({}, async (pi) => {
		await pi.waitFor("claude-haiku");
		pi.submit(SCRIPT);
		await pi.waitFor(PANEL_ROW, 90_000);

		pi.press("down", "down", "enter"); // the script row comes first
		const v = await pi.waitFor((s) => HEAD.test(s) && s.includes("main: running"));
		assert.match(v, /esc or \/main back to main/);

		// the task is there at once; the subagent's script and then its result are added while the screen is open
		assert.doesNotMatch(pi.viewport(), /Script completed/);
		await pi.waitFor(/tools\.bash/, 60_000);
		await pi.waitFor(/Script completed/, 60_000);

		// leave: main's own view is back, and its run completes with its final reply
		pi.press("esc");
		await pi.waitGone("main ›");
		await pi.waitFor(/RESULT: completed/, 90_000);
	});
});

test("a finished subagent shows its full transcript, scrolls to the task, rejects other slash commands, /main leaves", async () => {
	await withPi({ rows: 24, lingerMs: 1000 }, async (pi) => {
		await pi.waitFor("claude-haiku");
		pi.submit(SCRIPT.replace("sleep 12", "sleep 1"));
		await pi.waitFor(/RESULT: completed/, 120_000);

		pi.submit("/subagents");
		await pi.waitFor("enter select");
		pi.press("enter");
		await pi.waitFor((s) => HEAD.test(s) && s.includes("main: idle"), 20_000);
		let v = await pi.waitFor(/Script completed/); // the end of the transcript is in view
		assert.doesNotMatch(v, /Step one: run the bash command/, "the task is above the first screenful");

		// scrolling up reaches the task text; End returns to the live end
		for (let i = 0; i < 6 && !/Step one: run the bash command/.test(pi.viewport()); i++) {
			pi.press("pageUp");
			await new Promise((r) => setTimeout(r, 300));
		}
		v = await pi.waitFor("Step one: run the bash command");
		assert.match(v, /lines above the end/);
		pi.press("end");
		await pi.waitFor((s) => /Script completed/.test(s) && !s.includes("lines above the end"));

		pi.submit("/nonsense");
		await pi.waitFor("/nonsense is not available on a subagent screen");
		assert.match(pi.viewport(), HEAD);

		pi.submit("/main");
		await pi.waitGone("main ›");
	});
});
