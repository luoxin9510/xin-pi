// `schema` on an Agent call, on real haiku: the child offers StructuredOutput next to its tools and returns a value
// that matches the schema, with codemode-only children and with direct tools.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { agentFile, loadTool, sandbox } from "./helpers.ts";

// Records the tool names each provider request offers (as in 09-codemode-only).
const PROBE = (out: string) => `import { appendFileSync } from "node:fs";
export default function (pi) {
  pi.on("before_provider_request", (event) => {
    appendFileSync(${JSON.stringify(out)}, JSON.stringify((event.payload.tools ?? []).map((t) => t.name ?? t.function?.name)) + "\\n");
  });
}
`;

const SCHEMA = {
	type: "object",
	properties: {
		files: { type: "array", items: { type: "string" }, description: "paths of the .ts files, relative to the repo" },
		count: { type: "integer" },
	},
	required: ["files", "count"],
	additionalProperties: false,
};

async function run(fields: string) {
	const s = sandbox();
	const offered = join(s.root, "offered.jsonl");
	s.write(join(s.repo, ".pi/extensions/probe.ts"), PROBE(offered));
	s.write(join(s.repo, ".pi/agents/x.md"), agentFile(`name: x\ndescription: d\n${fields}`));
	s.write(join(s.repo, "src/alpha.ts"), "export const alpha = 1;\n");
	s.write(join(s.repo, "src/beta.ts"), "export const beta = 2;\n");
	s.write(join(s.repo, "README.md"), "# demo\n");
	const t = await loadTool({}, { cwd: s.repo, persist: join(s.root, "sessions") });
	const r = await t.result({
		subagent_type: "x",
		prompt: "List the .ts files under src/.",
		schema: SCHEMA,
	});
	const tools = existsSync(offered)
		? [
				...new Set(
					readFileSync(offered, "utf8")
						.trim()
						.split("\n")
						.flatMap((l) => JSON.parse(l) as string[]),
				),
			]
				.filter((n) => !n.startsWith("__pi"))
				.map((n) => n.toLowerCase())
				.sort()
		: [];
	return { r, tools };
}

const check = (r: any) => {
	assert.equal(r.status, "completed", r.error ?? "");
	assert.deepEqual([...r.structured.files].map((f: string) => f.replace(/^\.\//, "")).sort(), [
		"src/alpha.ts",
		"src/beta.ts",
	]);
	assert.equal(r.structured.count, 2);
	assert.deepEqual(JSON.parse(r.output), r.structured);
};

test("a codemode-only child is offered codemode and StructuredOutput, and returns a matching value", async () => {
	const { r, tools } = await run("tools: Read, Glob, LS");
	check(r);
	assert.deepEqual(tools, ["codemode", "structuredoutput"]);
});

test("a child on direct tools returns a matching value too", async () => {
	const { r, tools } = await run("tools: Read, Glob, LS\ncodemode: false");
	check(r);
	assert.deepEqual(tools, ["find", "ls", "read", "structuredoutput"]);
});
