// The built-in `review` workflow and `reviewer` agent: discovery (builtin source, untrusted projects, an owner's file
// wins), the script's pure helpers (the text between BEGIN helpers and END helpers is evaluated here, so there is one
// source), and whole runs of the script against a real temp repository with a fake `agent()`. No model, no network.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BUILTIN_DIR, discoverAgents } from "../../../src/extensions/subagent/discovery.ts";
import { discoverWorkflows, parseWorkflow } from "../../../src/extensions/subagent/workflows.ts";
import { ev, FAKE_PI, initRepo, loadTool, sandbox } from "../helpers.ts";

const SCRIPT = readFileSync(join(BUILTIN_DIR, "workflows", "review.js"), "utf8");
const BODY = parseWorkflow(SCRIPT, "review").body;

interface File {
	path: string;
	added: number;
	removed: number;
	lines: number;
	binary: boolean;
	text: string;
	untracked?: boolean;
}
interface Finding {
	title: string;
	body: string;
	priority: string;
	confidence: number;
	file: string;
	lineStart: number;
	lineEnd: number;
}
interface Helpers {
	parseTarget(input: unknown): { kind?: string; number?: string; ref?: string; error?: string };
	isSkipped(path: string): boolean;
	splitDiff(text: string): File[];
	reviewerCount(files: number, lines: number): number;
	groupFiles(files: Partial<File>[], n: number): Partial<File>[][];
	diffCommand(target: object, files: Partial<File>[]): string;
	ranked(findings: Finding[]): Finding[];
	formatResult(r: object): string;
}

const section = /\/\/ BEGIN helpers\n([\s\S]*?)\/\/ END helpers/.exec(SCRIPT)![1]!;
const names =
	"parseTarget, isSkipped, splitDiff, reviewerCount, groupFiles, diffCommand, ranked, formatResult, reviewPrompt, verifyPrompt";
const helpers = new Function(`${section}\nreturn { ${names} };`)() as Helpers & {
	reviewPrompt(...a: unknown[]): string;
	verifyPrompt(...a: unknown[]): string;
};

const file = (name: string, body: string) =>
	`export const meta = {\n  name: '${name}',\n  description: 'Demo workflow',\n}\n${body}`;

// --- discovery

test("discovery: the built-in review workflow is listed with source builtin, in an untrusted project too", () => {
	const s = sandbox();
	const agentDir = join(s.root, "agent");
	for (const trusted of [true, false]) {
		const { workflows, warnings } = discoverWorkflows(s.repo, trusted, agentDir, join(s.root, "claude"));
		const review = workflows.get("review");
		assert.ok(review, `trusted=${trusted}`);
		assert.equal(review.source, "builtin");
		assert.equal(review.path, join(BUILTIN_DIR, "workflows", "review.js"));
		assert.deepEqual(review.meta.phases, ["diff", "review", "verify"]);
		assert.deepEqual(warnings, []);
	}
});

test("discovery: a project, user or Claude review.js hides the built-in one", () => {
	const s = sandbox();
	const agentDir = join(s.root, "agent");
	const claudeDir = join(s.root, "claude");
	s.write(join(agentDir, "workflows/review.js"), file("review", "return 'mine'"));
	let found = discoverWorkflows(s.repo, false, agentDir, claudeDir).workflows.get("review")!;
	assert.equal(found.source, "user");
	assert.match(found.body, /'mine'/);
	s.write(join(s.repo, ".pi/workflows/review.js"), file("review", "return 'project'"));
	found = discoverWorkflows(s.repo, true, agentDir, claudeDir).workflows.get("review")!;
	assert.equal(found.source, "project");
	assert.equal(discoverWorkflows(s.repo, false, agentDir, claudeDir).workflows.get("review")!.source, "user");
	s.write(join(claudeDir, "workflows/review.js"), file("review", "return 'claude'"));
	assert.equal(
		discoverWorkflows(s.repo, false, join(s.root, "none"), claudeDir).workflows.get("review")!.source,
		"user",
	);
});

