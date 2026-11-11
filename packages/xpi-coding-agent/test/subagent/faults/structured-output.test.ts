// `schema` on an Agent call: the child returns its result through StructuredOutput (fake children; the real tool runs
// in test/subagent/real/).
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { STRUCTURED_OUTPUT_TOOL } from "../../../src/extensions/subagent/resolve.ts";
import {
	checkSchema,
	registerStructuredOutput,
	SCHEMA_FILE_ENV,
	STRUCTURED_REMINDER,
} from "../../../src/extensions/subagent/structured-output.ts";
import { agentFile, ev, flag, loadTool, sandbox } from "../helpers.ts";

const SCHEMA = {
	type: "object",
	properties: { files: { type: "array", items: { type: "string" } }, summary: { type: "string" } },
	required: ["files", "summary"],
};
const VALUE = { files: ["src/a.ts", "src/b.ts"], summary: "two files" };

const accepted = (value: unknown = VALUE) => [
	ev.assistant(""),
	ev.tool(STRUCTURED_OUTPUT_TOOL),
	ev.toolEnd(STRUCTURED_OUTPUT_TOOL, value),
	ev.turnEnd({ stopReason: "toolUse" }),
	ev.settled(),
];
const invalid = () => [
	ev.tool(STRUCTURED_OUTPUT_TOOL),
	ev.toolEnd(STRUCTURED_OUTPUT_TOOL, {}, true, "Validation failed for tool: files is required"),
	ev.turnEnd({ stopReason: "toolUse" }),
];

test("schema: the accepted call is the result: `structured` holds it, `output` is its JSON text", async () => {
	const s = sandbox();
	s.scenario({ lines: [ev.session(), ...accepted()] });
	const t = await loadTool({}, { cwd: s.repo });
	const r = (await t.run({ schema: SCHEMA })).structuredContent;
	assert.equal(r.status, "completed");
	assert.deepEqual(r.structured, VALUE);
	assert.equal(r.output, JSON.stringify(VALUE, null, 2));
	const rec = s.record();
	assert.deepEqual(JSON.parse(rec.schema!), SCHEMA, "the child got the schema");
	assert.equal(flag(rec.argv, "--tools"), "+codemode,+StructuredOutput");
	assert.match(rec.systemPromptTail!, /Finish by calling the `StructuredOutput` tool/);
	assert.doesNotMatch(rec.systemPrompt!, /StructuredOutput/, "the shared head does not change");
});

test("schema: without one nothing changes: no tool, no line, no structured", async () => {
	const s = sandbox();
	s.scenario({ lines: [ev.session(), ev.assistant("plain"), ev.turnEnd(), ev.settled()] });
	const t = await loadTool({}, { cwd: s.repo });
	const r = (await t.run({})).structuredContent;
	assert.equal(r.status, "completed");
	assert.equal(r.output, "plain");
	assert.equal(r.structured, undefined);
	const rec = s.record();
	assert.equal(rec.schema, undefined);
	assert.equal(flag(rec.argv, "--tools"), "+codemode");
	assert.doesNotMatch(rec.systemPromptTail!, /StructuredOutput/);
});

test("schema: the tool joins an agent's own tool list, and a direct-tools agent gets it added", async () => {
	const s = sandbox();
	s.write(join(s.repo, ".pi/agents/reader.md"), agentFile("name: reader\ndescription: d\ntools: Read, Grep"));
	s.write(join(s.repo, ".pi/agents/direct.md"), agentFile("name: direct\ndescription: d\ncodemode: false"));
	s.scenario({ lines: [ev.session(), ...accepted()] });
	const t = await loadTool({}, { cwd: s.repo });
	await t.run({ subagent_type: "reader", schema: SCHEMA });
	assert.equal(flag(s.record().argv, "--tools"), "codemode,read,grep,StructuredOutput");
	await t.run({ subagent_type: "direct", schema: SCHEMA });
	assert.equal(flag(s.record().argv, "--tools"), "-codemode,+StructuredOutput");
});

test("schema: invalid calls go back to the model; a later valid one is the result", async () => {
	const s = sandbox();
	s.scenario({ lines: [ev.session(), ...invalid(), ...invalid(), ...accepted()] });
	const t = await loadTool({}, { cwd: s.repo });
	const r = (await t.run({ schema: SCHEMA })).structuredContent;
	assert.equal(r.status, "completed");
	assert.deepEqual(r.structured, VALUE);
});

test("schema: 5 invalid calls fail the call with the last validation error, and stop the child", async () => {
	const s = sandbox();
	s.scenario({
		lines: [ev.session(), ...invalid(), ...invalid(), ...invalid(), ...invalid(), ...invalid()],
		hang: true,
		abortSettles: true,
	});
	const t = await loadTool({}, { cwd: s.repo });
	const r = (await t.run({ schema: SCHEMA })).structuredContent;
	assert.equal(r.status, "failed");
	assert.equal(
		r.error,
		"structured output did not match the schema after 5 attempts: Validation failed for tool: files is required",
	);
	assert.equal(r.structured, undefined);
	assert.ok(
		s.record().commands.some((c) => c.type === "abort"),
		"the child was stopped",
	);
});

test("schema: a child that ends without the call is reminded once and its answer is the result", async () => {
	const s = sandbox();
	s.scenario({
		lines: [ev.session(), ev.assistant("here is prose"), ev.turnEnd(), ev.settled()],
		reply: accepted(),
	});
	const t = await loadTool({}, { cwd: s.repo });
	const r = (await t.run({ schema: SCHEMA })).structuredContent;
	assert.equal(r.status, "completed");
	assert.deepEqual(r.structured, VALUE);
	const prompts = s.record().commands.filter((c) => c.type === "prompt");
	assert.deepEqual(
		prompts.map((c) => c.message),
		["do it", STRUCTURED_REMINDER],
	);
});

