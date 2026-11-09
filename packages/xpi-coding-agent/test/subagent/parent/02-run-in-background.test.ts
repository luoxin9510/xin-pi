// v3a ticket 02: run_in_background false (pins the script to the foreground) and true (the agent alone runs in the background).
import assert from "node:assert/strict";
import { test } from "node:test";
import { beginCodemodeScript } from "../../../src/extensions/codemode/scripts.ts";
import { agentEndMessage } from "../../../src/extensions/subagent/agent-tool.ts";
import { scripts } from "../../../src/extensions/subagent/background.ts";
import { RESULT_LIMIT } from "../../../src/extensions/subagent/sessions.ts";
import { startParent, textOfMessage } from "./helpers.ts";

const QUICK = (flag: string) => `tools.Agent({description:'quick',prompt:'Reply with the word DONE'${flag}})`;
const runScript = (code: string, then: string) =>
	`Call the codemode tool exactly once with exactly this code:\n\`\`\`js\n${code}\n\`\`\`\n${then}`;
const isCodemodeEnd = (e: any) => e.type === "tool_execution_end" && e.toolName === "codemode" && !e.parentToolCallId;
const isCustom = (e: any) => e.type === "message_end" && e.message.role === "custom";

test("script registry: false pins the script, true and later calls leave it, the first plain call moves it", () => {
	const off = scripts.connect({
		sessionId: () => "sess",
		enabled: () => true,
		deliver: () => {},
		parent: () => ({ sessionFile: undefined, sessionId: "sess" }),
	});
	const runs = new Map<string, ReturnType<typeof beginCodemodeScript>>();
	const start = (callId: string) => {
		const run = beginCodemodeScript(callId, "sess", undefined);
		runs.set(callId, run);
		return scripts.get(run.info.id)!;
	};
	const moved = () => [...runs].filter(([, r]) => r.info.state === "background").map(([id]) => id);
	const pinned = start("cA");
	scripts.agentStarting("cA/1", false);
	scripts.agentStarting("cA/2", undefined);
	assert.equal(pinned.pinned, true);
	const bg = start("cB");
	scripts.agentStarting("cB/1", true);
	assert.deepEqual(moved(), [], "false and true never move");
	scripts.agentStarting("cB/2", undefined);
	assert.deepEqual(moved(), ["cB"]);
	assert.equal(bg.pinned, false);
	for (const run of runs.values()) run.end({});
	off();
});

test("the end message of a background agent carries id, status, cost and the output, cut at the limit", () => {
	const usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0123 },
	};
	const r: any = {
		status: "completed",
		agentId: "abc",
		agentType: "explore",
		output: "x".repeat(RESULT_LIMIT + 5),
		usage,
		warnings: [],
	};
	const parent: any = { sessionFile: undefined, sessionId: "s" };
	const text = agentEndMessage(parent, "abc", "explore", r);
	assert.match(text, /^Background agent abc explore completed \(\$0\.0123\)\./);
	assert.match(text, new RegExp(`\\.\\.\\. \\(cut, ${RESULT_LIMIT + 5} bytes; all of it is in `));
	assert.match(agentEndMessage(parent, "abc", "explore", undefined, "aborted"), /stopped.*\nError: aborted/);
});

test("run_in_background:false pins the script: later calls do not move it and the codemode call returns the script's result", async () => {
	const p = startParent();
	try {
		const code = `const a = await ${QUICK(",run_in_background:false")};\nconst b = await ${QUICK("")};\nreturn 'TOK-' + (6*7) + ' ' + a.status + ' ' + b.status;`;
		p.prompt(runScript(code, "Reply with the script's return value verbatim."));
		const end = await p.waitFor("codemode call end", isCodemodeEnd, 120_000);
		const text = textOfMessage({ content: end.result.content });
		assert.match(text, /TOK-42 completed completed/);
		assert.doesNotMatch(text, /background/);
		await p.waitFor("main to settle", (e) => e.type === "agent_settled", 60_000);
		assert.equal(p.events.some(isCustom), false, "no script message");
	} finally {
		p.stop();
	}
});

test("run_in_background:true returns running at once, the script stays in the foreground, and the agent's end reaches main as a message", async () => {
	const p = startParent();
	try {
		const code = `const r = await tools.Agent({description:'wait',prompt:'Run the bash command \`sleep 4\` then reply with the word DONE',run_in_background:true});\nreturn 'TOK-' + (6*7) + ' ' + r.status + ' ' + r.agentId + ' [' + r.output + ']';`;
		p.prompt(
			runScript(
				code,
				"Reply 'started' and stop. When a background agent's result arrives, reply 'got ' plus its agent id.",
			),
		);
		const end = await p.waitFor("codemode call end", isCodemodeEnd, 60_000);
		const text = textOfMessage({ content: end.result.content });
		const m = text.match(/TOK-42 running ([a-z0-9]{12}) \[\]/);
		assert.ok(m, `the call returned the script's own result with a running agent: ${text}`);
		assert.doesNotMatch(text, /moved to the background/);
		const settled = await p.waitFor("main's first turn to settle", (e) => e.type === "agent_settled", 60_000);
		const message = await p.waitFor("the agent's message", isCustom, 90_000);
		const body = textOfMessage(message.message);
		assert.match(body, new RegExp(`^Background agent ${m![1]} general-purpose completed \\(\\$`));
		assert.match(body, /Output:\nDONE/);
		assert.ok(message.at > settled.at);
		await p.waitFor(
			"main's reply",
			(e) => e.type === "message_end" && e.message.role === "assistant" && textOfMessage(e.message).includes(m![1]),
			60_000,
			p.events.indexOf(message),
		);
		assert.equal(
			p.events.some((e) => e.type === "extension_error"),
			false,
		);
	} finally {
		p.stop();
	}
});
