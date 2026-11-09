// Ticket v2-05: the subagent panel in real interactive pi (pty + headless xterm), parent and subagents on real haiku.
import assert from "node:assert/strict";
import { test } from "node:test";
import { withPi } from "./harness.ts";

// Row text only the panel draws (the transcript shows the script with quotes around the descriptions).
const ONE = "general-purpose(sleepy one)";
const TWO = "general-purpose(sleepy two)";

const SCRIPT = `Use the codemode tool. Script:
const [x, y] = await Promise.all([
  tools.Agent({ description: "sleepy one", prompt: "Run the bash command 'sleep 9' using a tool, then reply OK.", subagent_type: "general-purpose" }),
  tools.Agent({ description: "sleepy two", prompt: "Run the bash command 'sleep 22' using a tool, then reply OK.", subagent_type: "general-purpose" }),
]);
return [x.status, y.status];`;

test("the panel lists both running subagents, updates them, takes focus, and drops finished rows after the linger", async () => {
	await withPi({ lingerMs: 4000 }, async (pi) => {
		await pi.waitFor("claude-haiku");
		pi.submit(SCRIPT);

		// both rows appear while the script runs
		const screen = await pi.waitFor(
			(s) => s.includes(`● running · ${ONE}`) && s.includes(`● running · ${TWO}`),
			90_000,
		);
		assert.match(screen, /Subagents \(2\)/);

		// a row updates: turns and last tool
		await pi.waitFor((s) => /running · general-purpose\(sleepy one\) · [1-9]\d* turns · bash/.test(s), 60_000);

		// ↓ on the empty editor focuses the panel; the first row is selected and the hint shows. Kitty-protocol terminals
		// follow every press with a release (CSI 1;1:3B), which must not move the selection on to the second row.
		pi.press("down"); // the script row comes first
		pi.type("\x1b[1;1:3B");
		pi.press("down");
		pi.type("\x1b[1;1:3B");
		let v = await pi.waitFor("esc back to editor");
		await new Promise((r) => setTimeout(r, 300)); // let a wrongly handled release redraw before checking
		v = pi.viewport();
		assert.match(v, /▸ .*sleepy one/);
		pi.press("down");
		v = await pi.waitFor((s) => /▸ .*sleepy two/.test(s));
		pi.press("up", "up", "up"); // second -> first -> the script row -> above the first: back to the editor
		await pi.waitGone("esc back to editor");

		// a key the panel does not use goes to the editor and gives the focus back
		pi.press("down");
		await pi.waitFor("esc back to editor");
		pi.type("q");
		await pi.waitGone("esc back to editor");
		await pi.waitFor((s) => /^q\s*$/m.test(s));
		pi.type("\x7f"); // erase it again

		// the short job finishes first: marked completed, then dropped after the linger while the other still runs
		await pi.waitFor(`✓ completed · ${ONE}`, 60_000);
		await pi.waitFor(
			(s) => !s.includes(`completed · ${ONE}`) && s.includes(`● running · ${TWO}`) && /Subagents \(1\)/.test(s),
			20_000,
		);

		// the other one finishes, lingers, and the panel hides
		await pi.waitFor(`✓ completed · ${TWO}`, 60_000);
		await pi.waitGone("Subagents (", 20_000);
	});
});
