// Script helpers (spec 02): agent, parallel, pipeline, phase, log and args in a real codemode sandbox, with the Agent
// tool of the extension under test and fake children; and the cap on agents per script run.
import assert from "node:assert/strict";
import { test } from "node:test";
import { executeCodemode } from "../../../src/extensions/codemode/execute.ts";
import { scripts } from "../../../src/extensions/subagent/background.ts";
import { ev, loadTool, sandbox } from "../helpers.ts";

const ok = (text: string) => [ev.session(), ev.assistant(text), ev.turnEnd(), ev.settled()];
const failing = [
	ev.session(),
	ev.assistant("", undefined, { stopReason: "error", errorMessage: "529 overloaded" }),
	ev.turnEnd(),
	ev.settled(),
];
const STRUCTURED = { files: ["a.ts"] };
const structured = [
	ev.session(),
	ev.tool("StructuredOutput"),
	ev.toolEnd("StructuredOutput", STRUCTURED),
	ev.turnEnd({ stopReason: "toolUse" }),
	ev.settled(),
];

let calls = 0;

// Run `code` as a codemode script of the loaded extension's session: its tools are the Agent tool (plus `extra`), and
// nested calls get ids "<call id>/<n>" as in a real session.
async function script(t: Awaited<ReturnType<typeof loadTool>>, code: string, extra: any[] = []) {
	const callId = `script-${++calls}`;
	let n = 0;
	const tools = [...(t.registered ? [t.tool] : []), ...extra];
	const ctx = {
		...t.ctx,
		tools,
		sessionManager: { ...t.ctx.sessionManager, getBranch: () => [] },
		executeTool: async (name: string, args: unknown, { signal }: { signal?: AbortSignal }) => {
			const id = `${callId}/${++n}`;
			const toolCall = { type: "toolCall", id, name, arguments: args };
			const tool = tools.find((x) => x.name === name);
			try {
				const result = await tool.execute(id, args, signal, undefined, t.ctx);
				return { toolCall, result, isError: result.isError === true };
			} catch (err) {
				return { toolCall, result: { content: [{ type: "text", text: (err as Error).message }] }, isError: true };
			}
		},
		detachNestedCalls: () => {},
		releaseNestedCalls: () => {},
	};
	const r = await executeCodemode(callId, { code }, undefined, undefined, ctx as any, {});
	const text = r.content.map((c: any) => c.text ?? "").join("");
	return { r, text, callId };
}

// Foreground runs (no move to the background): the script's result is the call's.
const foreground = async (scenario: Parameters<ReturnType<typeof sandbox>["scenario"]>[0], settings = {}) => {
	const s = sandbox();
	s.scenario(scenario);
	return { s, t: await loadTool({ backgroundScripts: false, ...settings }, { cwd: s.repo }) };
};

test("agent(): resolves to the output text; the label defaults to the prompt's first words", async () => {
	const { s, t } = await foreground({ lines: ok("child output") });
	const { text } = await script(
		t,
		"return await agent('Count the lines of every file under src please, then report');",
	);
	assert.match(text, /Script completed[\s\S]*child output/);
	const prompt = s.record().commands.find((c) => c.type === "prompt");
	assert.equal(prompt?.message, "Count the lines of every file under src please, then report");
});

test("agent(): opts map to the Agent call (label, schema, type, model, effort); with a schema it resolves to the value", async () => {
	const seen: any[] = [];
	const { t } = await foreground({ lines: structured });
	const original = t.tool.execute;
	t.tool.execute = (id: string, args: any, ...rest: any[]) => {
		seen.push(args);
		return original(id, args, ...rest);
	};
	const { text } = await script(
		t,
		`const v = await agent('find files', { label: 'finder', schema: { type: 'object', properties: { files: { type: 'array' } }, required: ['files'] }, type: 'Explore', model: 'haiku', effort: 'low', stallMs: 5 });
return JSON.stringify(v);`,
	);
	assert.match(text, /\{"files":\["a\.ts"\]\}/, text);
	assert.equal(seen.length, 1);
	assert.deepEqual(
		{ ...seen[0], schema: undefined },
		{
			description: "finder",
			prompt: "find files",
			subagent_type: "Explore",
			model: "haiku",
			effort: "low",
			schema: undefined,
		},
	);
	assert.deepEqual(seen[0].schema.required, ["files"]);
});

test("agent(): a failed agent resolves to null, as in Claude Code; the script goes on", async () => {
	const { t } = await foreground({ lines: failing });
	const { r, text } = await script(
		t,
		"const a = await agent('do it', { label: 'worker' });\nreturn 'value=' + JSON.stringify(a) + ' reached';",
	);
	assert.notEqual(r.isError, true);
	assert.match(text, /value=null reached/);
});

test("agent(): a schema that is never met fails the call; a failure for another reason is still null", async () => {
	const SCHEMA = "{ type: 'object', properties: { files: { type: 'array' } }, required: ['files'] }";
	// The child ends twice without calling StructuredOutput.
	const prose = [ev.session(), ev.assistant("prose"), ev.turnEnd(), ev.settled()];
	const unmet = await foreground({ lines: prose, reply: [ev.assistant("still prose"), ev.turnEnd(), ev.settled()] });
	const thrown = await script(
		unmet.t,
		`await agent('list', { label: 'lister', schema: ${SCHEMA} });\nreturn 'not reached';`,
	);
	assert.equal(thrown.r.isError, true);
	assert.match(thrown.text, /agent "lister" failed: the agent ended without structured output/);
	assert.doesNotMatch(thrown.text, /not reached/);
	const broke = await foreground({ lines: failing });
	const nulled = await script(
		broke.t,
		`return 'value=' + JSON.stringify(await agent('list', { schema: ${SCHEMA} }));`,
	);
	assert.match(nulled.text, /value=null/);
});

