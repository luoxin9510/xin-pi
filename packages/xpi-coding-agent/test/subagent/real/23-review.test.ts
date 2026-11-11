// `/review` on real haiku, run in print mode against the built CLI (npm run build first). A fixture repository has a
// committed baseline and an uncommitted change with two planted bugs (an off-by-one loop bound, an inverted null check)
// and one style-only change. The reviewers and the verifier are the built-in `reviewer` agent with its `sonnet` alias
// remapped to haiku. The result must name both buggy files at their lines and must not report the style-only file.
// Hand-run only (part of test:subagent:real, never of the offline suites).
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { HAIKU, PI, sandbox } from "./helpers.ts";

const BASE = {
	"src/sum.ts": [
		"export function sum(items: number[]): number {",
		"\tlet total = 0;",
		"\tfor (let i = 0; i < items.length; i++) {",
		"\t\ttotal += items[i];",
		"\t}",
		"\treturn total;",
		"}",
		"",
	].join("\n"),
	"src/user.ts": [
		"export interface User {",
		"\tname: string;",
		"}",
		"",
		"export function displayName(user: User | null): string {",
		"\tif (user === null) return 'anonymous';",
		"\treturn user.name;",
		"}",
		"",
	].join("\n"),
	"src/format.ts": [
		"export function pad(text: string, width: number): string {",
		"\tlet out = text;",
		"\twhile (out.length < width) out = out + ' ';",
		"\treturn out;",
		"}",
		"",
	].join("\n"),
};

const CHANGED = {
	// planted bug 1, line 3: `<=` reads one element past the end, so the total becomes NaN
	"src/sum.ts": BASE["src/sum.ts"].replace("i < items.length", "i <= items.length"),
	// planted bug 2, line 6: the null check is inverted, so a real user is anonymous and null throws on `.name`
	"src/user.ts": BASE["src/user.ts"].replace("user === null", "user !== null"),
	// style only: renamed local, same behavior
	"src/format.ts": BASE["src/format.ts"].replaceAll("out", "padded"),
};

// The finding lines of the result: `1. [P1] title — path:10-14`.
const findings = (out: string) =>
	[...out.matchAll(/^\d+\. \[P\d\] .* — (\S+?):(\d+)(?:-(\d+))?$/gm)].map((m) => ({
		file: m[1]!,
		start: Number(m[2]),
		end: Number(m[3] ?? m[2]),
	}));

test("/review finds two planted bugs and leaves the style-only change alone", async () => {
	const s = sandbox();
	const dir = join(s.root, "fixture");
	const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
	// The reviewer agent asks for `sonnet`: run it on haiku, and point the Agent tool at the built CLI. The settings are
	// part of the baseline commit, so the review sees only the planted change.
	s.write(join(dir, ".pi/settings.json"), JSON.stringify({ subagent: { piCommand: PI, models: { sonnet: HAIKU } } }));
	for (const [path, text] of Object.entries(BASE)) s.write(join(dir, path), text);
	git("init", "-q", "-b", "main");
	git("config", "user.name", "Test");
	git("config", "user.email", "test@example.com");
	git("config", "commit.gpgsign", "false");
	git("add", ".");
	git("commit", "-q", "-m", "baseline");
	for (const [path, text] of Object.entries(CHANGED)) s.write(join(dir, path), text);
	const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/(_API_KEY|_AUTH_TOKEN)$/.test(k)));
	const r = await new Promise<{ code: number; out: string; err: string }>((resolve) => {
		const child = execFile(
			process.execPath,
			[PI, "--approve", "--no-session", "-p", "/review"],
			{ cwd: dir, env, timeout: 280_000 },
			(error, out, err) => resolve({ code: error ? 1 : 0, out, err }),
		);
		child.stdin?.end();
	});
	assert.equal(r.code, 0, r.err);
	const found = findings(r.out);
	const near = (file: string, line: number) =>
		found.some((f) => f.file === file && f.start - 2 <= line && line <= f.end + 2);
	assert.ok(near("src/sum.ts", 3), `the off-by-one in src/sum.ts:3\n${r.out}`);
	assert.ok(near("src/user.ts", 6), `the inverted null check in src/user.ts:6\n${r.out}`);
	assert.ok(!found.some((f) => f.file === "src/format.ts"), `the style-only change was reported\n${r.out}`);
});