test("discovery: /review is registered as a command in an untrusted project", async () => {
	const s = sandbox();
	process.env.XPI_CODING_AGENT_DIR = join(s.root, "agent"); // the user's own review.js would hide the built-in one
	const t = await loadTool({}, { cwd: s.repo, trusted: false });
	assert.ok(t.commands.review);
	assert.equal(
		t.commands.review.description,
		"Review a diff with parallel read-only reviewers and one verifier. /review [branch | commit | #PR]; no argument reviews the uncommitted changes. (workflow)",
	);
});

test("agent: reviewer is a built-in, read-only agent on sonnet", () => {
	const s = sandbox();
	const reviewer = discoverAgents(s.repo).agents.get("reviewer")!;
	assert.ok(reviewer);
	assert.equal(reviewer.source, "builtin:reviewer");
	assert.equal(reviewer.model, "sonnet");
	assert.deepEqual(reviewer.tools, ["Read", "Grep", "Glob", "LS", "Bash"]);
	assert.deepEqual(reviewer.disallowedTools, ["Write", "Edit"]);
	assert.match(reviewer.prompt, /never change files/i);
	assert.deepEqual(reviewer.warnings, []);
});

// --- pure helpers

test("helpers: parseTarget", () => {
	const p = helpers.parseTarget;
	assert.deepEqual(p(undefined), { kind: "worktree" });
	assert.deepEqual(p("  "), { kind: "worktree" });
	assert.deepEqual(p("#12"), { kind: "pr", number: "12" });
	assert.deepEqual(p("main"), { kind: "ref", ref: "main" });
	assert.deepEqual(p("origin/feat-x"), { kind: "ref", ref: "origin/feat-x" });
	assert.deepEqual(p("HEAD~2"), { kind: "ref", ref: "HEAD~2" });
	assert.deepEqual(p(1234567), { kind: "ref", ref: "1234567" }, "an all-digit sha parses as a JSON number");
	for (const bad of ["--help", "a b", "x;rm -rf", "$(id)", "#", "#1a", { a: 1 }, ["main"]]) {
		assert.ok(p(bad).error, JSON.stringify(bad));
	}
});

test("helpers: the skip list", () => {
	const skipped = [
		"package-lock.json",
		"packages/a/yarn.lock",
		"pnpm-lock.yaml",
		"Cargo.lock",
		"go.sum",
		"public/app.min.js",
		"styles/site.min.css",
		"out/bundle.js.map",
		"src/models.generated.ts",
		"test/__snapshots__/a.snap",
		"x.snap",
		"dist/index.js",
		"packages/a/build/x.js",
		"out/x.js",
		"node_modules/a/index.js",
		"vendor/lib.go",
		"logo.PNG",
		"img/a.jpg",
		"fonts/a.woff2",
		"release.tar.gz",
	];
	for (const path of skipped) assert.ok(helpers.isSkipped(path), path);
	for (const path of [
		"src/index.ts",
		"src/distance.ts",
		"src/builder.ts",
		"docs/lock.md",
		"src/vendored.ts",
		"README.md",
	]) {
		assert.ok(!helpers.isSkipped(path), path);
	}
});

const diffOf = (path: string, adds: string[], removes: string[] = []) =>
	`diff --git a/${path} b/${path}\nindex 1..2 100644\n--- a/${path}\n+++ b/${path}\n@@ -1,${removes.length} +1,${adds.length} @@\n${removes.map((l) => `-${l}\n`).join("")}${adds.map((l) => `+${l}\n`).join("")}`;