test("parallel() and pipeline(): results in order, null for a failed one; the script goes on", async () => {
	const { t } = await foreground({
		lines: ok("?"),
		byPrompt: { "item b": failing, "item a": ok("A"), "item c": ok("C"), "task 1": ok("one"), "task 2": failing },
	});
	const { text } = await script(
		t,
		`const p = await pipeline(['a', 'b', 'c'], (x, i) => agent('item ' + x).then((o) => (o === null ? null : o + i)));
const q = await parallel([() => agent('task 1'), agent('task 2'), Promise.resolve(7), () => { throw new Error('sync') }]);
return JSON.stringify({ p, q });`,
	);
	assert.match(text, /\{"p":\["A0",null,"C2"\],"q":\["one",null,7,null\]\}/, text);
});

test("pipeline(): at most 4096 items; wrong arguments throw", async () => {
	const { t } = await foreground({ lines: ok("x") });
	const cases: [string, RegExp][] = [
		["return await pipeline(new Array(4097).fill(1), (x) => x)", /at most 4096 items, got 4097/],
		["return await pipeline('abc', (x) => x)", /expects an array of items/],
		["return await pipeline([1], 'f')", /expects a function/],
		["return await parallel(5)", /expects an array of functions or promises/],
		["return await parallel(new Array(4097).fill(1))", /parallel\(\) takes at most 4096 tasks, got 4097/],
		["return await agent('')", /expects a prompt string/],
		["return await phase('')", /expects a title/],
	];
	for (const [code, error] of cases) {
		const { r, text } = await script(t, code);
		assert.equal(r.isError, true, code);
		assert.match(text, error, code);
	}
	const { text } = await script(
		t,
		"return await pipeline(new Array(4096).fill(1), (x) => x * 2).then((r) => r.length)",
	);
	assert.match(text, /4096/);
});

test("args is undefined in an ad hoc script; line numbers are the script's own", async () => {
	const { t } = await foreground({ lines: ok("x") });
	assert.match((await script(t, "return typeof args")).text, /undefined/);
	const { text } = await script(t, "const a = 1;\nconst b = 2;\nthrow new Error('line three');");
	assert.match(text, /line three/);
	assert.match(text, /:3:/, text);
});

test("no Agent tool, no helpers: a script without it sees none of them", async () => {
	const s = sandbox();
	s.scenario({ lines: ok("x") });
	const t = await loadTool({ backgroundScripts: false }, { cwd: s.repo });
	const other = {
		name: "echo",
		label: "echo",
		description: "d",
		parameters: { type: "object" },
		execute: async () => ({ content: [] }),
	};
	const bare = { ...t, registered: false };
	const { text } = await script(bare as any, "return [typeof agent, typeof pipeline, typeof log].join(',')", [other]);
	assert.match(text, /undefined,undefined,undefined/);
});

test("phase() and log(): the script's row records each agent's phase and the latest log line", async () => {
	const s = sandbox();
	s.scenario({ lines: ok("x") });
	const t = await loadTool({}, { cwd: s.repo, sessionId: "helpers-phase" });
	const { r } = await script(
		t,
		`log('starting');
phase('find');
await agent('first');
await phase('fix', async () => { await parallel([() => agent('second'), () => agent('third')]); });
await tools.Agent({ description: 'plain', prompt: 'fourth' });
log('all done');
return 'ok';`,
	);
	assert.equal((r.details as any).background, true, "the first agent() moved it to the background");
	for (let i = 0; i < 300 && t.messages.length === 0; i++) await new Promise((res) => setTimeout(res, 20));
	assert.match(t.messages[0].message.content as string, /completed/);
	const row = scripts.list("helpers-phase")[0];
	assert.equal(row.agents.length, 4);
	assert.deepEqual(
		row.agents.map((a) => row.phases[a]),
		["find", "fix", "fix", "fix"],
		"a plain tools.Agent call belongs to the current phase too",
	);
	assert.equal(row.phase, "fix");
	assert.equal(row.log, "all done");
});

test("cap: past subagent.maxAgentsPerScript the next Agent call throws (null in a pipeline)", async () => {
	const { t } = await foreground({ lines: ok("x") }, { maxAgentsPerScript: 2 });
	const { text } = await script(
		t,
		"const r = await pipeline([1, 2, 3], (i) => agent('n' + i));\nreturn JSON.stringify(r.map((x) => x === null ? null : 'ok'));",
	);
	assert.match(text, /\["ok","ok",null\]/, text);
	const direct = await script(t, "await agent('a'); await agent('b'); await agent('c');");
	assert.equal(direct.r.isError, true);
	assert.match(direct.text, /already started 2 agents.*subagent\.maxAgentsPerScript/);
	await assert.rejects(
		loadTool({ maxAgentsPerScript: 0 }, { cwd: sandbox().repo }),
		/maxAgentsPerScript must be a positive integer/,
	);
});

test("add-ons: a prelude must be one line, so a script's line numbers never move", async () => {
	const { codemodeAddons } = await import("../../../src/extensions/codemode/addons.ts");
	assert.throws(
		() => codemodeAddons.register({ name: "two-lines", applies: () => true, prelude: "a;\nb;" }),
		/the prelude must be one line/,
	);
	assert.deepEqual(
		codemodeAddons.for(["read"]).map((a) => a.name),
		[],
		"the helpers need Agent",
	);
	assert.deepEqual(
		codemodeAddons.for(["Agent"]).map((a) => a.name),
		["subagent-helpers"],
	);
});
