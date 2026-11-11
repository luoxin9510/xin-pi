// Specs 02 and 03 in real interactive xpi (pty + headless xterm), real haiku: a named agent's label, the phase title and
// the log line in the panel; `s` on a script row saves the script as a workflow; `/name` then runs it with no model turn.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { withPi } from "./harness.ts";

const SCRIPT = `Use the codemode tool exactly once. Script:
phase("work");
log("halfway there");
const r = await tools.Agent({ name: "kid", description: "panel kid", prompt: "Run the bash command 'sleep 45' using a tool, then reply OK.", subagent_type: "general-purpose" });
return "chk:" + r.status;
If the tool says the script moved to the background, reply with the single word moved and stop.`;

test("the panel shows the name, the phase and the log line; s saves the script; /name runs the saved workflow", async () => {
	await withPi({ lingerMs: 60000 }, async (pi) => {
		await pi.waitFor("claude-haiku");
		pi.submit(SCRIPT);
		const v = await pi.waitFor(
			(s) =>
				/● background · (?:script S1|.+ \(S1\)) · 1 agents running .*halfway there/.test(s) &&
				/running · general-purpose\(kid\) panel kid · /.test(s),
			90_000,
		);
		const lines = v.split("\n");
		const script = lines.findIndex((l) => /(script S1|\(S1\)) ·/.test(l));
		assert.equal(lines[script + 1]!.trim(), "work", "the phase title sits between the script and its agent");
		assert.match(lines[script + 2]!, /general-purpose\(kid\) panel kid/);

		pi.press("down");
		await pi.waitFor((s) => /▸ .*(?:script S1|\(S1\))/.test(s) && s.includes("s save as workflow"));
		pi.type("s");
		await pi.waitFor("Save script as workflow: name");
		pi.type("saved-one");
		pi.press("enter");
		await pi.waitFor("Description");
		pi.type("Saved from the panel");
		pi.press("enter");
		await pi.waitFor("Save where?");
		pi.press("enter"); // the first choice: the project
		await pi.waitFor("subagent: saved"); // the notice wraps: the path is long
		const file = join(pi.repo, ".pi", "workflows", "saved-one.js");
		assert.ok(existsSync(file), "the workflow file was written");
		const text = readFileSync(file, "utf8");
		assert.match(
			text,
			/^export const meta = \{\n {2}name: "saved-one",\n {2}description: "Saved from the panel",\n\}/,
		);
		assert.match(text, /tools\.Agent\(\{ name: "kid"/);

		// The new workflow is a command at once. Its own agent cannot take the name "kid" again, so the run fails on
		// that, which shows it really started from the saved file with no model turn.
		pi.submit("/saved-one");
		await pi.waitFor("Workflow saved-one started as background script S2", 30_000);
		await pi.waitFor(/Background script S2 \(workflow saved-one[^)]*\) failed/, 30_000);
		await pi.waitFor('the name "kid" is already used by agent', 30_000);
	});
});

const SLOW = `Use the codemode tool exactly once. Script:
const r = await tools.Agent({ description: "stuck kid", prompt: "Run the bash command 'sleep 40' using a tool, then reply OK.", subagent_type: "general-purpose" });
return "chk:" + r.status;
If the tool says the script moved to the background, reply with the single word moved and stop.`;

test("r on a running agent's row restarts it: the row stays running and the first start's session is kept aside", async () => {
	await withPi({ lingerMs: 60000 }, async (pi) => {
		await pi.waitFor("claude-haiku");
		pi.submit(SLOW);
		await pi.waitFor(/running · general-purpose\(stuck kid\) · [1-9]\d* turns · bash/, 90_000);
		pi.press("down", "down"); // the script row, then its agent
		await pi.waitFor((s) => /▸ .*general-purpose\(stuck kid\)/.test(s) && s.includes("r restart"));
		pi.type("r");
		const shelved = () => {
			const root = join(pi.sessionDir, "subagents");
			if (!existsSync(root)) return [];
			return readdirSync(root).flatMap((d) => readdirSync(join(root, d)).filter((f) => f.includes(".restart-1.")));
		};
		for (const end = Date.now() + 30_000; shelved().length === 0; ) {
			if (Date.now() > end) throw new Error("timed out waiting for the shelved session");
			await new Promise((r) => setTimeout(r, 100));
		}
		// It is at work again, and nothing told main it had failed.
		await pi.waitFor(/running · general-purpose\(stuck kid\) · [2-9]\d* turns · bash/, 60_000);
		assert.doesNotMatch(pi.viewport(), /Background script S1 (\([^)]*\) )?(failed|stopped)/);
		pi.type("x");
		await pi.waitFor(/(failed|stopped) · general-purpose\(stuck kid\)/, 30_000);
	});
});

const TWO = `Use the codemode tool exactly once. Script:
const a = await tools.Agent({ description: "first kid", prompt: "Run the bash command 'sleep 6' using a tool, then reply OK.", subagent_type: "general-purpose" });
const b = await tools.Agent({ description: "second kid", prompt: "Run the bash command 'sleep 6' using a tool, then reply OK.", subagent_type: "general-purpose" });
return "chk:" + a.status + b.status;
If the tool says the script moved to the background, reply with the single word moved and stop.`;

test("p on a script row pauses it: the running agent finishes and the next one waits until p resumes", async () => {
	await withPi({ lingerMs: 60000 }, async (pi) => {
		await pi.waitFor("claude-haiku");
		pi.submit(TWO);
		await pi.waitFor(/running · general-purpose\(first kid\) · [1-9]\d* turns/, 90_000);
		pi.press("down");
		await pi.waitFor((s) => /▸ .*(?:script S1|\(S1\))/.test(s) && s.includes("p pause"));
		pi.type("p");
		await pi.waitFor((s) => /● paused · (?:script S1|.+ \(S1\))/.test(s) && s.includes("p resume"));
		// The first agent finishes; the second is not started while the script is paused.
		await pi.waitFor(/completed · general-purpose\(first kid\)/, 60_000);
		await new Promise((r) => setTimeout(r, 4000));
		assert.doesNotMatch(pi.viewport(), /general-purpose\(second kid\)/);
		assert.match(pi.viewport(), /● paused · (?:script S1|.+ \(S1\))/);
		pi.type("p");
		await pi.waitFor(/running · general-purpose\(second kid\)/, 60_000);
		await pi.waitFor(/Background script S1 (\([^)]*\) )?completed/, 90_000);
		await pi.waitFor("chk:completedcompleted", 30_000);
	});
});
