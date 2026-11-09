// The agent file field `isolation` (no model, no child).
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDefinition } from "../../../src/extensions/subagent/definition.ts";
import { agentFile } from "../helpers.ts";

const parse = (fields: string) => parseDefinition("x.md", agentFile(`name: x\ndescription: d\n${fields}`));

test("isolation: worktree is parsed and is no longer an inert field", () => {
	const r = parse("isolation: worktree\nhooks: {}");
	assert.ok(r.ok);
	assert.equal(r.def.isolation, "worktree");
	assert.deepEqual(r.def.inert, ["hooks"]);
});

test("without isolation the definition has none; any other value skips the file naming the field", () => {
	const none = parse("");
	assert.ok(none.ok && none.def.isolation === undefined);
	const bad = parse("isolation: remote");
	assert.ok(!bad.ok);
	assert.match(bad.reason, /"isolation" must be worktree/);
});
