// codemode run_in_background and the script screen, in real interactive pi (pty + headless xterm), real haiku: a background
// script's row says what it runs, Enter opens its screen with the call and its live output, Esc goes back, x stops it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { withPi } from "./harness.ts";

// The marker "tick-" is printed by the command, not spelled out in the script source.
const TICKS = `Use the codemode tool exactly once, with run_in_background set to true and description "slow ticks". Script:
await tools.bash({ command: "for i in 1 2 3 4 5 6 7 8; do echo tick-$i; sleep 5; done" });
return "chk:" + (6 * 7);
If the tool says the script started in the background, reply with the single word started and stop. When the script's result arrives, reply with the single word DONE.`;

test("a background script row names it, Enter opens the script screen with the call and live output, Esc goes back, x stops the script", async () => {
	await withPi({ lingerMs: 60000 }, async (pi) => {
		await pi.waitFor("claude-haiku");
		pi.submit(TICKS);
		const row = await pi.waitFor((s) => /● background · slow ticks \(S1\) · \d+s · bash for i in/.test(s), 90_000);
		assert.ok(!row.includes("agents running"), "a script without agents shows no agent count");

		pi.press("down"); // focus the panel; the script row is selected
		await pi.waitFor((s) => /▸ .*slow ticks \(S1\)/.test(s));
		pi.press("enter");
		const screen = await pi.waitFor(
			(s) => s.includes("x stop the script") && /✓|●/.test(s) && s.includes("Calls (1)"),
			30_000,
		);
		assert.match(screen, /slow ticks \(S1\)/);
		assert.match(screen, /● bash for i in/);
		await pi.waitFor("tick-2", 30_000); // live output
		assert.match(pi.viewport(), /Output of bash for i in/);

		pi.press("esc");
		await pi.waitFor((s) => !s.includes("x stop the script"), 10_000);

		pi.press("down");
		pi.press("enter");
		await pi.waitFor("x stop the script", 10_000);
		pi.type("x");
		await pi.waitFor((s) => /■ stopped/.test(s), 30_000);
		pi.press("esc");
		await pi.waitFor("Background script S1 (slow ticks) stopped", 30_000);
	});
});
