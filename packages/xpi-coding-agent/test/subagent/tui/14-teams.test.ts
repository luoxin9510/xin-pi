// Agent teams UI (spec "UI", PR 3): teammate rows in the panel that never hide, Esc interrupting a teammate without
// stopping it, `x` on an idle teammate, typing on its screen, and the /tasks overlay. Real interactive pi in a pty on real
// haiku. The teammates are started by a codemode script (the lead's model only has to run it) and given tasks that make
// haiku's behaviour irrelevant: an immediate one-word answer (idle at once) or one long sleep (running until interrupted).
import assert from "node:assert/strict";
import { readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { type PiTerminal, withPi } from "./harness.ts";

const TEAMS = { XPI_EXPERIMENTAL_AGENT_TEAMS: "1" };

// The lead starts one teammate and reports. `prompt` is the teammate's first message.
const start = (prompt: string) => `Use the codemode tool. Script:
const r = await tools.Agent({ description: "team probe", name: "ally", prompt: ${JSON.stringify(prompt)}, subagent_type: "general-purpose" });
return r.status;
After the script finishes, reply with the single word LEADOK.`;

const QUICK = "Reply with exactly the word READY and nothing else.";
const SLOW = "Run the bash command 'sleep 90' using a tool, then reply DONE.";
const IDLE_ROW = "○ idle · ally (general-purpose)";
const RUNNING_ROW = "● running · ally (general-purpose)";

// Start the teammate from the lead's script and wait until its row shows `row`.
async function lead(pi: PiTerminal, prompt: string, row: string) {
	await pi.waitFor("claude-haiku");
	pi.submit(start(prompt));
	await pi.waitFor(row, 120_000);
}

// Focus the panel on the teammate (the script row, if it still lingers, would come first).
async function selectAlly(pi: PiTerminal) {
	await pi.waitGone(/Scripts \(/, 30_000);
	pi.press("down");
	await pi.waitFor((s) => s.includes("▸") && s.includes("ally") && s.includes("x stop"), 10_000);
}

test("a teammate's row stays in the panel long after its exchange ended; x stops it while idle, and the stopped row then leaves", async () => {
	await withPi({ lingerMs: 1000, env: TEAMS }, async (pi) => {
		await lead(pi, QUICK, IDLE_ROW);
		// well past panelLingerMs: an idle teammate never hides
		await new Promise((r) => setTimeout(r, 3500));
		assert.ok(pi.viewport().includes(IDLE_ROW), `the idle row is still there:\n${pi.viewport()}`);

		await selectAlly(pi);
		pi.type("x"); // no process to kill: the teammate is stopped all the same
		await pi.waitFor("■ stopped · ally", 15_000);
		await pi.waitGone("■ stopped · ally", 15_000); // a stopped row lingers like any finished one, then goes
	});
});

test("Esc on a running teammate's screen interrupts its turn and leaves it idle, not stopped; a second Esc closes the screen", async () => {
	await withPi({ lingerMs: 1000, env: TEAMS }, async (pi) => {
		await lead(pi, SLOW, RUNNING_ROW);
		await pi.waitFor((s) => /running · ally \(general-purpose\) · .*bash/.test(s), 60_000); // it is in its sleep
		await selectAlly(pi);
		pi.press("enter");
		await pi.waitFor((s) => /main › ally/.test(s) && s.includes("● running"), 15_000);

		pi.press("esc");
		const v = await pi.waitFor(
			(s) => s.includes("interrupted: the teammate is idle") || s.includes("○ idle"),
			30_000,
		);
		await pi.waitFor((s) => /main › ally/.test(s) && s.includes("○ idle"), 30_000);
		assert.doesNotMatch(pi.viewport(), /■ stopped|✗ failed/, `not stopped, not failed:\n${v}`);

		pi.press("esc"); // the second Esc closes the screen
		await pi.waitGone("main ›");
		// back on the panel: the teammate is idle and stays (linger is 1 s)
		await new Promise((r) => setTimeout(r, 2500));
		assert.ok(pi.viewport().includes(IDLE_ROW), `idle row after the interrupt:\n${pi.viewport()}`);
	});
});

test("typing on an idle teammate's screen starts a new exchange with the user's text, and its answer shows there", async () => {
	await withPi({ env: TEAMS }, async (pi) => {
		await lead(pi, QUICK, IDLE_ROW);
		await selectAlly(pi);
		pi.press("enter");
		await pi.waitFor((s) => /main › ally/.test(s) && s.includes("○ idle"), 15_000);

		pi.type("Reply with the word PONG immediately followed by the number 7731, no space, nothing else.");
		pi.press("enter");
		await pi.waitFor("● running", 30_000); // a new exchange began
		await pi.waitFor(/PONG7731/, 90_000); // its answer, drawn on the screen
		await pi.waitFor((s) => /main › ally/.test(s) && s.includes("○ idle"), 60_000);

		pi.press("esc"); // idle: Esc closes
		await pi.waitGone("main ›");
	});
});

test("/tasks opens the task list overlay, which refreshes when a task file changes", async () => {
	await withPi({ env: TEAMS }, async (pi) => {
		await pi.waitFor("claude-haiku");
		pi.submit(`Use the codemode tool. Script:
const a = await tools.TaskCreate({ subject: "alpha task", description: "first" });
const b = await tools.TaskCreate({ subject: "bravo task", description: "second", blockedBy: ["1"] });
return [a.id, b.id];
After the script finishes, reply with the single word TASKSMADE.`);
		await pi.waitFor(/TASKSMADE/, 120_000);

		pi.submit("/tasks");
		const v = await pi.waitFor((s) => s.includes("Tasks (0/2 done)"), 20_000);
		assert.match(v, /#1 .*pending .*alpha task/);
		assert.match(v, /#2 .*pending .*bravo task.*blocked by #1/);

		// complete #1 from outside, as a teammate would: the open overlay redraws by itself
		const tasks = join(pi.root, "pi-agent", "tasks");
		const dir = join(tasks, readdirSync(tasks).find((d) => d.startsWith("session-"))!);
		const file = join(dir, "1.json");
		const task = JSON.parse(readFileSync(file, "utf8"));
		writeFileSync(`${file}.tmp`, JSON.stringify({ ...task, status: "completed", updatedAt: Date.now() }));
		renameSync(`${file}.tmp`, file); // atomic, as the real writers do
		const after = await pi.waitFor((s) => s.includes("Tasks (1/2 done)"), 10_000);
		assert.doesNotMatch(after, /bravo task.*blocked by/, "the blocker is done");

		pi.press("esc");
		await pi.waitGone("Tasks (");
	});
});
