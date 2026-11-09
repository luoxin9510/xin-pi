// v3a ticket 03 on a real parent pi (rpc, haiku): errors and long results in the script message, Esc, quitting, and the
// off switch. Stop through the registry, several scripts and maxConcurrent are in test/faults/background-edges.test.ts.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { startParent, textOfMessage } from "./helpers.ts";

const AGENT = (extra: string, cmd = "reply with the word DONE") =>
	`tools.Agent({description:'x',prompt:'${cmd}'${extra}})`;
const runScript = (code: string, then: string) =>
	`Call the codemode tool exactly once with exactly this code:\n\`\`\`js\n${code}\n\`\`\`\n${then}`;
const STOP_AFTER = "Reply 'ok' and stop. When a background result arrives, reply 'ok' again.";
const isCodemodeEnd = (e: any) => e.type === "tool_execution_end" && e.toolName === "codemode" && !e.parentToolCallId;
const isCustom = (e: any) => e.type === "message_end" && e.message.role === "custom";
const customWith = (s: string) => (e: any) => isCustom(e) && textOfMessage(e.message).includes(s);

// Every agent meta file under the parent's session dir.
function metas(sessionDir: string): { id: string; status: string }[] {
	if (!existsSync(sessionDir)) return [];
	return (readdirSync(sessionDir, { recursive: true }) as string[])
		.filter((f) => /subagents[\\/][^\\/]+[\\/][a-z0-9]{12}\.json$/.test(f))
		.map((f) => ({ id: f.slice(-17, -5), status: JSON.parse(readFileSync(join(sessionDir, f), "utf8")).status }));
}

test("a script that throws reports its error; a return value over 8 KB is cut with the full text in a file", async () => {
	const p = startParent();
	try {
		p.prompt(runScript(`await ${AGENT("")};\nthrow new Error('KABOOM-' + (6*7));`, STOP_AFTER));
		const failed = await p.waitFor("the failure message", customWith("KABOOM-42"), 90_000);
		assert.match(textOfMessage(failed.message), /^Background script S1 failed\.\nError: [\s\S]*KABOOM-42/);
		await p.waitFor("main to settle", (e) => e.type === "agent_settled", 60_000, p.events.indexOf(failed));

		const from = p.events.length;
		p.prompt(runScript(`await ${AGENT("")};\nreturn 'y'.repeat(20000);`, STOP_AFTER));
		const long = await p.waitFor("the long message", customWith("Background script S2"), 90_000, from);
		const text = textOfMessage(long.message);
		assert.ok(
			text.includes("y".repeat(7500)) && !text.includes("y".repeat(8100)),
			"cut at 8000 chars of the result text",
		);
		const file = text.match(/all of it is in (\S+\.txt)/)?.[1];
		assert.ok(file && file.includes("subagents"), `a file in the session subagents dir: ${text.slice(-300)}`);
		assert.ok(readFileSync(file, "utf8").endsWith("y".repeat(20000)));
	} finally {
		p.stop();
	}
});

test("Esc stops a script still in the foreground but leaves a background script running", async () => {
	const p = startParent();
	try {
		p.prompt(
			runScript(
				`await ${AGENT("", "Run the bash command `sleep 6` then reply DONE")};\nreturn 'BG-' + (6*7);`,
				STOP_AFTER,
			),
		);
		await p.waitFor("script moved", isCodemodeEnd, 60_000);
		await p.waitFor("main to settle", (e) => e.type === "agent_settled", 60_000);

		const from = p.events.length;
		p.prompt(
			runScript(
				`await ${AGENT(",run_in_background:false", "Run the bash command `sleep 120` then reply DONE")};\nreturn 'FG-never';`,
				"Then reply ok.",
			),
		);
		await p.waitFor(
			"foreground agent started",
			(e) => e.type === "tool_execution_start" && e.toolName === "Agent" && !!e.parentToolCallId,
			60_000,
			from,
		);
		p.abort();
		const end = await p.waitFor(
			"the foreground codemode call to end (the agent sleeps 120 s)",
			isCodemodeEnd,
			30_000,
			from,
		);
		assert.doesNotMatch(textOfMessage({ content: end.result.content }), /FG-never/);

		const bg = await p.waitFor("the background script's message", customWith("BG-42"), 90_000);
		assert.match(textOfMessage(bg.message), /^Background script S1 completed\./);
	} finally {
		p.stop();
	}
});

test("quitting stops a background script and a detached agent: stopped, resumable, nothing left running", async () => {
	const p = startParent();
	try {
		const sleep = "Run the bash command `sleep 120` then reply DONE";
		p.prompt(
			runScript(
				`const d = await ${AGENT(",run_in_background:true", sleep)};\nawait ${AGENT("", sleep)};\nreturn 'never';`,
				STOP_AFTER,
			),
		);
		await p.waitFor("script moved", isCodemodeEnd, 60_000);
		await p.waitFor(
			"both agents running",
			() =>
				metas(p.sessionDir).length === 2 ||
				p.events.filter((e) => e.type === "tool_execution_start" && e.toolName === "Agent").length === 2,
			60_000,
		);
		await p.waitFor("main to settle", (e) => e.type === "agent_settled", 60_000);
		await new Promise((r) => setTimeout(r, 3000)); // let both children get going
		const t0 = Date.now();
		await p.quit();
		assert.ok(Date.now() - t0 < 20_000, "quit did not hang on the children");
		const after = metas(p.sessionDir);
		assert.equal(after.length, 2, JSON.stringify(after));
		assert.deepEqual(
			after.map((m) => m.status),
			["stopped", "stopped"],
		);
		assert.equal(statSync(p.sessionDir).isDirectory(), true);
	} finally {
		p.stop();
	}
});

test("subagent.backgroundScripts: false is v2: the script waits and the codemode call returns its own result", async () => {
	const p = startParent({ backgroundScripts: false });
	try {
		p.prompt(
			runScript(
				`const r = await ${AGENT("")};\nreturn 'TOK-' + (6*7) + ' ' + r.status;`,
				"Reply with the script's return value verbatim.",
			),
		);
		const end = await p.waitFor("codemode call end", isCodemodeEnd, 120_000);
		const text = textOfMessage({ content: end.result.content });
		assert.match(text, /TOK-42 completed/);
		assert.doesNotMatch(text, /background/);
		await p.waitFor("main to settle", (e) => e.type === "agent_settled", 60_000);
		assert.equal(p.events.some(isCustom), false, "no script message");
	} finally {
		p.stop();
	}
});
