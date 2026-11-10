// Alias lookup for subagent models: `subagent.models`, then the shared `models` setting, then the built-in aliases.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_MODEL_ALIASES } from "../../../src/core/model-aliases.ts";
import { readConfig } from "../../../src/extensions/subagent/config.ts";

test("subagent.models wins over the shared models setting", () => {
	const config = readConfig({ models: { fast: "p/sub" } }, { fast: "p/shared" });
	assert.equal(config.models.fast, "p/sub");
});

test("the shared models setting is used when subagent.models has no entry, and beats the built-in alias", () => {
	const config = readConfig({ models: { other: "p/other" } }, { haiku: "p/shared-haiku", judge: "p/judge" });
	assert.equal(config.models.judge, "p/judge");
	assert.equal(config.models.haiku, "p/shared-haiku");
	assert.equal(config.models.other, "p/other");
	assert.equal(config.models.opus, DEFAULT_MODEL_ALIASES.opus);
});

test("existing settings (no shared models) keep working", () => {
	const config = readConfig({ models: { haiku: "p/mine" } });
	assert.equal(config.models.haiku, "p/mine");
	assert.equal(config.models.sonnet, DEFAULT_MODEL_ALIASES.sonnet);
});

test("a bad shared models setting names the key", () => {
	assert.throws(() => readConfig(undefined, { fast: 3 }), /models\.fast must be a string/);
});
