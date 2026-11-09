// v3a ticket 01: a codemode script that starts a subagent moves to the background (real parent pi, rpc, haiku).
import assert from "node:assert/strict";
import { test } from "node:test";
import { startParent, textOfMessage } from "./helpers.ts";

const AGENT_CALL = (sleep: number) =>
	`tools.Agent({description:'wait',prompt:'Run the bash command \`sleep ${sleep}\` then reply with the word DONE'})`;
// 6*7 is computed by the script, so "TOK-42" appears in the transcript only if the script's return value reached main.
const RETURN = "return 'TOK-' + (6*7) + ' ' + r.status;";
const runScript = (code: string, then: string) =>
	`Call the codemode tool exactly once with exactly this code:\n\`\`\`js\n${code}\n\`\`\`\n${then}`;

const isCodemodeEnd = (e: any) => e.type === "tool_execution_end" && e.toolName === "codemode" && !e.parentToolCallId;
const isAgentEnd = (e: any) => e.type === "tool_execution_end" && e.toolName === "Agent";
const isScriptMessage = (e: any) =>
	e.type === "message_end" && e.message.role === "custom" && textOfMessage(e.message).includes("Background script S1");

test("a script that starts an agent returns to main at once, main's turn ends, and the result starts a new turn", async () => {
	const p = startParent();
	try {
		p.prompt(
			runScript(
				`const r = await ${AGENT_CALL(4)};\n${RETURN}`,
				"If it says the script moved to the background, reply 'moved' and stop. When the script's result arrives, reply with its return value verbatim.",
			),
		);

		const early = await p.waitFor("codemode call end", isCodemodeEnd, 60_000);
		assert.match(textOfMessage({ content: early.result.content }), /moved to the background \(id S1\)/);
		const agentStart = p.events.find((e) => e.type === "tool_execution_start" && e.toolName === "Agent")!;
		assert.equal(agentStart.parentToolCallId, early.toolCallId, "nested ids carry the codemode call id");
		assert.ok(agentStart.toolCallId.startsWith(`${early.toolCallId}/`));

		// main's turn ends while the agent still runs
		const settled = await p.waitFor("main's first turn to settle", (e) => e.type === "agent_settled", 60_000);
		const agentEnd = await p.waitFor("the agent to end", isAgentEnd, 90_000);
		assert.ok(settled.at < agentEnd.at, `main settled at ${settled.at} ms, the agent ended at ${agentEnd.at} ms`);

		// the message carries the return value and the agent, and starts a new turn
		const message = await p.waitFor("the script's message", isScriptMessage, 60_000);
		const text = textOfMessage(message.message);
		assert.match(text, /S1 completed/);
		assert.match(text, /TOK-42 completed/);
		assert.match(text, /Agents:\n- [a-z0-9]{12} general-purpose completed \$/);
		const index = p.events.indexOf(message);
		const newRun = p.events.slice(0, index).findLast((e) => e.type === "agent_start")!;
		assert.ok(newRun.at > settled.at, "the message started a second run after the first one settled");
		const reply = await p.waitFor(
			"main's reply",
			(e) =>
				e.type === "message_end" && e.message.role === "assistant" && textOfMessage(e.message).includes("TOK-42"),
			60_000,
			index,
		);
		assert.ok(reply);
		assert.equal(
			p.events.some((e) => e.type === "extension_error"),
			false,
		);
	} finally {
		p.stop();
	}
});

test("a script that starts no agent stays in the foreground and returns its own result", async () => {
	const p = startParent();
	try {
		p.prompt(runScript("return 'TOK-' + (6*7);", "Then reply with the script's return value."));
		const end = await p.waitFor("codemode call end", isCodemodeEnd, 60_000);
		const text = textOfMessage({ content: end.result.content });
		assert.match(text, /TOK-42/);
		assert.doesNotMatch(text, /background/);
		await p.waitFor("main to settle", (e) => e.type === "agent_settled", 60_000);
		assert.equal(
			p.events.some((e) => e.type === "message_end" && e.message.role === "custom"),
			false,
			"no script message",
		);
	} finally {
		p.stop();
	}
});

test("a script that ends while main runs another turn is delivered as a steer, and its calls kept working meanwhile", async () => {
	const p = startParent();
	try {
		p.prompt(
			runScript(
				`const r = await ${AGENT_CALL(3)};\nawait tools.bash({command:'echo AFTER'});\n${RETURN}`,
				"If it says the script moved to the background, reply 'moved' and stop.",
			),
		);
		await p.waitFor("main's first turn to settle", (e) => e.type === "agent_settled", 60_000);
		const from = p.events.length;
		p.prompt("Call the bash tool directly (not codemode) with the command `sleep 16`, then reply 'slept'.");
		const mainBash = await p.waitFor(
			"main's bash to start",
			(e) => e.type === "tool_execution_start" && e.toolName === "bash" && !e.parentToolCallId,
			60_000,
			from,
		);
		// the script's own bash call runs while main's bash is still running
		const nested = await p.waitFor(
			"the script's bash call",
			(e) => e.type === "tool_execution_end" && e.toolName === "bash" && !!e.parentToolCallId,
			60_000,
			from,
		);
		const mainBashEnd = await p.waitFor(
			"main's bash to end",
			(e) => e.type === "tool_execution_end" && e.toolCallId === mainBash.toolCallId,
			60_000,
			from,
		);
		assert.ok(nested.at < mainBashEnd.at, "the background script kept calling tools during main's turn");

		const message = await p.waitFor("the script's message", isScriptMessage, 60_000, from);
		assert.match(textOfMessage(message.message), /TOK-42 completed/);
		const after = p.events.slice(p.events.indexOf(message));
		assert.ok(
			!p.events.slice(from, p.events.indexOf(message)).some((e) => e.type === "agent_end"),
			"main was still running: a steer, not a new run",
		);
		assert.ok(after.length > 0);
	} finally {
		p.stop();
	}
});
