// A saved workflow on real haiku, run by `/name` in print mode (no model turn for main): it fans out three Explore
// agents with a schema through pipeline() and returns their merged value. The model-run path (tools.Workflow from main)
// is the eval "parent runs a saved workflow".
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { PI, sandbox } from "./helpers.ts";

const WORKFLOW = `export const meta = {
  name: 'list-ts',
  description: 'List the .ts files of each directory in args.dirs',
  phases: ['list'],
}

phase('list')
const found = await pipeline(args.dirs, (dir) =>
  agent('List the .ts files directly under ' + dir + '/ (file names only). quick', {
    label: dir,
    type: 'Explore',
    schema: { type: 'object', required: ['files'], properties: { files: { type: 'array', items: { type: 'string' } } } },
  }),
)
log('listed ' + found.length)
return JSON.stringify(found.map((r) => r && r.files.map((f) => f.split('/').pop()).sort()))
`;

test("/list-ts runs three Explore agents with a schema and prints the merged value", async () => {
	const s = sandbox();
	s.write(join(s.repo, "src/alpha.ts"), "export const a = 1;\n");
	s.write(join(s.repo, "lib/beta.ts"), "export const b = 2;\n");
	s.write(join(s.repo, "lib/gamma.ts"), "export const c = 3;\n");
	s.write(join(s.repo, "test/delta.ts"), "export const d = 4;\n");
	s.write(join(s.repo, ".pi/workflows/list-ts.js"), WORKFLOW);
	s.write(join(s.repo, ".pi/settings.json"), JSON.stringify({ subagent: { piCommand: PI } }));
	const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/(_API_KEY|_AUTH_TOKEN)$/.test(k)));
	const r = await new Promise<{ code: number; out: string; err: string }>((resolve) => {
		const child = execFile(
			process.execPath,
			[PI, "--approve", "--no-session", "-p", '/list-ts {"dirs":["src","lib","test"]}'],
			{ cwd: s.repo, env, timeout: 180_000 },
			(error, out, err) => resolve({ code: error ? 1 : 0, out, err }),
		);
		child.stdin?.end();
	});
	assert.equal(r.code, 0, r.err);
	const json = r.out.trim().split("\n").at(-1)!;
	assert.deepEqual(JSON.parse(json), [["alpha.ts"], ["beta.ts", "gamma.ts"], ["delta.ts"]], r.out);
});

// The script on Claude Code's workflows page, unchanged, saved where Claude Code keeps workflows.
const CLAUDE_CODE_EXAMPLE = `export const meta = {
  name: 'audit-routes',
  description: 'Audit every route handler for missing auth checks',
}

const found = await agent('List every .ts file under src/routes/.', {
  schema: { type: 'object', required: ['files'], properties: { files: { type: 'array', items: { type: 'string' } } } },
})

const audits = await pipeline(found.files, file =>
  agent(\`Audit \${file} for missing authentication checks.\`, { label: file }),
)

return audits.filter(Boolean)
`;

test("Claude Code's documented workflow, saved under .claude/workflows, runs unchanged", async () => {
	const s = sandbox();
	s.write(join(s.repo, "src/routes/users.ts"), "export function listUsers(req) { return db.users.all(); }\n");
	s.write(join(s.repo, "src/routes/health.ts"), "export function health() { return 'ok'; }\n");
	s.write(join(s.repo, ".claude/workflows/audit-routes.js"), CLAUDE_CODE_EXAMPLE);
	s.write(join(s.repo, ".pi/settings.json"), JSON.stringify({ subagent: { piCommand: PI } }));
	const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/(_API_KEY|_AUTH_TOKEN)$/.test(k)));
	const r = await new Promise<{ code: number; out: string; err: string }>((resolve) => {
		const child = execFile(
			process.execPath,
			[PI, "--approve", "--no-session", "-p", "/audit-routes"],
			{ cwd: s.repo, env, timeout: 240_000 },
			(error, out, err) => resolve({ code: error ? 1 : 0, out, err }),
		);
		child.stdin?.end();
	});
	assert.equal(r.code, 0, r.err);
	assert.doesNotMatch(r.out, /Script error/, r.out);
	// Two audits came back (the script's return value is an array of the agents' reports).
	assert.match(r.out, /users/i, r.out);
	assert.match(r.out, /health/i, r.out);
});
