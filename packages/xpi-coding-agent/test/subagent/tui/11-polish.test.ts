// v3b ticket 04 in real interactive pi (pty + headless xterm), on real haiku: coloured rows, model and effort on the
// screen, and shift+x stopping every running agent.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { withPi } from "./harness.ts";

const CYAN = 51; // src/color.ts

const SCRIPT = `Use the codemode tool. Script:
const [x, y] = await Promise.all([
  tools.Agent({ description: "slow one", prompt: "Run the bash command 'sleep 60' using a tool, then reply OK.", subagent_type: "tinted" }),
  tools.Agent({ description: "slow two", prompt: "Run the bash command 'sleep 60' using a tool, then reply OK.", subagent_type: "tinted" }),
]);
return "chk:" + [x.status, y.status].join(",");`;

test("coloured rows, model and effort on the screen, and shift+x stops every running agent", async () => {
	// 160 columns: with "main: running" the screen's header is longer than 120 and loses the effort at its end.
	await withPi({ lingerMs: 30000, cols: 160 }, async (pi) => {
		mkdirSync(join(pi.repo, ".pi", "agents"), { recursive: true });
		writeFileSync(
			join(pi.repo, ".pi", "agents", "tinted.md"),
			"---\nname: tinted\ndescription: A tinted agent\ncolor: cyan\ntools: Bash\n---\nYou run what you are told.\n",
		);
		await pi.waitFor("claude-haiku");
		pi.submit(SCRIPT);
		await pi.waitFor(
			(s) =>
				/running · tinted\(slow one\) · [1-9]\d* turns · bash/.test(s) &&
				/running · tinted\(slow two\) · [1-9]\d* turns · bash/.test(s),
			90_000,
		);

		// the label carries the agent's colour; the status icon and text keep the status colour
		assert.equal(pi.fgOf("tinted(slow one)"), CYAN);
		assert.notEqual(pi.fgOf("running"), CYAN);
		assert.notEqual(pi.fgOf("●"), CYAN);

		// the screen: tinted label, model and effort in the header, and the hint
		pi.press("down", "down", "enter");
		await pi.waitFor((s) => /main › tinted\(slow one\)/.test(s));
		const head = pi
			.viewport()
			.split("\n")
			.find((l) => l.includes("main › tinted(slow one)"))!;
		assert.match(head, /tinted\(slow one\) .* turns · anthropic\/claude-haiku-5-5 · low/);
		assert.equal(pi.fgOf("tinted(slow one)"), CYAN);
		pi.press("esc");
		await pi.waitFor((s) => !s.includes("main › tinted"));

		// shift+x with the panel focused stops everything
		pi.press("down");
		await pi.waitFor("X stop all");
		pi.type("X");
		await pi.waitFor(
			(s) => s.includes("■ stopped · tinted(slow one)") && s.includes("■ stopped · tinted(slow two)"),
			30_000,
		);
		await pi.waitFor("Background script S1 stopped", 30_000); // the script goes with its agents
	});
});
