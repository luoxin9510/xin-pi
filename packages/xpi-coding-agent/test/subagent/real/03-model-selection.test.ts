// Ticket 03: model selection. Cases that can run on haiku run for real and read the model off the child's session.
// Cases that name models we do not want to pay for (or that do not exist) point piCommand at a missing binary: the run
// fails before any child starts, and the result still reports the model the extension picked.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { agentFile, childSetup, loadTool, REPLY_OK, sandbox } from "./helpers.ts";

const PARENT = { provider: "openai", id: "gpt-x" };

function agents(s: ReturnType<typeof sandbox>) {
	for (const m of ["opus", "fable", "haiku", "inherit", "google/gemini-9"]) {
		s.write(
			join(s.repo, `.pi/agents/${m.replace("/", "-")}.md`),
			agentFile(`name: m-${m.replace("/", "-")}\ndescription: d\nmodel: ${m}`),
		);
	}
	s.write(join(s.repo, ".pi/agents/effort.md"), agentFile("name: effortful\ndescription: d\neffort: low"));
}

// Real children.
async function real(
	settings: Record<string, unknown> = {},
	parent: typeof PARENT | null = PARENT,
	thinkingLevel = "medium",
) {
	const s = sandbox();
	agents(s);
	const t = await loadTool(settings, {
		cwd: s.repo,
		model: parent ?? undefined,
		thinkingLevel,
		persist: join(s.root, "sessions"),
	});
	return {
		async run(params: Record<string, unknown>) {
			const r = await t.result({ prompt: REPLY_OK, ...params });
			assert.equal(r.status, "completed", r.error ?? "");
			const c = childSetup(t.sessionDir!, r.agentId);
			return { model: r.model, ran: c.model, thinking: c.thinking };
		},
	};
}

// No child starts: only the model choice is observed.
async function pick(settings: Record<string, unknown> = {}, parent: typeof PARENT | null = PARENT) {
	const s = sandbox();
	agents(s);
	const t = await loadTool(
		{ ...settings, piCommand: join(s.root, "no-such-pi") },
		{ cwd: s.repo, model: parent ?? undefined },
	);
	return async (params: Record<string, unknown>) => (await t.result(params)).model;
}

test("nothing set: haiku, never the parent model; built-ins too", async () => {
	const { run } = await real();
	const types = ["general-purpose", "Explore", "Plan"];
	const runs = await Promise.all(types.map((type) => run({ subagent_type: type })));
	assert.deepEqual(
		runs.map((r) => r.model),
		types.map(() => "anthropic/claude-haiku-5-5"),
	);
	assert.deepEqual(
		runs.map((r) => r.ran),
		types.map(() => "anthropic/claude-haiku-5-5"),
	);
});

test("a call model beats the definition's, which beats defaultModel (each spelling resolves to haiku, so the choice shows in result.model)", async () => {
	const { run } = await real({ defaultModel: "sonnet", models: { sonnet: "claude-haiku-5-5", opus: "haiku-5-5" } });
	const [fallback, definition, call] = await Promise.all([
		run({}),
		run({ subagent_type: "m-opus" }),
		run({ subagent_type: "m-opus", model: "haiku" }),
	]);
	assert.equal(fallback.model, "claude-haiku-5-5", "defaultModel");
	assert.equal(definition.model, "haiku-5-5", "definition beats default");
	assert.equal(call.model, "anthropic/claude-haiku-5-5", "call beats definition");
	for (const r of [fallback, definition, call])
		assert.equal(r.ran, "anthropic/claude-haiku-5-5", "the child ran on the chosen model");
});

test("order: call > definition > defaultModel; aliases map to same-name Anthropic models", async () => {
	const model = await pick({ defaultModel: "sonnet" });
	assert.equal(await model({}), "anthropic/claude-sonnet-5-5", "settings default");
	assert.equal(await model({ subagent_type: "m-opus" }), "anthropic/claude-opus-5-5", "definition beats default");
	assert.equal(await model({ subagent_type: "m-fable" }), "anthropic/claude-fable-5-1");
	assert.equal(
		await model({ subagent_type: "m-opus", model: "haiku" }),
		"anthropic/claude-haiku-5-5",
		"call beats definition",
	);
	assert.equal(await model({ subagent_type: "m-google-gemini-9" }), "google/gemini-9", "full ids pass through");
});

test("a settings override changes only that alias", async () => {
	const model = await pick({ models: { haiku: "deepseek/flash" } });
	assert.equal(await model({}), "deepseek/flash");
	assert.equal(await model({ model: "opus" }), "anthropic/claude-opus-5-5");
});

test("inherit in the call, the definition or defaultModel uses the parent model", async () => {
	assert.equal(await (await pick())({ model: "inherit" }), "openai/gpt-x");
	assert.equal(await (await pick())({ subagent_type: "m-inherit" }), "openai/gpt-x");
	assert.equal(await (await pick({ defaultModel: "inherit" }))({}), "openai/gpt-x");
});

test("inherit without a parent model throws", async () => {
	const model = await pick({}, null);
	await assert.rejects(model({ model: "inherit" }), /no model to inherit/);
	assert.equal(await model({}), "anthropic/claude-haiku-5-5", "the default does not need a parent model");
});

test("thinking: call effort > definition effort > parent thinking level", async () => {
	const { run } = await real();
	const [parent, def, call] = await Promise.all([
		run({}),
		run({ subagent_type: "effortful" }),
		run({ subagent_type: "effortful", effort: "high" }),
	]);
	assert.equal(parent.thinking, "medium");
	assert.equal(def.thinking, "low");
	assert.equal(call.thinking, "high");
});
