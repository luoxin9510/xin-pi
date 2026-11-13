// Agent teams, the whole flow on real haiku (spec "Testing" -> "Real check"): a lead with two teammates on a three-task
// list where task 3 waits for 1 and 2. The teammates claim one task each, message each other once and complete their
// task; the lead completes task 3, then asks one teammate to shut down and it approves. The session ends with /quit.
// The assertions read the durable state (task files, the team's config.json, the session files), not what the model said.
// Real model, several minutes, by hand (it is part of `npm run test:subagent:tui`), or alone:
//   node --test --experimental-strip-types test/subagent/tui/15-teams-flow.test.ts
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { test } from "node:test";
import { type PiTerminal, withPi } from "./harness.ts";

const TEAMS = { XPI_EXPERIMENTAL_AGENT_TEAMS: "1" };
const STEP_MS = 5 * 60_000;

// What each teammate does, as exact tool calls. The markers let the test find the message in the other's session.
const teammate = (me: "alpha" | "beta", other: "alpha" | "beta", task: string, marker: string) =>
	`You are ${me}, a member of a team. Use the codemode tool exactly once with this script, unchanged:
await tools.TaskUpdate({ id: "${task}", status: "in_progress" });
await tools.SendMessage({ to: "${other}", message: "${marker}", summary: "hello from ${me}" });
await tools.TaskUpdate({ id: "${task}", status: "completed", result: "${me} finished task ${task}" });
return "ok";
Then reply with the single word DONE. Do not answer ${other}'s message and send nothing else. The one exception: if the lead
sends you a shutdown request, answer it with the codemode tool, script: await tools.SendMessage({ to: "lead", kind: "shutdown_response", approve: true }); return "ok";`;

const STEP1 = `Use the codemode tool exactly once with this script, unchanged:
await tools.TaskCreate({ subject: "task one", description: "first job" });
await tools.TaskCreate({ subject: "task two", description: "second job" });
await tools.TaskCreate({ subject: "task three", description: "after one and two", blockedBy: ["1", "2"] });
const a = await tools.Agent({ description: "alpha", name: "alpha", subagent_type: "general-purpose", prompt: ${JSON.stringify(teammate("alpha", "beta", "1", "ALPHA-HELLO-7731"))} });
const b = await tools.Agent({ description: "beta", name: "beta", subagent_type: "general-purpose", prompt: ${JSON.stringify(teammate("beta", "alpha", "2", "BETA-HELLO-4417"))} });
return [a.status, b.status];
After the script finishes, reply with the single word LEADOK.`;

const STEP2 = `Use the codemode tool exactly once with this script, unchanged:
await tools.TaskUpdate({ id: "3", status: "in_progress" });
await tools.TaskUpdate({ id: "3", status: "completed", result: "lead finished task 3" });
return "ok";
Then reply with the single word TASK3DONE.`;

const STEP3 = `Use the codemode tool exactly once with this script, unchanged:
await tools.SendMessage({ to: "alpha", kind: "shutdown_request", message: "All work is done. Please shut down." });
return "ok";
Then reply with the single word ASKED.`;

interface Task {
	id: string;
	status: string;
	owner?: string;
	blockedBy: string[];
	result?: string;
}
interface Config {
	members: { name: string; status: string }[];
}

const readJson = <T>(file: string): T | undefined => {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as T;
	} catch {
		return undefined; // not there yet, or caught mid-write (writers rename, so this is rare)
	}
};

