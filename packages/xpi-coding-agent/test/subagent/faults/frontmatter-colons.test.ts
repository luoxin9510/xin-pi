// Agent files whose description holds ": " load the way Claude Code loads them (no model, no child).
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDefinition } from "../../../src/extensions/subagent/definition.ts";
import { agentFile } from "../helpers.ts";

const parse = (fields: string) => parseDefinition("x.md", agentFile(fields));

test("a plain description with ': ' is read as one string", () => {
	const r = parse("name: x\ndescription: Read-only search: finds code, returns paths\ntools: Read, Grep");
	assert.ok(r.ok, r.ok ? "" : r.reason);
	assert.equal(r.def.description, "Read-only search: finds code, returns paths");
	assert.deepEqual(r.def.tools, ["Read", "Grep"]);
});

test("a quoted value and a value without ': ' are kept as written", () => {
	const r = parse("name: x\ndescription: 'Use when: asked'\nmodel: haiku");
	assert.ok(r.ok, r.ok ? "" : r.reason);
	assert.equal(r.def.description, "Use when: asked");
	assert.equal(r.def.model, "haiku");
});

test("YAML that is broken for another reason still skips the file with the parser's message", () => {
	const r = parse("name: x\ndescription: d\ntools: [Read, Grep");
	assert.ok(!r.ok);
	assert.match(r.reason, /^invalid YAML: /);
});

test("a trailing ' #' comment on such a value stays a comment", () => {
	const r = parse("name: x\ndescription: Use when: fixing bugs # see the wiki");
	assert.ok(r.ok, r.ok ? "" : r.reason);
	assert.equal(r.def.description, "Use when: fixing bugs");
});
