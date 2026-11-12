// Saved workflows (spec 02): the file format, discovery, the /name commands, and a real xpi process running one with
// fake children (no model: a workflow starts without a model turn).
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { endMessage } from "../../../src/extensions/subagent/background.ts";
import { workflowOf } from "../../../src/extensions/subagent/workflow-run.ts";
import {
	discoverWorkflows,
	parseArgs,
	parseWorkflow,
	type Workflow,
} from "../../../src/extensions/subagent/workflows.ts";
import { ev, FAKE_PI, loadTool, sandbox } from "../helpers.ts";

const CLI = fileURLToPath(new URL("../../../src/cli.ts", import.meta.url));

const file = (name: string, body: string, description = "Demo workflow") =>
	`export const meta = {\n  name: '${name}',\n  description: '${description}',\n}\n${body}`;

// The built-in workflows (review) are found in every discovery; these tests look at the files they wrote.
const withoutBuiltin = (found: Map<string, Workflow>) =>
	new Map([...found].filter(([, workflow]) => workflow.source !== "builtin"));

test("format: Claude Code's documented example parses; the body keeps the file's line numbers", () => {
	const text = `export const meta = {
  name: 'audit-routes',
  description: 'Audit every route handler for missing auth checks',
}

const found = await agent('List every .ts file under src/routes/.', {
  schema: { type: 'object', required: ['files'], properties: { files: { type: 'array', items: { type: 'string' } } } },
})

return audits.filter(Boolean)
`;
	const { meta, body } = parseWorkflow(text, "audit-routes");
	assert.deepEqual(meta, { name: "audit-routes", description: "Audit every route handler for missing auth checks" });
	assert.equal(body.split("\n")[5], text.split("\n")[5], "line 6 is line 6");
	assert.doesNotMatch(body, /export/);
});

test("format: meta takes quotes of any kind, bare keys, comments, trailing commas, and phases", () => {
	const { meta } = parseWorkflow(
		`// a leading comment\nexport const meta = { "name": "x", description: \`d\`, phases: ['find', "fix",], /* c */ };\nreturn 1`,
		"x",
	);
	assert.deepEqual(meta, { name: "x", description: "d", phases: ["find", "fix"] });
});

test("format: what is not a workflow is refused with the reason", () => {
	const cases: [string, string, RegExp][] = [
		["return 1", "x", /first statement must be/],
		[`export const meta = { name: 'x', description: \`a$\{1}\` }`, "x", /template expressions/],
		["export const meta = { name: 'x', description: 'd', run: go() }", "x", /plain value/],
		["export const meta = { name: 'y', description: 'd' }", "x", /differs from the file name/],
		["export const meta = { name: 'X', description: 'd' }", "X", /lowercase/],
		["export const meta = { name: 'x' }", "x", /description must be a non-empty string/],
		["export const meta = { name: 'x', description: 'd', phases: 'a' }", "x", /phases must be a list/],
		["export const meta = { name: 'x', description: 'd' }\nimport fs from 'node:fs'", "x", /cannot import/],
		["export const meta = { name: 'x', description: 'd' }\nconst m = await import('fs')", "x", /cannot import/],
	];
	for (const [text, name, error] of cases) assert.throws(() => parseWorkflow(text, name), error, text);
	assert.doesNotThrow(() =>
		parseWorkflow("export const meta = { name: 'x', description: 'd' }\nconst important = 1", "x"),
	);
});

test("args: JSON when it parses, else the text, undefined when empty", () => {
	assert.equal(parseArgs("  "), undefined);
	assert.equal(parseArgs("issues 1024 and 1025"), "issues 1024 and 1025");
	assert.deepEqual(parseArgs('{"issues":[1024,1025]}'), { issues: [1024, 1025] });
	assert.equal(parseArgs("42"), 42);
});