test("helpers: splitDiff counts lines, finds renames, deletions, new files and binaries", () => {
	const text = [
		diffOf("src/a.ts", ["x", "y"], ["z"]),
		"diff --git a/old.ts b/new.ts\nsimilarity index 90%\nrename from old.ts\nrename to new.ts\nindex 1..2 100644\n--- a/old.ts\n+++ b/new.ts\n@@ -1 +1 @@\n-a\n+b\n",
		"diff --git a/gone.ts b/gone.ts\ndeleted file mode 100644\nindex 1..0\n--- a/gone.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n",
		"diff --git a/new.txt b/new.txt\nnew file mode 100644\nindex 0..1\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+++ looks like a header\n",
		"diff --git a/logo.bin b/logo.bin\nnew file mode 100644\nindex 0..1\nBinary files /dev/null and b/logo.bin differ\n",
	].join("");
	const files = helpers.splitDiff(text);
	assert.deepEqual(
		files.map((f) => [f.path, f.added, f.removed, f.binary]),
		[
			["src/a.ts", 2, 1, false],
			["new.ts", 1, 1, false],
			["gone.ts", 0, 2, false],
			["new.txt", 1, 0, false],
			["logo.bin", 0, 0, true],
		],
	);
	assert.equal(files[0]!.lines, 3);
	assert.equal(files[4]!.lines, 1);
	assert.ok(files[0]!.text.startsWith("diff --git a/src/a.ts"));
	assert.deepEqual(helpers.splitDiff(""), []);
});

test("helpers: reviewer count thresholds", () => {
	const n = helpers.reviewerCount;
	assert.equal(n(10, 99), 1);
	assert.equal(n(2, 5000), 1, "at most two files");
	assert.equal(n(3, 100), 2);
	assert.equal(n(10, 499), 2);
	assert.equal(n(10, 500), 4);
	assert.equal(n(10, 1999), 4);
	assert.equal(n(10, 2000), 8);
	assert.equal(n(3, 9000), 3, "never more reviewers than files");
});

test("helpers: grouping keeps directories and tests with their code and balances lines", () => {
	const f = (path: string, lines: number) => ({ path, lines });
	const groups = helpers.groupFiles(
		[
			f("src/a/one.ts", 100),
			f("src/a/two.ts", 100),
			f("src/b/three.ts", 100),
			f("src/b/four.ts", 100),
			f("test/three.test.ts", 100),
			f("test/b/four.spec.ts", 100),
		],
		2,
	);
	const paths = groups.map((g) => g.map((x) => x.path));
	assert.equal(paths.length, 2);
	assert.deepEqual(paths[0], ["src/a/one.ts", "src/a/two.ts"], "directory src/a stays together");
	assert.deepEqual(paths[1], ["src/b/four.ts", "test/b/four.spec.ts", "src/b/three.ts", "test/three.test.ts"]);
	// a test sits in the group of its implementation
	const where = (p: string) => paths.findIndex((g) => g.includes(p));
	assert.equal(where("test/three.test.ts"), where("src/b/three.ts"));
	assert.equal(where("test/b/four.spec.ts"), where("src/b/four.ts"));
	// one big file and small ones: no empty groups, every file once
	const uneven = helpers.groupFiles([f("a.ts", 1000), f("b.ts", 1), f("c.ts", 1)], 4);
	assert.ok(uneven.every((g) => g.length > 0));
	assert.equal(uneven.flat().length, 3);
	assert.equal(helpers.groupFiles([f("only.ts", 5)], 1).length, 1);
	// a test with no implementation stands alone; same stem in two directories pairs with the same directory first
	const stems = helpers.groupFiles([f("a/x.ts", 10), f("b/x.ts", 10), f("b/x.test.ts", 10), f("lone.test.ts", 10)], 4);
	const find = (p: string) => stems.findIndex((g) => g.some((x) => x.path === p));
	assert.equal(find("b/x.test.ts"), find("b/x.ts"));
	assert.notEqual(find("a/x.ts"), find("b/x.ts"));
});

test("helpers: diff commands per target kind quote paths", () => {
	const g = "git -c core.quotepath=false --literal-pathspecs";
	const one = [{ path: "src/it's.ts" }];
	assert.equal(
		helpers.diffCommand({ kind: "worktree" }, one),
		`${g} diff HEAD --no-color --no-ext-diff -- 'src/it'\\''s.ts'`,
	);
	assert.equal(
		helpers.diffCommand({ kind: "worktree" }, [{ path: "t.ts" }, { path: "n.ts", untracked: true }]),
		`${g} diff HEAD --no-color --no-ext-diff -- 't.ts'; ${g} diff --no-index --no-color --no-ext-diff -- /dev/null 'n.ts'`,
	);
	assert.equal(
		helpers.diffCommand({ kind: "branch", ref: "main" }, one),
		`${g} diff 'main...HEAD' --no-color --no-ext-diff -- 'src/it'\\''s.ts'`,
	);
	assert.equal(
		helpers.diffCommand({ kind: "commit", ref: "abc123" }, []),
		`${g} show --format= --no-color --no-ext-diff 'abc123'`,
	);
	assert.equal(helpers.diffCommand({ kind: "pr", number: "7" }, one), "gh pr diff 7 --color=never");
});

