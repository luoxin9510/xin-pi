// v3a ticket 04: script rows in the panel, x on a script, ctrl+b, in real interactive pi (pty + headless xterm), real haiku.
import assert from "node:assert/strict";
import { test } from "node:test";
import { withPi } from "./harness.ts";

// The results are "chk:" + computed values, which the script source echoed in the transcript does not spell out.
const AGENT_SCRIPT = `Use the codemode tool exactly once. Script:
const r = await tools.Agent({ description: "panel kid", prompt: "Run the bash command 'sleep 60' using a tool, then reply OK.", subagent_type: "general-purpose" });
return "chk:" + [r.status, r.error].join("|");
If the tool says the script moved to the background, reply with the single word moved and stop.`;

const SLOW_SCRIPT = `Use the codemode tool exactly once. Script:
await tools.bash({ command: "sleep 25" });
return "chk:" + (6 * 7);
If the tool says the script moved to the background, reply with the single word moved and stop. When the script's result arrives, reply with the single word DONE.`;

test("a script with agents shows a script row with its agent indented; x on the script row stops everything and main gets the stopped message", async () => {
	await withPi({ lingerMs: 20000 }, async (pi) => {
		await pi.waitFor("claude-haiku");
		pi.submit(AGENT_SCRIPT);
		const v = await pi.waitFor(
			(s) =>
				/● background · (?:script S1|.+ \(S1\)) · 1 agents running/.test(s) &&
				/running · general-purpose\(panel kid\) · [1-9]\d* turns · bash/.test(s),
			90_000,
		);
		const lines = v.split("\n");
		const script = lines.findIndex((l) => /(script S1|\(S1\)) ·/.test(l));
		const agent = lines.findIndex((l) => l.includes("general-purpose(panel kid) ·"));
		assert.ok(agent === script + 1, "the agent sits right below its script");
		assert.ok(lines[agent]!.search(/\S/) > lines[script]!.search(/\S/), "and is indented");

		pi.press("down");
		await pi.waitFor((s) => /▸ .*● background · (?:script S1|.+ \(S1\))/.test(s));
		pi.type("x");
		await pi.waitFor(/Background script S1 (\([^)]*\) )?stopped/, 30_000);
		await pi.waitFor(
			(s) => /■ stopped · (?:script S1|.+ \(S1\))/.test(s) && /■ stopped · general-purpose\(panel kid\)/.test(s),
			20_000,
		);
	});
});

test("ctrl+b on an empty editor sends a slow foreground script to the background; main's turn ends and the result arrives later", async () => {
	await withPi({ lingerMs: 60000 }, async (pi) => {
		await pi.waitFor("claude-haiku");
		pi.submit(SLOW_SCRIPT);
		await pi.waitFor((s) => /● foreground · (?:script S1|.+ \(S1\))/.test(s), 60_000);
		pi.press("ctrlB");
		await pi.waitFor("moved to the background (id S1)", 30_000);
		await pi.waitFor((s) => /● background · (?:script S1|.+ \(S1\))/.test(s));
		await pi.waitFor(/Background script S1 (\([^)]*\) )?completed/, 60_000);
		await pi.waitFor("chk:42");
	});
});

test("ctrl+b with text in the editor moves the cursor and does not background the script", async () => {
	await withPi({ lingerMs: 60000 }, async (pi) => {
		await pi.waitFor("claude-haiku");
		pi.submit(SLOW_SCRIPT);
		await pi.waitFor((s) => /● foreground · (?:script S1|.+ \(S1\))/.test(s), 60_000);
		pi.type("abc");
		await pi.waitFor((s) => /^abc\s*$/m.test(s));
		pi.press("ctrlB");
		pi.type("X");
		await pi.waitFor((s) => /^abXc\s*$/m.test(s));
		assert.match(pi.viewport(), /● foreground · (?:script S1|.+ \(S1\))/);
		assert.ok(!pi.screen().includes("background (id S1)"), "the script stayed in the foreground");
	});
});
