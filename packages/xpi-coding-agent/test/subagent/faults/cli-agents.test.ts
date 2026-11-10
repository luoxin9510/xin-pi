// `--agents` (spec 05): agents given on the command line as JSON (or a JSON file), in Claude Code's shape. They rank
// above every agent file, and a real xpi takes the flag.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { discoverAgents, setCliAgents } from "../../../src/extensions/subagent/discovery.ts";
import { agentFile, ev, FAKE_PI, flag, loadTool, sandbox } from "../helpers.ts";

const CLI = fileURLToPath(new URL("../../../src/cli.ts", import.meta.url));
const AGENTS = {
	reviewer: { description: "Reviews code", prompt: "You review code.", tools: "Read, Grep", model: "sonnet" },
	"quick-look": { description: "Looks quickly", prompt: "", maxTurns: 3, background: true },
};

test("the JSON object: keys are names, `prompt` is the system prompt, the rest are the agent-file fields", () => {
	const s = sandbox();
	assert.deepEqual(setCliAgents(JSON.stringify(AGENTS), s.repo), []);
	const { agents } = discoverAgents(s.repo);
	const reviewer = agents.get("reviewer")!;
	assert.equal(reviewer.source, "--agents");
	assert.equal(reviewer.prompt, "You review code.");
	assert.deepEqual(reviewer.tools, ["Read", "Grep"]);
	assert.equal(reviewer.model, "sonnet");
	assert.equal(agents.get("quick-look")!.maxTurns, 3);
	assert.equal(agents.get("quick-look")!.background, true);
	setCliAgents(undefined, s.repo);
	assert.equal(discoverAgents(s.repo).agents.get("reviewer"), undefined, "an unset flag clears them");
});

test("a path to a JSON file works too; what is not such an object throws; a bad entry is skipped with a warning", () => {
	const s = sandbox();
	s.write(join(s.repo, "agents.json"), JSON.stringify(AGENTS));
	assert.deepEqual(setCliAgents("agents.json", s.repo), []);
	assert.ok(discoverAgents(s.repo).agents.has("reviewer"));
	assert.throws(() => setCliAgents("missing.json", s.repo), /--agents: cannot read .*missing\.json: ENOENT/);
	assert.throws(() => setCliAgents("{ not json", s.repo), /--agents: invalid JSON/);
	s.write(join(s.repo, "list.json"), "[]");
	assert.throws(() => setCliAgents("list.json", s.repo), /expected a JSON object whose keys are agent names/);
	const warnings = setCliAgents(
		JSON.stringify({
			ok: { description: "d" },
			nodesc: { prompt: "p" },
			"-dash": { description: "d" },
			five: 5,
			badprompt: { description: "d", prompt: 1 },
		}),
		s.repo,
	);
	assert.deepEqual(
		[...discoverAgents(s.repo).agents.keys()].filter((n) => ["ok", "nodesc", "-dash", "five"].includes(n)),
		["ok"],
	);
	assert.deepEqual(warnings, [
		'skipped --agents entry "nodesc": missing "description"',
		'skipped --agents entry "-dash": "name" must not start with "-"',
		'skipped --agents entry "five": its value must be an object',
		'skipped --agents entry "badprompt": "prompt" must be a string',
	]);
	setCliAgents(undefined, s.repo);
});

test("an --agents agent wins over a project file and a built-in of the same name, and runs with its prompt", async () => {
	const s = sandbox();
	s.write(
		join(s.repo, ".pi/agents/reviewer.md"),
		agentFile("name: reviewer\ndescription: from the file", "File prompt."),
	);
	s.scenario({ lines: [ev.session(), ev.assistant("ok"), ev.turnEnd(), ev.settled()] });
	const flags = {
		agents: JSON.stringify({
			reviewer: { description: "from the flag", prompt: "Flag prompt.", tools: "Read" },
			Explore: { description: "my own Explore", prompt: "Mine." },
		}),
	};
	const t = await loadTool({}, { cwd: s.repo, flags });
	assert.match(t.tool.description, /- reviewer: from the flag/);
	assert.match(t.tool.description, /- Explore: my own Explore/);
	assert.doesNotMatch(t.tool.description, /from the file/);
	const r = (await t.run({ subagent_type: "reviewer" })).structuredContent;
	assert.equal(r.status, "completed");
	const rec = s.record();
	assert.match(rec.systemPromptTail!, /Flag prompt\./);
	assert.equal(flag(rec.argv, "--tools"), "codemode,read");
	const plain = await loadTool({}, { cwd: s.repo });
	assert.match(plain.tool.description, /- reviewer: from the file/, "a session without the flag has the files again");
});

test("invalid --agents stops the session start with the reason", async () => {
	const s = sandbox();
	await assert.rejects(loadTool({}, { cwd: s.repo, flags: { agents: "{ nope" } }), /--agents: invalid JSON/);
	setCliAgents(undefined, s.repo);
});

test("a real xpi takes --agents: the agent is offered to scripts", async () => {
	const s = sandbox();
	const agentDir = join(s.root, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ subagent: { piCommand: FAKE_PI } }));
	s.scenario({ lines: [ev.session(), ev.assistant("flag agent says hi"), ev.turnEnd(), ev.settled()] });
	// A saved workflow runs the agent with no model turn.
	s.write(
		join(s.repo, ".pi/workflows/ask.js"),
		"export const meta = { name: 'ask', description: 'Ask the flag agent' }\nreturn await agent('hello', { type: 'greeter' })",
	);
	const env = {
		...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/(_API_KEY|_AUTH_TOKEN)$/.test(k))),
		HOME: s.home,
		XPI_CODING_AGENT_DIR: agentDir,
		XPI_SKIP_VERSION_CHECK: "1",
		XPI_TELEMETRY: "0",
	};
	const out = await new Promise<string>((resolve) => {
		const child = execFile(
			process.execPath,
			[
				"--experimental-strip-types",
				"--no-warnings",
				CLI,
				"--no-session",
				"--approve",
				"--agents",
				JSON.stringify({ greeter: { description: "Greets", prompt: "You greet people." } }),
				"-p",
				"/ask",
			],
			{ cwd: s.repo, env, timeout: 60_000 },
			(_error, stdout, stderr) => resolve(stdout + stderr),
		);
		child.stdin?.end();
	});
	assert.match(out, /flag agent says hi/, out);
	assert.match(s.record().systemPromptTail!, /You greet people\./);
});