const finding = (over: Partial<Finding>): Finding => ({
	title: "t",
	body: "b",
	priority: "P2",
	confidence: 0.5,
	file: "a.ts",
	lineStart: 1,
	lineEnd: 1,
	...over,
});

test("helpers: ranking is priority, then confidence, then position", () => {
	const order = helpers
		.ranked([
			finding({ title: "p2-low", priority: "P2", confidence: 0.4 }),
			finding({ title: "p0", priority: "P0", confidence: 0.1 }),
			finding({ title: "p2-high", priority: "P2", confidence: 0.9 }),
			finding({ title: "p1", priority: "P1", confidence: 0.5 }),
			finding({ title: "p2-high-later", priority: "P2", confidence: 0.9, file: "b.ts" }),
		])
		.map((x) => x.title);
	assert.deepEqual(order, ["p0", "p1", "p2-high", "p2-high-later", "p2-low"]);
});

test("helpers: the result text", () => {
	const text = helpers.formatResult({
		label: "commit abc fix",
		findings: [
			finding({ title: "minor", priority: "P3", confidence: 0.5, file: "z.ts", lineStart: 9, lineEnd: 9 }),
			finding({
				title: "Loop skips last item",
				body: "line one\nline two",
				priority: "P1",
				confidence: 0.9,
				file: "src/a.ts",
				lineStart: 10,
				lineEnd: 14,
			}),
		],
		dropped: [{ title: "naming", reason: "style only" }],
		skipped: ["package-lock.json"],
		reviewers: 2,
		failed: ["reviewer 2"],
		verifierFailed: false,
	});
	assert.equal(
		text,
		[
			"Review of commit abc fix",
			"1. [P1] Loop skips last item — src/a.ts:10-14\n   line one\n   line two\n   Confidence: 0.9\n\n2. [P3] minor — z.ts:9\n   b\n   Confidence: 0.5",
			"Dropped by the verifier: 1\n  - naming: style only\nSkipped files (1): package-lock.json\nReviewers: 2, failed: reviewer 2",
		].join("\n\n"),
	);
	const none = helpers.formatResult({
		label: "x",
		findings: [],
		dropped: [],
		skipped: [],
		reviewers: 1,
		failed: [],
		verifierFailed: false,
	});
	assert.equal(none, "Review of x\n\nNo findings.\n\nReviewers: 1");
	const unverified = helpers.formatResult({
		label: "x",
		findings: [finding({})],
		dropped: [],
		skipped: [],
		reviewers: 1,
		failed: [],
		verifierFailed: true,
	});
	assert.match(unverified, /Verifier failed: these findings are unverified\./);
});

// --- whole runs: the script body against a real repository, a fake agent() and a bash that runs real commands

type Call = { prompt: string; opts: { type: string; label: string; schema: { required: string[] } } };

function repoWithChanges() {
	const s = sandbox();
	const dir = initRepo(s.repo);
	const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" }).toString();
	mkdirSync(join(dir, "src"));
	mkdirSync(join(dir, "test"));
	writeFileSync(join(dir, "src/loop.ts"), "for (let i = 0; i < n; i++) {}\n");
	writeFileSync(join(dir, "package-lock.json"), "{}\n");
	git("add", "src/loop.ts", "package-lock.json");
	git("commit", "-q", "-m", "add loop");
	return { s, dir, git };
}

