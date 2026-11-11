// `extensions` in an agent file (spec 08, decision 4): xpi's hooks. Each entry is loaded only into this agent's child
// with -e, and --strict-extensions makes one that cannot load stop the child. Local paths are resolved against the
// agent file's directory (`--agents`: the cwd); a project file's extensions load only in a trusted project.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { inertNotice, parseDefinition } from "../../../src/extensions/subagent/definition.ts";
import { setCliAgents } from "../../../src/extensions/subagent/discovery.ts";
import { agentFile, ev, loadTool, sandbox } from "../helpers.ts";

test("parsing: a list or a comma string; local paths absolute against the file's directory; sources as given", () => {
	const s = sandbox();
	s.write(join(s.repo, ".pi/agents/guards/no-bash.ts"), "export default () => {}\n");
	s.write(join(s.repo, "tools/audit.ts"), "export default () => {}\n");
	const file = join(s.repo, ".pi/agents/x.md");
	const parse = (fields: string) => {
		const r = parseDefinition(file, agentFile(`name: x\ndescription: d\n${fields}`));
		assert.ok(r.ok, JSON.stringify(r));
		return r.def;
	};
	const listed = parse(
		"extensions:\n  - ./guards/no-bash.ts\n  - ../../tools/audit.ts\n  - npm:some-guard\n  - builtin:mcp",
	);
	assert.deepEqual(listed.extensions, [
		join(s.repo, ".pi/agents/guards/no-bash.ts"),
		join(s.repo, "tools/audit.ts"),
		"npm:some-guard",
		"builtin:mcp",
	]);
	assert.deepEqual(listed.warnings, []);
	assert.deepEqual(parse("extensions: ./guards/no-bash.ts, npm:some-guard").extensions, [
		join(s.repo, ".pi/agents/guards/no-bash.ts"),
		"npm:some-guard",
	]);
	// A missing file is kept, so the child fails on it instead of the agent running without its guard.
	const missing = parse("extensions: [./guards/nope.ts, npm:some-guard]");
	assert.deepEqual(missing.extensions, [join(s.repo, ".pi/agents/guards/nope.ts"), "npm:some-guard"]);
	assert.deepEqual(missing.warnings, [
		`extensions: "./guards/nope.ts" not found (${join(s.repo, ".pi/agents/guards/nope.ts")}): this agent's calls will fail until it exists`,
	]);
	assert.equal(parse("model: x").extensions, undefined);
	const bad = parseDefinition(file, agentFile("name: x\ndescription: d\nextensions: 5"));
	assert.ok(!bad.ok && /"extensions" must be a comma-separated string or a list of strings/.test(bad.reason));
});

test("hooks stays without effect; its warning points to extensions", () => {
	assert.match(
		inertNotice("hooks"),
		/hook commands do not run in xpi; list extensions in the agent's `extensions` field/,
	);
});

async function run(fields: string, options: { trusted?: boolean; user?: boolean } = {}) {
	const s = sandbox();
	const dir = options.user ? join(s.home, ".pi/agent/agents") : join(s.repo, ".pi/agents");
	s.write(join(dir, "guard.ts"), "export default () => {}\n");
	s.write(join(dir, "x.md"), agentFile(`name: x\ndescription: d\n${fields}`));
	s.scenario({ lines: [ev.session(), ev.assistant("ok"), ev.turnEnd(), ev.settled()] });
	const t = await loadTool({}, { cwd: s.repo, trusted: options.trusted ?? true });
	return { s, dir, t };
}

const extensionArgs = (argv: string[]) => argv.flatMap((arg, i) => (argv[i - 1] === "-e" ? [arg] : []));

test("each entry reaches the child as -e, with --strict-extensions; an agent without them gets neither", async () => {
	const { s, dir, t } = await run("extensions: [./guard.ts, npm:some-guard]");
	const r = (await t.run({ subagent_type: "x" })).structuredContent;
	assert.equal(r.status, "completed");
	const argv = s.record().argv;
	assert.deepEqual(extensionArgs(argv), [join(dir, "guard.ts"), "npm:some-guard"]);
	assert.ok(argv.includes("--strict-extensions"));
	const plain = await run("model: haiku");
	await plain.t.run({ subagent_type: "x" });
	assert.ok(!plain.s.record().argv.includes("--strict-extensions"));
	assert.deepEqual(extensionArgs(plain.s.record().argv), []);
});

test("a project agent file's extensions need a trusted project: otherwise the call fails, it never runs unguarded", async () => {
	const { s, t } = await run("extensions: [./guard.ts]", { trusted: false });
	await assert.rejects(
		t.run({ subagent_type: "x" }),
		/agent "x" has extensions, which a project agent file can load only in a trusted project/,
	);
	assert.throws(() => s.record(), /ENOENT/, "no child was started");
	// A user agent file's load in an untrusted project too.
	const user = await run("extensions: [./guard.ts]", { trusted: false, user: true });
	const r = (await user.t.run({ subagent_type: "x" })).structuredContent;
	assert.equal(r.status, "completed");
	assert.deepEqual(extensionArgs(user.s.record().argv), [join(user.dir, "guard.ts")]);
});

test("--agents: a local entry is resolved against the cwd", async () => {
	const s = sandbox();
	s.write(join(s.repo, "guards/g.ts"), "export default () => {}\n");
	try {
		assert.deepEqual(
			setCliAgents(JSON.stringify({ c: { description: "d", prompt: "", extensions: ["./guards/g.ts"] } }), s.repo),
			[],
		);
		s.scenario({ lines: [ev.session(), ev.assistant("ok"), ev.turnEnd(), ev.settled()] });
		const t = await loadTool(
			{},
			{
				cwd: s.repo,
				flags: { agents: JSON.stringify({ c: { description: "d", prompt: "", extensions: ["./guards/g.ts"] } }) },
			},
		);
		await t.run({ subagent_type: "c" });
		assert.deepEqual(extensionArgs(s.record().argv), [join(s.repo, "guards/g.ts")]);
	} finally {
		setCliAgents(undefined, s.repo);
	}
});