// Poll `read` until it returns something other than undefined.
async function until<T>(what: string, read: () => T | undefined, pi: PiTerminal, ms = STEP_MS): Promise<T> {
	const end = Date.now() + ms;
	for (;;) {
		const v = read();
		if (v !== undefined) return v;
		if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${what}. Screen:\n${pi.viewport()}`);
		await new Promise((r) => setTimeout(r, 500));
	}
}

function filesUnder(dir: string): string[] {
	const out: string[] = [];
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) out.push(...filesUnder(p));
		else out.push(p);
	}
	return out;
}

test(
	"a lead and two teammates: tasks with a dependency, messages, idle notices, an approved shutdown, and the end of the session",
	{
		timeout: 20 * 60_000,
	},
	async () => {
		await withPi({ env: TEAMS }, async (pi) => {
			const agentDir = join(pi.root, "pi-agent");
			await pi.waitFor("claude-haiku");
			pi.submit(STEP1);

			// The team directory appears with the first teammate (session-<full session id>).
			const team = await until(
				"the team directory",
				() =>
					existsSync(join(agentDir, "teams"))
						? readdirSync(join(agentDir, "teams")).find((d) => d.startsWith("session-"))
						: undefined,
				pi,
			);
			const teamDir = join(agentDir, "teams", team);
			const tasksDir = join(agentDir, "tasks", team);
			const task = (id: string) => readJson<Task>(join(tasksDir, `${id}.json`));
			const config = () => readJson<Config>(join(teamDir, "config.json"));
			const member = (name: string) => config()?.members.find((m) => m.name === name)?.status;

			// Both teammates complete their task (each claimed its own) and go idle. Task 3 is checked below: its blockedBy is stored as [1, 2] and it is still pending.
			await until(
				"tasks 1 and 2 completed",
				() => (task("1")?.status === "completed" && task("2")?.status === "completed" ? true : undefined),
				pi,
			);
			await until(
				"both teammates idle",
				() => (member("alpha") === "idle" && member("beta") === "idle" ? true : undefined),
				pi,
			);
			const t3 = task("3");
			assert.deepEqual(t3?.blockedBy, ["1", "2"], "task 3 stores 1 and 2 as blockers");
			assert.equal(t3?.status, "pending", "nobody took task 3 yet");
			assert.equal(task("1")?.owner, "alpha");
			assert.equal(task("2")?.owner, "beta");

			// The lead finishes task 3 (it is unblocked now).
			pi.submit(STEP2);
			await until("task 3 completed", () => (task("3")?.status === "completed" ? true : undefined), pi);
			assert.equal(task("3")?.owner, "lead");

			// The lead asks alpha to shut down; alpha approves, and the lead's roster shows it stopped (beta is untouched).
			pi.submit(STEP3);
			await until("alpha stopped", () => (member("alpha") === "stopped" ? true : undefined), pi);
			assert.notEqual(member("beta"), "stopped", "only the member that was asked stops");

			// The messages between the teammates arrived: a teammate's (child) session holds an envelope from the other whose
			// body carries the marker. The lead's own session is left out: it holds both markers in its prompt and the idle notices.
			const files = filesUnder(pi.root).filter((f) => f.endsWith(".jsonl") && f.includes(`${sep}subagents${sep}`));
			const sawEnvelope = (from: string, marker: string) =>
				files.some((f) =>
					// In the JSON-escaped file the envelope reads: agent-message from=\"alpha\" ... >\n<text>
					new RegExp(`agent-message from=\\\\*"${from}\\\\*"[^>]*>\\\\n[^<]*${marker}`).test(
						readFileSync(f, "utf8"),
					),
				);
			assert.ok(sawEnvelope("alpha", "ALPHA-HELLO-7731"), "beta received alpha's message");
			assert.ok(sawEnvelope("beta", "BETA-HELLO-4417"), "alpha received beta's message");
			// The lead got an idle notice from each teammate: its own session file (not a subagent's) holds an envelope of
			// kind "idle" from each of them. Polled, since a notice may still be on its way to the lead.
			const sawIdle = (from: string) =>
				filesUnder(pi.root)
					.filter((f) => f.endsWith(".jsonl") && !f.includes(`${sep}subagents${sep}`))
					.some((f) =>
						new RegExp(
							`agent-message from=\\\\*"${from}\\\\*" team=\\\\*"[^"\\\\]*\\\\*" kind=\\\\*"idle\\\\*"`,
						).test(readFileSync(f, "utf8")),
					);
			await until(
				"idle notices from both teammates in the lead's session",
				() => (sawIdle("alpha") && sawIdle("beta") ? true : undefined),
				pi,
			);

			// End the session the way a user does. A kill would count as a crash and leave the team directory behind.
			pi.submit("/quit");
			let exited = await pi.waitExit(10_000);
			if (!exited) {
				pi.press("enter"); // the first Enter may have only picked the command from the autocomplete list
				exited = await pi.waitExit(20_000);
			}
			assert.ok(exited, `xpi exited after /quit. Screen:\n${pi.viewport()}`);

			assert.equal(existsSync(teamDir), false, "the team's config.json and mailboxes are removed at session end");
			assert.ok(existsSync(tasksDir), "the task list stays");
			for (const id of ["1", "2", "3"]) assert.equal(task(id)?.status, "completed", `task ${id} is kept, completed`);
		});
	},
);