// `bash` runs the command for real; its output is cut like the real tool's (2000 lines or 50KB, the tail kept).
function run(dir: string, args: unknown, answer: (call: Call) => unknown, opts: { noBash?: boolean } = {}) {
	const calls: Call[] = [];
	const logs: string[] = [];
	const phases: string[] = [];
	const bashCalls: string[] = [];
	const tools = opts.noBash
		? {}
		: {
				bash: async ({ command }: { command: string }) => {
					bashCalls.push(command);
					let output = "";
					let code = 0;
					try {
						output = execFileSync("bash", ["-c", command], {
							cwd: dir,
							stdio: ["ignore", "pipe", "pipe"],
						}).toString();
					} catch (err) {
						const e = err as { status: number; stdout: Buffer; stderr: Buffer };
						code = e.status;
						output = e.stdout.toString() + e.stderr.toString();
					}
					const lines = output.split("\n");
					const truncated = lines.length > 2001 || output.length > 50 * 1024;
					if (truncated)
						output = lines
							.slice(-2000)
							.join("\n")
							.slice(-50 * 1024);
					return { output, exit_code: code, wall_time_seconds: 0, truncated };
				},
			};
	const agent = async (prompt: string, o: Call["opts"]) => {
		const call = { prompt, opts: o };
		calls.push(call);
		return answer(call);
	};
	const parallel = (tasks: (() => Promise<unknown>)[]) =>
		Promise.all(
			tasks.map((t) =>
				t().then(
					(v) => v,
					() => null,
				),
			),
		);
	const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
	const fn = new AsyncFunction("args", "tools", "agent", "parallel", "phase", "log", BODY);
	const result = fn(
		args,
		tools,
		agent,
		parallel,
		(p: string) => phases.push(p),
		(l: string) => logs.push(l),
	);
	return { result: result as Promise<string>, calls, logs, phases, bashCalls };
}

test("run: the working tree, with a new file, a skipped lockfile, two reviewers' worth of files and a verifier", async () => {
	const { dir } = repoWithChanges();
	writeFileSync(join(dir, "src/loop.ts"), "for (let i = 0; i <= n; i++) {}\n");
	writeFileSync(join(dir, "package-lock.json"), '{"a":1}\n');
	writeFileSync(join(dir, "src/new.ts"), "export const x = 1;\n");
	const r = run(dir, undefined, (call) =>
		call.opts.label === "verify"
			? {
					findings: [finding({ title: "off by one", file: "src/loop.ts", lineStart: 1, lineEnd: 1 })],
					dropped: [{ title: "nit", reason: "style" }],
				}
			: {
					findings: [
						finding({ title: "off by one", file: "src/loop.ts" }),
						finding({ title: "nit", file: "src/new.ts" }),
					],
				},
	);
	const text = await r.result;
	assert.deepEqual(r.phases, ["diff", "review", "verify"]);
	assert.equal(r.calls.length, 2, "one reviewer (two files), one verifier");
	const [review, verify] = r.calls as [Call, Call];
	assert.equal(review.opts.type, "reviewer");
	assert.deepEqual(review.opts.schema.required, ["findings"]);
	assert.match(review.prompt, /src\/loop\.ts \(\+1 -1\)/);
	assert.match(review.prompt, /src\/new\.ts \(new, untracked\) \(\+1 -0\)/);
	assert.match(review.prompt, /\+for \(let i = 0; i <= n; i\+\+\) \{\}/);
	assert.match(review.prompt, /\+export const x = 1;/);
	assert.doesNotMatch(review.prompt, /package-lock/);
	assert.equal(verify.opts.type, "reviewer");
	assert.match(verify.prompt, /"title": "off by one"/);
	assert.match(verify.prompt, /diff HEAD --no-color --no-ext-diff -- 'src\/loop\.ts'/);
	assert.equal(
		text,
		[
			"Review of the uncommitted changes (working tree against HEAD, with new files)",
			"1. [P2] off by one — src/loop.ts:1\n   b\n   Confidence: 0.5",
			"Dropped by the verifier: 1\n  - nit: style\nSkipped files (1): package-lock.json\nReviewers: 1",
		].join("\n\n"),
	);
});