test("schema: a child that ends twice without the call fails; `output` keeps its last text", async () => {
	const s = sandbox();
	s.scenario({
		lines: [ev.session(), ev.assistant("here is prose"), ev.turnEnd(), ev.settled()],
		reply: [ev.assistant("still prose"), ev.turnEnd(), ev.settled()],
	});
	const t = await loadTool({}, { cwd: s.repo });
	const r = (await t.run({ schema: SCHEMA })).structuredContent;
	assert.equal(r.status, "failed");
	assert.equal(r.error, "the agent ended without structured output");
	assert.equal(r.output, "still prose");
	assert.equal(s.record().commands.filter((c) => c.type === "prompt").length, 2, "reminded once only");
});

test("schema: maxTurns first gives partial without structured, and no reminder", async () => {
	const s = sandbox();
	s.write(join(s.repo, ".pi/agents/short.md"), agentFile("name: short\ndescription: d\nmaxTurns: 1"));
	s.scenario({
		lines: [ev.session(), ev.assistant("thinking"), ev.tool("read"), ev.turnEnd({ stopReason: "toolUse" })],
		hang: true,
		abortSettles: true,
	});
	const t = await loadTool({}, { cwd: s.repo });
	const r = (await t.run({ subagent_type: "short", schema: SCHEMA })).structuredContent;
	assert.equal(r.status, "partial");
	assert.equal(r.structured, undefined);
	assert.equal(s.record().commands.filter((c) => c.type === "prompt").length, 1);
});

test("schema: a valid call in the last allowed turn is a completed result, not partial", async () => {
	const s = sandbox();
	s.write(join(s.repo, ".pi/agents/short.md"), agentFile("name: short\ndescription: d\nmaxTurns: 1"));
	s.scenario({ lines: [ev.session(), ...accepted()] });
	const t = await loadTool({}, { cwd: s.repo });
	const r = (await t.run({ subagent_type: "short", schema: SCHEMA })).structuredContent;
	assert.equal(r.status, "completed");
	assert.deepEqual(r.structured, VALUE);
});

test("schema: a schema no value could match throws before a child starts", async () => {
	const s = sandbox();
	s.scenario({ lines: [ev.session(), ...accepted()] });
	const t = await loadTool({}, { cwd: s.repo });
	const cases: [unknown, RegExp][] = [
		[[], /schema must be a JSON Schema object/],
		[{ type: "array" }, /type "object" at the top/],
		[{ type: "object", properties: 5 }, /properties must be an object of schemas/],
		[{ type: "object", required: "files" }, /required must be a list/],
		[
			{ type: "object", additionalProperties: false, properties: { a: {} }, required: ["a", "b"] },
			/requires "b", which additionalProperties: false rules out/,
		],
	];
	for (const [schema, error] of cases) await assert.rejects(t.run({ schema }), error);
	assert.doesNotThrow(() => checkSchema(SCHEMA));
});

test("schema: a background agent's end message carries the JSON text", async () => {
	const s = sandbox();
	s.scenario({ lines: [ev.session(), ...accepted()] });
	const t = await loadTool({}, { cwd: s.repo });
	const started = (await t.run({ schema: SCHEMA, run_in_background: true })).structuredContent;
	assert.equal(started.status, "running");
	for (let i = 0; i < 200 && t.messages.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
	const message = t.messages[0].message.content as string;
	assert.match(message, /completed/);
	assert.ok(message.includes(JSON.stringify(VALUE, null, 2)), message);
});

test("schema: a resume may pass a schema; it applies to that call only", async () => {
	const s = sandbox();
	s.scenario({ lines: [ev.session(), ev.assistant("first"), ev.turnEnd(), ev.settled()] });
	const sessionFile = join(s.root, "parent.jsonl");
	const t = await loadTool({}, { cwd: s.repo, sessionFile });
	const first = (await t.run({})).structuredContent;
	s.scenario({ lines: [ev.session(), ...accepted()] });
	const second = (await t.run({ resume: first.agentId, schema: SCHEMA })).structuredContent;
	assert.deepEqual(second.structured, VALUE);
	s.scenario({ lines: [ev.session(), ev.assistant("third"), ev.turnEnd(), ev.settled()] });
	const third = (await t.run({ resume: first.agentId })).structuredContent;
	assert.equal(third.status, "completed");
	assert.equal(third.output, "third");
	assert.equal(s.record().schema, undefined);
});

test("child side: the tool is registered only with a schema file, model-only, and ends the run", async () => {
	const tools: any[] = [];
	const pi = { registerTool: (t: any) => tools.push(t) } as any;
	delete process.env[SCHEMA_FILE_ENV];
	registerStructuredOutput(pi);
	assert.equal(tools.length, 0);
	const file = join(mkdtempSync(join(tmpdir(), "structured-")), "schema.json");
	writeFileSync(file, JSON.stringify(SCHEMA));
	process.env[SCHEMA_FILE_ENV] = file;
	try {
		registerStructuredOutput(pi);
	} finally {
		delete process.env[SCHEMA_FILE_ENV];
	}
	assert.equal(tools.length, 1);
	assert.equal(tools[0].name, STRUCTURED_OUTPUT_TOOL);
	assert.equal(tools[0].exposure, "model-only");
	assert.deepEqual(tools[0].parameters, SCHEMA);
	const result = await tools[0].execute("id", VALUE);
	assert.equal(result.terminate, true);
	assert.deepEqual(result.details, VALUE);
});
