// Ticket v2-08: stopping a subagent and /model, in real interactive pi (pty + headless xterm), on real haiku.
import { test } from "node:test";
import { withPi } from "./harness.ts";

// The result row is "chk:" + status|error, which the script's own source (echoed in the transcript) does not spell out.
const script = (description: string) => `Use the codemode tool. Script:
const r = await tools.Agent({ description: "${description}", prompt: "Run the bash command 'sleep 60' using a tool, then reply OK.", subagent_type: "general-purpose" });
return "chk:" + [r.status, r.error].join("|");
After the script finishes, reply with the single word DONE.`;

test("x on a running panel row stops the subagent; main's script gets the failed result", async () => {
	await withPi({ lingerMs: 20000 }, async (pi) => {
		await pi.waitFor("claude-haiku");
		pi.submit(script("stop by x"));
		await pi.waitFor((s) => /running · general-purpose\(stop by x\) · [1-9]\d* turns · bash/.test(s), 90_000);
		pi.press("down", "down");
		await pi.waitFor("x stop");
		pi.type("x");
		await pi.waitFor("chk:failed|stopped by user", 30_000);
		await pi.waitFor("■ stopped · general-purpose(stop by x)", 20_000);
	});
});

test("/model and /stop on the subagent screen", async () => {
	await withPi({ lingerMs: 20000 }, async (pi) => {
		await pi.waitFor("claude-haiku");
		pi.submit(script("screen stop"));
		await pi.waitFor((s) => /running · general-purpose\(screen stop\) · [1-9]\d* turns · bash/.test(s), 90_000);
		pi.press("down", "down", "enter");
		await pi.waitFor((s) => /main › general-purpose\(screen stop\)/.test(s) && s.includes("/stop /model"));

		// a model named in the command
		pi.submit("/model anthropic/claude-haiku-4-5");
		await pi.waitFor("model: anthropic/claude-haiku-4-5", 20_000);
		pi.submit("/model anthropic/nope");
		await pi.waitFor("unknown model anthropic/nope", 20_000);

		// a model picked from the list
		pi.submit("/model");
		await pi.waitFor(
			(s) => s.includes("Model for general-purpose") && s.includes("▸ anthropic/claude-haiku-4-5"),
			20_000,
		);
		pi.press("down", "enter");
		await pi.waitFor((s) => /model: anthropic\//.test(s) && !s.includes("Model for general-purpose"), 20_000);

		pi.submit("/stop");
		await pi.waitFor("■ stopped", 30_000);
		pi.submit("/stop");
		await pi.waitFor("the subagent is not running", 20_000);
		pi.submit("/main");
		await pi.waitFor("chk:failed|stopped by user", 30_000);
	});
});