test("run: a failed reviewer is reported, the others still count; no findings skips the verifier", async () => {
	const { dir } = repoWithChanges();
	const big = Array.from({ length: 150 }, (_, i) => `export const v${i} = ${i};`).join("\n");
	for (const name of ["a", "b", "c"]) writeFileSync(join(dir, `src/${name}.ts`), `${big}\n`);
	let n = 0;
	const r = run(dir, "", () => (++n === 1 ? null : { findings: [] }));
	const text = await r.result;
	assert.equal(r.calls.length, 2, "450 lines in 3 files: two reviewers, no verifier");
	assert.ok(r.calls.every((c) => c.opts.label !== "verify"));
	assert.match(text, /No findings\./);
	assert.match(text, /Reviewers: 2, failed: reviewer 1/);
	assert.doesNotMatch(r.phases.join(), /verify/);
});

test("run: a verifier that fails leaves the findings, marked unverified", async () => {
	const { dir } = repoWithChanges();
	writeFileSync(join(dir, "src/loop.ts"), "x\n");
	const r = run(dir, undefined, (call) => {
		if (call.opts.label === "verify") throw new Error("schema never met");
		return { findings: [finding({ title: "kept" })] };
	});
	const text = await r.result;
	assert.match(text, /1\. \[P2\] kept/);
	assert.match(text, /Verifier failed: these findings are unverified\./);
});

test("run: a large diff is read in full through the truncating bash, and reviewers get a command when it is too long", async () => {
	const { dir } = repoWithChanges();
	const lines = Array.from({ length: 6000 }, (_, i) => `export const value${i} = ${i};`);
	writeFileSync(join(dir, "src/huge.ts"), `${lines.join("\n")}\n`);
	const r = run(dir, undefined, () => ({ findings: [] }));
	const text = await r.result;
	assert.equal(r.calls.length, 1, "one file: one reviewer");
	assert.match(r.calls[0]!.prompt, /too long to paste/);
	assert.match(r.calls[0]!.prompt, /diff --no-index --no-color --no-ext-diff -- \/dev\/null 'src\/huge\.ts'/);
	assert.match(text, /No findings\./);
	assert.ok(
		r.logs.some((l) => l.includes("6000 changed lines")),
		r.logs.join(),
	);
});

test("run: a branch is reviewed from its merge base, a commit by itself, a bad ref is an error", async () => {
	const { dir, git } = repoWithChanges();
	git("branch", "base");
	writeFileSync(join(dir, "src/loop.ts"), "changed\n");
	git("commit", "-q", "-am", "change loop");
	const sha = git("rev-parse", "--short", "HEAD").trim();
	writeFileSync(join(dir, "src/after.ts"), "later\n");
	git("add", "src/after.ts");
	git("commit", "-q", "-m", "later");
	git("checkout", "-q", "-b", "feature");

	const branch = run(dir, "base", () => ({ findings: [] }));
	const branchText = await branch.result;
	assert.match(branchText, /^Review of the changes on HEAD since it left base/);
	assert.match(branch.calls[0]!.prompt, /src\/loop\.ts/);
	assert.match(branch.calls[0]!.prompt, /src\/after\.ts/);

	const commit = run(dir, sha, () => ({ findings: [] }));
	const commitText = await commit.result;
	assert.match(commitText, new RegExp(`^Review of commit ${sha} change loop`));
	assert.match(commit.calls[0]!.prompt, /src\/loop\.ts/);
	assert.doesNotMatch(commit.calls[0]!.prompt, /src\/after\.ts/);

	assert.equal(
		await run(dir, "nope", () => null).result,
		"review: nope is not a branch, tag or commit of this repository",
	);
	assert.equal(await run(dir, "--output=x", () => null).result, "review: not a branch, commit or #N: --output=x");
});

