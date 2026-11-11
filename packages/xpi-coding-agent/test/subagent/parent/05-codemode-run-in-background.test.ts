// codemode run_in_background (real parent pi, rpc, haiku): asked to run a slow command without making the user wait, the
// model sets run_in_background on its codemode call, the call returns at once, and the script's result arrives later as a
// message. The prompt does not name the flag: the tool description has to teach it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startParent, textOfMessage } from "./helpers.ts";

const isCodemodeStart = (e: any) =>
	e.type === "tool_execution_start" && e.toolName === "codemode" && !e.parentToolCallId;
const isCodemodeEnd = (e: any) => e.type === "tool_execution_end" && e.toolName === "codemode" && !e.parentToolCallId;
const isScriptMessage = (e: any) =>
	e.type === "message_end" && e.message.role === "custom" && textOfMessage(e.message).includes("Background script S1");

test("a slow command goes to the background with run_in_background; the call returns at once and the result arrives as a message", async () => {
	const p = startParent();
	try {
		p.prompt(
			"Use the codemode tool (not the bash tool directly) to run the shell command `sleep 40 && echo done-marker` with tools.bash inside the script. " +
				"I do not need its output this turn, so do not make me wait for it. " +
				"Once you have started it, reply with the single word started and stop. When its result arrives, reply with the marker word it printed.",
		);

		const start = await p.waitFor("the codemode call", isCodemodeStart, 90_000);
		assert.equal(start.args.run_in_background, true, `the call was ${JSON.stringify(start.args)}`);
		const early = await p.waitFor("the codemode call to return", isCodemodeEnd, 30_000);
		assert.match(textOfMessage({ content: early.result.content }), /Script S1.*started in the background/);

		// main's turn ends while the command still sleeps
		const settled = await p.waitFor("main's first turn to settle", (e) => e.type === "agent_settled", 60_000);
		assert.ok(settled.at - start.at < 35_000, "main did not wait for the 40 s command");

		const message = await p.waitFor("the script's message", isScriptMessage, 90_000);
		assert.match(textOfMessage(message.message), /done-marker/);
		assert.ok(message.at > settled.at, "the result came after main's turn ended");
		const index = p.events.indexOf(message);
		await p.waitFor(
			"main's reply",
			(e) =>
				e.type === "message_end" &&
				e.message.role === "assistant" &&
				textOfMessage(e.message).includes("done-marker"),
			60_000,
			index,
		);
		assert.equal(
			p.events.some((e) => e.type === "extension_error"),
			false,
		);
	} finally {
		p.stop();
	}
});