test("discovery: Claude Code's directories are read too, below the .pi ones of the same level", () => {
	const s = sandbox();
	const agentDir = join(s.root, "agent");
	const claudeDir = join(s.root, "claude");
	const sub = join(s.repo, "pkg");
	s.write(join(s.repo, ".pi/workflows/both.js"), file("both", "return 'pi project'"));
	s.write(join(sub, ".claude/workflows/both.js"), file("both", "return 'claude project, closer'"));
	s.write(join(s.repo, ".claude/workflows/far.js"), file("far", "return 'repo root'"));
	s.write(join(sub, ".claude/workflows/far.js"), file("far", "return 'closest'"));
	s.write(join(agentDir, "workflows/mine.js"), file("mine", "return 'pi user'"));
	s.write(join(claudeDir, "workflows/mine.js"), file("mine", "return 'claude user'"));
	s.write(join(claudeDir, "workflows/theirs.js"), file("theirs", "return 'claude user only'"));
	s.write(join(s.repo, ".claude/workflows/shadow.js"), file("shadow", "return 'project'"));
	s.write(join(agentDir, "workflows/shadow.js"), file("shadow", "return 'user'"));
	const found = withoutBuiltin(discoverWorkflows(sub, true, agentDir, claudeDir).workflows);
	const body = (name: string) => found.get(name)!.body.trim();
	assert.deepEqual([...found.keys()].sort(), ["both", "far", "mine", "shadow", "theirs"]);
	assert.equal(body("both"), "return 'pi project'", ".pi comes before .claude, whatever the distance");
	assert.equal(body("far"), "return 'closest'", "among .claude directories the closest wins");
	assert.equal(body("mine"), "return 'pi user'");
	assert.equal(body("theirs"), "return 'claude user only'");
	assert.equal(found.get("theirs")!.source, "user");
	assert.equal(body("shadow"), "return 'project'", "a project workflow hides a user one");
	const untrusted = withoutBuiltin(discoverWorkflows(sub, false, agentDir, claudeDir).workflows);
	assert.deepEqual([...untrusted.keys()].sort(), ["mine", "shadow", "theirs"]);
	assert.equal(untrusted.get("shadow")!.body.trim(), "return 'user'");
});

test("discovery: project workflows (closest wins) before the user's; untrusted projects only get the user's", () => {
	const s = sandbox();
	const agentDir = join(s.root, "agent");
	const sub = join(s.repo, "pkg");
	s.write(join(s.repo, ".pi/workflows/shared.js"), file("shared", "return 'repo'"));
	s.write(join(s.repo, ".pi/workflows/root-only.js"), file("root-only", "return 1"));
	s.write(join(sub, ".pi/workflows/shared.js"), file("shared", "return 'pkg'"));
	s.write(join(agentDir, "workflows/shared.js"), file("shared", "return 'user'"));
	s.write(join(agentDir, "workflows/mine.js"), file("mine", "return 1"));
	s.write(join(agentDir, "workflows/notes.md"), "not a workflow");
	s.write(join(agentDir, "workflows/broken.js"), "return 1");
	const trusted = discoverWorkflows(sub, true, agentDir);
	trusted.workflows = withoutBuiltin(trusted.workflows);
	assert.deepEqual([...trusted.workflows.keys()].sort(), ["mine", "root-only", "shared"]);
	assert.match(trusted.workflows.get("shared")!.body, /'pkg'/);
	assert.equal(trusted.workflows.get("shared")!.source, "project");
	assert.equal(trusted.workflows.get("mine")!.source, "user");
	assert.deepEqual(
		trusted.warnings.map((w) => w.replace(agentDir, "<agent>")),
		[
			"workflow <agent>/workflows/broken.js skipped: the first statement must be `export const meta = { name, description }`",
		],
	);
	const untrusted = discoverWorkflows(sub, false, agentDir);
	untrusted.workflows = withoutBuiltin(untrusted.workflows);
	assert.deepEqual(
		[...untrusted.workflows.keys()].sort(),
		["broken", "mine", "shared"].filter((n) => n !== "broken"),
	);
	assert.match(untrusted.workflows.get("shared")!.body, /'user'/);
});

test("commands: each workflow is a /name command; a name another command has is skipped with a warning", async () => {
	const s = sandbox();
	s.write(join(s.repo, ".pi/workflows/audit.js"), file("audit", "return 1"));
	s.write(join(s.repo, ".pi/workflows/model.js"), file("model", "return 1")); // a built-in command
	s.write(join(s.repo, ".pi/workflows/review.js"), file("review", "return 1")); // another extension's
	const t = await loadTool({}, { cwd: s.repo, otherCommands: ["review"] });
	assert.ok(t.commands.audit, "registered");
	assert.equal(t.commands.audit.description, "Demo workflow (workflow)");
	assert.equal(t.commands.model, undefined);
	assert.equal(t.commands.review, undefined);
	assert.ok(
		t.notes.some((n) => /workflows\/model\.js skipped: \/model is already a command/.test(n)),
		t.notes.join("\n"),
	);
	assert.ok(t.notes.some((n) => /workflows\/review\.js skipped: \/review is already a command/.test(n)));
});