test("run: errors for an empty diff, only skipped files, no bash, no repository, no commits", async () => {
	const { dir } = repoWithChanges();
	const none = () => {
		throw new Error("no agent expected");
	};
	assert.match(await run(dir, undefined, none).result, /^review: nothing to review, the diff of .* is empty$/);
	writeFileSync(join(dir, "package-lock.json"), '{"changed":true}\n');
	assert.equal(
		await run(dir, undefined, none).result,
		"review: nothing to review, all 1 changed files are on the skip list: package-lock.json",
	);
	assert.match(await run(dir, undefined, none, { noBash: true }).result, /^review: this run has no bash tool/);
	const s = sandbox();
	assert.equal(await run(s.root, undefined, none).result, "review: not inside a git repository");
	const empty = join(s.root, "empty");
	mkdirSync(empty);
	execFileSync("git", ["init", "-q"], { cwd: empty });
	assert.match(await run(empty, undefined, none).result, /^review: the repository has no commits yet/);
});

test("run: a pull request target uses gh and reports its failure", async () => {
	const { dir } = repoWithChanges();
	const bin = join(dir, "..", "bin");
	mkdirSync(bin);
	writeFileSync(
		join(bin, "gh"),
		'#!/bin/sh\nif [ "$2" = "view" ]; then echo "Fix the loop"; exit 0; fi\nif [ "$3" = "7" ]; then printf \'diff --git a/src/loop.ts b/src/loop.ts\\n--- a/src/loop.ts\\n+++ b/src/loop.ts\\n@@ -1 +1 @@\\n-a\\n+b\\n\'; exit 0; fi\necho "no pull request found" >&2; exit 1\n',
		{ mode: 0o755 },
	);
	const path = process.env.PATH;
	process.env.PATH = `${bin}:${path}`;
	try {
		const ok = run(dir, "#7", () => ({ findings: [] }));
		assert.match(await ok.result, /^Review of GitHub PR #7 Fix the loop/);
		assert.match(ok.calls[0]!.prompt, /src\/loop\.ts \(\+1 -1\)/);
		assert.equal(await run(dir, "#8", () => null).result, "review: gh pr diff 8 failed: no pull request found");
	} finally {
		process.env.PATH = path;
	}
});

// A real xpi (from source) in print mode: `/review` runs with the session's real bash tool inside the codemode sandbox,
// and its reviewer and verifier children are the fake pi (it answers every schema with the same value).
test("e2e: `xpi -p /review` reads the diff with the bash tool, runs the reviewers and prints the ranked result", async () => {
	const { s, dir } = repoWithChanges();
	writeFileSync(join(dir, "src/loop.ts"), "for (let i = 0; i <= n; i++) {}\n");
	const agentDir = join(s.root, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ subagent: { piCommand: FAKE_PI } }));
	const reply = {
		findings: [
			finding({
				title: "off by one",
				priority: "P1",
				confidence: 0.8,
				file: "src/loop.ts",
				lineStart: 1,
				lineEnd: 1,
			}),
		],
		dropped: [],
	};
	s.scenario({
		lines: [
			ev.session(),
			ev.tool("StructuredOutput"),
			ev.toolEnd("StructuredOutput", reply),
			ev.turnEnd({ stopReason: "toolUse" }),
			ev.settled(),
		],
	});
	const env = {
		...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/(_API_KEY|_AUTH_TOKEN)$/.test(k))),
		XPI_SKIP_VERSION_CHECK: "1",
		XPI_TELEMETRY: "0",
		HOME: s.home,
		XPI_CODING_AGENT_DIR: agentDir,
	};
	const cli = fileURLToPath(new URL("../../../src/cli.ts", import.meta.url));
	const r = await new Promise<{ code: number; out: string; err: string }>((resolve) => {
		const child = execFile(
			process.execPath,
			["--experimental-strip-types", "--no-warnings", cli, "--no-session", "--approve", "-p", "/review"],
			{ cwd: dir, env, timeout: 90_000 },
			(error, out, err) => resolve({ code: error ? 1 : 0, out, err }),
		);
		child.stdin?.end();
	});
	assert.equal(r.code, 0, r.err);
	assert.match(r.out, /Review of the uncommitted changes/);
	assert.match(r.out, /1\. \[P1\] off by one — src\/loop\.ts:1/);
	assert.match(r.out, /Reviewers: 1/);
});
