// Saving a script as a workflow (spec 02, `s` in the panel): the source comes from the codemode call in the session,
// the file gets a `meta` statement and loads as a workflow; an existing file is replaced only after a confirm.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { ScriptRecord } from "../../../src/extensions/subagent/background.ts";
import { saveScriptAsWorkflow, scriptSource, workflowFile } from "../../../src/extensions/subagent/workflow-save.ts";
import { discoverWorkflows } from "../../../src/extensions/subagent/workflows.ts";
import { sandbox } from "../helpers.ts";

const CODE = "// @options: {\"timeout_ms\": 60000}\nconst r = await agent('count files');\nreturn r;";

const record = (extra: Partial<ScriptRecord> = {}): ScriptRecord => ({
	id: "S7",
	callId: "call-7",
	sessionId: "p",
	state: "completed",
	stopRequested: false,
	pinned: false,
	agents: [],
	phases: {},
	calls: [],
	logs: [],
	startedAt: 0,
	...extra,
});

function ctx(cwd: string, answers: { input?: (string | undefined)[]; select?: number; confirm?: boolean }) {
	const notes: string[] = [];
	const asked: string[] = [];
	const inputs = [...(answers.input ?? [])];
	return {
		notes,
		asked,
		ctx: {
			cwd,
			sessionManager: {
				getBranch: () => [
					{ type: "message", message: { role: "user", content: "go" } },
					{
						type: "message",
						message: {
							role: "assistant",
							content: [
								{ type: "text", text: "running it" },
								{ type: "toolCall", id: "call-7", name: "codemode", arguments: { code: CODE } },
							],
						},
					},
				],
			},
			ui: {
				notify: (m: string) => notes.push(m),
				input: async (title: string) => (asked.push(title), inputs.shift()),
				select: async (title: string, options: string[]) => (asked.push(title), options[answers.select ?? 0]),
				confirm: async (title: string) => (asked.push(title), answers.confirm ?? false),
			},
		} as any,
	};
}

test("the file: meta first (quoted safely), then the script; it loads as a workflow", () => {
	const text = workflowFile("count", 'Count "files"\nfast', "return 1");
	assert.match(
		text,
		/^export const meta = \{\n {2}name: "count",\n {2}description: "Count \\"files\\"\\nfast",\n\}\n\nreturn 1\n$/,
	);
	assert.throws(() => workflowFile("count", "d", "import fs from 'node:fs'"), /cannot import/);
});

test("the source is the codemode call's code on the branch, without its @options line", () => {
	const { ctx: c } = ctx("/tmp", {});
	assert.equal(scriptSource(c, "call-7"), "const r = await agent('count files');\nreturn r;");
	assert.equal(scriptSource(c, "call-8"), undefined);
});

test("save: asks name, description and where; writes a workflow that discovery finds", async () => {
	const s = sandbox();
	const { ctx: c, asked, notes } = ctx(s.repo, { input: ["count", "Count the files"] });
	const path = await saveScriptAsWorkflow(c, record());
	assert.equal(path, join(s.repo, ".pi/workflows/count.js"));
	assert.deepEqual(asked, ["Save script as workflow: name", "Description", "Save where?"]);
	assert.match(notes.at(-1)!, /saved .*count\.js; run it with \/count/);
	const found = discoverWorkflows(s.repo, true, join(s.root, "agent")).workflows.get("count");
	assert.equal(found?.meta.description, "Count the files");
	assert.match(found!.body, /await agent\('count files'\)/);
});

test("save: an existing file is replaced only after a confirm; bad names and workflow runs are refused", async () => {
	const s = sandbox();
	s.write(join(s.repo, ".pi/workflows/count.js"), "old");
	const no = ctx(s.repo, { input: ["count", "Count"], confirm: false });
	assert.equal(await saveScriptAsWorkflow(no.ctx, record()), undefined);
	assert.equal(readFileSync(join(s.repo, ".pi/workflows/count.js"), "utf8"), "old");
	assert.equal(no.asked.at(-1), "Overwrite?");
	const yes = ctx(s.repo, { input: ["count", "Count"], confirm: true });
	assert.ok(await saveScriptAsWorkflow(yes.ctx, record()));
	assert.match(readFileSync(join(s.repo, ".pi/workflows/count.js"), "utf8"), /^export const meta/);

	const bad = ctx(s.repo, { input: ["Count Files"] });
	assert.equal(await saveScriptAsWorkflow(bad.ctx, record()), undefined);
	assert.match(bad.notes.at(-1)!, /lowercase letters, digits and dashes/);
	const cancelled = ctx(s.repo, { input: [undefined] });
	assert.equal(await saveScriptAsWorkflow(cancelled.ctx, record()), undefined);
	const run = ctx(s.repo, {});
	assert.equal(await saveScriptAsWorkflow(run.ctx, record({ workflow: "audit" })), undefined);
	assert.match(run.notes.at(-1)!, /runs the saved workflow audit/);
	const lost = ctx(s.repo, {});
	assert.equal(await saveScriptAsWorkflow(lost.ctx, record({ callId: "gone" })), undefined);
	assert.match(lost.notes.at(-1)!, /not in this session/);
	assert.equal(existsSync(join(s.repo, ".pi/workflows/count-files.js")), false);
});