test("end message and script rows name the workflow", () => {
	assert.equal(workflowOf("workflow:audit:k3j-1"), "audit");
	assert.equal(workflowOf("call-1"), undefined);
	const message = endMessage(
		{
			id: "S3",
			callId: "workflow:audit:x",
			workflow: "audit",
			sessionId: "p",
			state: "completed",
			stopRequested: false,
			pinned: false,
			agents: [],
			members: [],
			phases: {},
			calls: [],
			logs: [],
			startedAt: 0,
		},
		"completed",
		"ok",
		{ sessionFile: undefined, sessionId: "p" },
	);
	assert.match(message, /^Background script S3 \(workflow audit\) completed\./);
});

// The environment for a real xpi: no provider keys, so nothing can reach a model (a key in the developer's shell would
// otherwise answer the turn an end message starts).
const noKeys = (extra: Record<string, string>) => ({
	...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/(_API_KEY|_AUTH_TOKEN)$/.test(k))),
	XPI_SKIP_VERSION_CHECK: "1",
	XPI_TELEMETRY: "0",
	...extra,
});

// A real xpi (from source) in print mode: `/name args` runs the workflow in the foreground and prints its return value.
// The child is the fake pi, so no model is involved anywhere.
function xpi(
	cwd: string,
	agentDir: string,
	home: string,
	prompt: string,
): Promise<{ code: number; out: string; err: string }> {
	return new Promise((resolve) => {
		const child = execFile(
			process.execPath,
			["--experimental-strip-types", "--no-warnings", CLI, "--no-session", "--approve", "-p", prompt],
			{
				cwd,
				env: noKeys({ HOME: home, XPI_CODING_AGENT_DIR: agentDir }),
				timeout: 60_000,
			},
			(error, out, err) => resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, out, err }),
		);
		child.stdin?.end();
	});
}

test('run: `xpi -p "/name args"` runs the workflow\'s script, its Agent calls reach children, and prints the result', async () => {
	const s = sandbox();
	const agentDir = join(s.root, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ subagent: { piCommand: FAKE_PI } }));
	s.scenario({ lines: [ev.session(), ev.assistant("child says hi"), ev.turnEnd(), ev.settled()] });
	s.write(
		join(s.repo, ".pi/workflows/greet.js"),
		file(
			"greet",
			[
				"const r = await tools.Agent({ description: 'greet', prompt: 'hello ' + args.who, run_in_background: false });",
				"return 'status=' + r.status + ' output=' + r.output + ' args=' + JSON.stringify(args);",
			].join("\n"),
		),
	);
	const r = await xpi(s.repo, agentDir, s.home, '/greet {"who":"world"}');
	assert.equal(r.code, 0, r.err);
	assert.match(r.out, /status=completed output=child says hi args=\{"who":"world"\}/, r.out + r.err);
	const prompt = s.record().commands.find((c) => c.type === "prompt");
	assert.equal(prompt?.message, "hello world", "the child got the script's prompt");
});

test("run: a script error is printed with the file's line number", async () => {
	const s = sandbox();
	const agentDir = join(s.root, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ subagent: { piCommand: FAKE_PI } }));
	// meta takes lines 1-4; line 5 is blank; line 6 throws.
	s.write(join(s.repo, ".pi/workflows/boom.js"), file("boom", "\nthrow new Error('boom at six')"));
	const r = await xpi(s.repo, agentDir, s.home, "/boom");
	assert.match(r.out, /boom at six/, r.out + r.err);
	assert.match(r.out, /:6:/, r.out);
});

test("run with a UI (rpc mode): the workflow starts in the background at once and its end reaches main", async () => {
	const s = sandbox();
	const agentDir = join(s.root, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ subagent: { piCommand: FAKE_PI } }));
	s.scenario({ lines: [ev.session(), ev.assistant("child done"), ev.turnEnd(), ev.settled()], delayMs: 300 });
	s.write(
		join(s.repo, ".pi/workflows/greet.js"),
		file(
			"greet",
			"const r = await tools.Agent({ description: 'g', prompt: 'hi' });\nreturn 'workflow-done ' + r.status;",
		),
	);
	const child = spawn(
		process.execPath,
		["--experimental-strip-types", "--no-warnings", CLI, "--no-session", "--approve", "--mode", "rpc"],
		{ cwd: s.repo, env: noKeys({ HOME: s.home, XPI_CODING_AGENT_DIR: agentDir }) },
	);
	let out = "";
	child.stdout.on("data", (d: Buffer) => {
		out += d.toString();
	});
	child.stdin.write(`${JSON.stringify({ id: "1", type: "prompt", message: "/greet" })}\n`);
	try {
		for (let i = 0; i < 300 && !out.includes("Background script S1 (workflow greet, run R1) completed"); i++)
			await new Promise((r) => setTimeout(r, 50));
		assert.match(out, /Workflow greet started as background script S1 \(run R1\)/);
		assert.match(
			out,
			/Background script S1 \(workflow greet, run R1\) completed\.\\nReturn value:[^"]*workflow-done completed/,
		);
		assert.ok(
			out.indexOf("started as background script") < out.indexOf("Background script S1"),
			"the command returned before the script ended",
		);
	} finally {
		child.kill();
	}
});

test("Workflow tool: offered only when a workflow can run, described with them, skipping clashing names", async () => {
	const s = sandbox();
	const none = await loadTool({}, { cwd: s.repo });
	// The built-in review workflow always exists, so the tool is always there.
	assert.match(none.tools.Workflow.description, /Saved workflows:\n- review: /);
	s.write(join(s.repo, ".pi/workflows/audit.js"), file("audit", "return 1", "Audit the routes"));
	s.write(join(s.repo, ".pi/workflows/review.js"), file("review", "return 1"));
	const t = await loadTool({}, { cwd: s.repo, otherCommands: ["review"] });
	assert.match(t.tools.Workflow.description, /- audit: Audit the routes/);
	assert.doesNotMatch(t.tools.Workflow.description, /review/);
	assert.ok(t.commands.workflows, "/workflows is a command");
});

test("/workflows in print mode lists the saved workflows", async () => {
	const s = sandbox();
	const agentDir = join(s.root, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ subagent: { piCommand: FAKE_PI } }));
	s.write(join(s.repo, ".pi/workflows/audit.js"), file("audit", "return 1", "Audit the routes"));
	s.write(join(agentDir, "workflows/mine.js"), file("mine", "return 1", "My own"));
	const r = await xpi(s.repo, agentDir, s.home, "/workflows");
	assert.equal(r.code, 0, r.err);
	assert.deepEqual(
		r.out
			.trim()
			.split("\n")
			.map((l) => l.replace(/ · [^·]*$/, (dir) => (dir.endsWith("/workflows") ? " · <dir>" : dir))),
		[
			"/audit · Audit the routes · project · <dir>",
			"/mine · My own · user · <dir>",
			"/review · Review a diff with parallel read-only reviewers and one verifier. /review [branch | commit | #PR]; no argument reviews the uncommitted changes. · builtin · <dir>",
		],
	);
	assert.match(r.out, /\.pi\/workflows\n/);
});

test("format: the word import in a prompt, in quoted code or in a comment is not an import", () => {
	const head = "export const meta = { name: 'x', description: 'd' }\n";
	for (const body of [
		"return await agent('Find every file that does import React from somewhere')",
		"return await agent(`Fix this:\nimport os\nprint(1)`)",
		'return await agent("call import(x) here")',
		"// we do not import anything\n/* import x from 'y' */\nreturn 1",
		"return await agent('it\\'s fine to import things')",
	]) {
		assert.doesNotThrow(() => parseWorkflow(head + body, "x"), body);
	}
	// A real one is still refused, also after a string on the same line.
	assert.throws(() => parseWorkflow(`${head}const s = 'a'; import fs from 'node:fs'`, "x"), /cannot import/);
	assert.throws(() => parseWorkflow(`${head}const m = await import('fs')`, "x"), /cannot import/);
});
