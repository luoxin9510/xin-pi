// Long tasks: features of this repository, built again from their spec, and two multi-agent tasks (at the end).
//
// Features: The files of the commit before a feature was
// merged are exported into a new directory, without history: the merged solution must not be one `git show` away.
// The spec, the ticket and the feature's tests are copied in from the merge. The model works until the offline
// subagent suite passes. A task is about 1,200 changed lines over 20 files in the original.
//
// The copy shares node_modules with this checkout through links, so the workspace packages (xpi-ai, xpi-tui, ...) it
// runs against are this checkout's builds: run `npm run build` at the repository root first. Those links also lead
// to this checkout's source, where the feature exists; the runner reports a run that read it (`leak`).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { LIBRARIES, ledgerPackage, notesPackage, routerPackage } from "./multi-agent-fixtures.ts";
import { probe, read, type Task, unchanged, write } from "./tasks.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const PACKAGE = "packages/xpi-coding-agent";
const SUITE = [
	"test/subagent/faults/*.test.ts",
	"test/subagent/panel/*.test.ts",
	"test/subagent/worktree/*.test.ts",
	"test/subagent/memory/*.test.ts",
];

interface Feature {
	name: string;
	/** The pull request that merged the feature. */
	pr: number;
	spec: string;
	ticket: string;
	summary: string;
}

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-c", "user.name=eval", "-c", "user.email=eval@example.invalid", ...args], {
		cwd,
		stdio: ["ignore", "pipe", "pipe"],
		maxBuffer: 64 * 1024 * 1024,
	}).toString("utf8");

function mergeOf(pr: number): { base: string; head: string } {
	const merge = git(
		REPO,
		"log",
		"--merges",
		`--grep=Merge pull request #${pr} `,
		"--format=%H",
		"-1",
		"origin/main",
	).trim();
	if (!merge) throw new Error(`no merge commit for pull request #${pr}`);
	return { base: git(REPO, "rev-parse", `${merge}^1`).trim(), head: merge };
}

/** Offline test files and their support files that the feature added or changed. */
function testFiles(base: string, head: string): string[] {
	return git(REPO, "diff", "--name-only", base, head, "--", `${PACKAGE}/test/subagent`)
		.split("\n")
		.filter((path) => /\/test\/subagent\/(faults|panel|worktree|memory)\/|\/test\/subagent\/[^/]+$/.test(path));
}

function longTask(feature: Feature): Task {
	const where = () => mergeOf(feature.pr);
	return {
		name: feature.name,
		expect: "relay",
		timeoutMs: 45 * 60_000,
		prompt: [
			`Implement the feature specified in ${feature.spec} (ticket: ${feature.ticket}): ${feature.summary}`,
			`Most of the work is in ${PACKAGE}/src/extensions/subagent/. The tests for the feature are already in ${PACKAGE}/test/subagent/ and fail now.`,
			`You are done when \`npm run test:subagent\`, run in ${PACKAGE}, passes entirely. Update ${PACKAGE}/docs/subagent.md for what you add.`,
			"Do not edit anything under test/. Do not run npm install, do not start real-model tests, do not commit or push.",
		].join("\n"),
		setup(repo) {
			const { base, head } = where();
			mkdirSync(repo, { recursive: true });
			execFileSync("sh", ["-c", `git archive ${base} | tar -x -C '${repo}'`], { cwd: REPO, stdio: "ignore" });
			// Project extensions and prompts of that commit are not part of the task.
			rmSync(join(repo, ".pi"), { recursive: true, force: true });
			for (const path of [...testFiles(base, head), feature.spec, feature.ticket]) {
				const file = join(repo, path);
				mkdirSync(dirname(file), { recursive: true });
				writeFileSync(file, git(REPO, "show", `${head}:${path}`));
			}
			for (const modules of ["node_modules", `${PACKAGE}/node_modules`]) {
				if (existsSync(join(REPO, modules))) symlinkSync(join(REPO, modules), join(repo, modules));
			}
		},
		check(repo) {
			const { base, head } = where();
			for (const path of testFiles(base, head)) {
				const now = existsSync(join(repo, path)) ? readFileSync(join(repo, path), "utf8") : undefined;
				if (now !== git(REPO, "show", `${head}:${path}`)) return `${path} was changed or removed`;
			}
			try {
				// Through a shell, which expands the suite's globs.
				execFileSync(
					"sh",
					["-c", `node --test --experimental-strip-types ${SUITE.map((glob) => `'${glob}'`).join(" ")}`],
					{
						cwd: join(repo, PACKAGE),
						timeout: 300_000,
						killSignal: "SIGKILL",
						stdio: ["ignore", "pipe", "pipe"],
						maxBuffer: 64 * 1024 * 1024,
					},
				);
				return undefined;
			} catch (error) {
				const out = String((error as { stdout?: Buffer }).stdout ?? "");
				const failed = out.split("\n").filter((line) => line.startsWith("✖")).length;
				const counts = out
					.split("\n")
					.filter((line) => /^ℹ (pass|fail) /.test(line))
					.join(", ");
				return `the offline suite fails: ${counts || (error as Error).message.slice(0, 120)} (${failed} failing lines)`;
			}
		},
	};
}

/** A path that a run of a long task has no reason to read: this checkout's own subagent source. */
export const SOLUTION_PATH = join(REPO, PACKAGE, "src", "extensions", "subagent");

export const longTasks: Task[] = [
	longTask({
		name: "long: fork agent type",
		pr: 16,
		spec: ".scratch/xin-pi-workflows/04-fork.md",
		ticket: ".scratch/xin-pi-workflows/issues/04-fork.md",
		summary: 'the "fork" agent type and /subtask, a subagent that starts as a copy of the conversation.',
	}),
	longTask({
		name: "long: names and SendMessage",
		pr: 12,
		spec: ".scratch/xin-pi-workflows/03-names-and-messages.md",
		ticket: ".scratch/xin-pi-workflows/issues/03-names-and-messages.md",
		summary: "named subagents and the SendMessage tool, to steer a running agent or continue a finished one.",
	}),
	longTask({
		name: "long: agent file fields",
		pr: 15,
		spec: ".scratch/xin-pi-workflows/05-inert-fields.md",
		ticket: ".scratch/xin-pi-workflows/issues/05-inert-fields.md",
		summary: "the agent-file fields mcpServers and background, and the --agents command line flag.",
	}),
	// Larger features, added to find work the worker model cannot finish alone.
	longTask({
		name: "long: workflows",
		pr: 11,
		spec: ".scratch/xin-pi-workflows/02-workflows.md",
		ticket: ".scratch/xin-pi-workflows/issues/02-workflows.md",
		summary: "saved workflows: script helpers, /name commands, the Workflow tool and saving a script from the panel.",
	}),
	longTask({
		name: "long: relaunch and pause",
		pr: 22,
		spec: ".scratch/xin-pi-workflows/07-relaunch-and-pause.md",
		ticket: ".scratch/xin-pi-workflows/issues/07-relaunch-and-pause.md",
		summary: "recorded workflow runs, relaunching a run from its saved results, and pausing and resuming a script.",
	}),
	longTask({
		name: "long: structured output",
		pr: 10,
		spec: ".scratch/xin-pi-workflows/01-structured-output.md",
		ticket: ".scratch/xin-pi-workflows/issues/01-structured-output.md",
		summary: "the schema parameter of the Agent tool: a subagent returns a value that matches a JSON Schema.",
	}),
];

// Multi-agent tasks (spec 09, "Measuring"): three independent parts, each minutes of work, which fit three agents
// working at once. They run through the rpc driver, where scripts can run in the background, to measure how main
// waits for its agents.

const MULTI_TIMEOUT_MS = 900_000;

/** Run a package's tests; undefined when they pass. */
function testsPass(repo: string, dir: string): string | undefined {
	try {
		execFileSync("node", ["--test"], {
			cwd: join(repo, dir),
			timeout: 120_000,
			killSignal: "SIGKILL",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return undefined;
	} catch (error) {
		const out = String((error as { stdout?: Buffer }).stdout ?? "");
		const counts = out
			.split("\n")
			.filter((line) => /^ℹ (pass|fail) /.test(line))
			.join(", ");
		return `${dir}: tests fail (${counts || (error as Error).message.slice(0, 120)})`;
	}
}

// The tests and specs, which must stay as they are.
const libraryFixed = Object.fromEntries(
	LIBRARIES.flatMap((lib) => [
		[`packages/${lib.name}/test/${lib.name}.test.js`, lib.test],
		[`packages/${lib.name}/SPEC.md`, lib.spec],
	]),
);

const threeLibraries: Task = {
	name: "long: three libraries from specs",
	expect: "delegate",
	driver: "rpc",
	timeoutMs: MULTI_TIMEOUT_MS,
	prompt: [
		"This repository has three independent CommonJS packages that are only stubs: packages/csv, packages/semver and packages/ini.",
		"Each has a SPEC.md that defines its API exactly and tests in its test/ directory.",
		"Implement each package in its src/index.js, following its SPEC.md, so that `node --test` passes when run in that package's directory.",
		"Do not change the tests or the specs. Use no dependencies.",
	].join("\n"),
	setup(repo) {
		write(repo, "package.json", JSON.stringify({ name: "three-libraries", private: true }, null, 2));
		for (const lib of LIBRARIES) {
			const dir = `packages/${lib.name}`;
			write(
				repo,
				`${dir}/package.json`,
				JSON.stringify({ name: lib.name, version: "0.0.0", main: "src/index.js" }, null, 2),
			);
			write(repo, `${dir}/SPEC.md`, lib.spec);
			write(repo, `${dir}/src/index.js`, lib.stub);
			write(repo, `${dir}/test/${lib.name}.test.js`, lib.test);
		}
	},
	check(repo) {
		const changed = unchanged(repo, libraryFixed);
		if (changed) return changed;
		const failing = LIBRARIES.map((lib) => testsPass(repo, `packages/${lib.name}`)).filter(
			(why) => why !== undefined,
		);
		return failing.length > 0 ? failing.join("; ") : undefined;
	},
};

const ledger = ledgerPackage();
const router = routerPackage();
const notes = notesPackage();
const routerStrings = Object.entries(router.files).flatMap(([path, text]) =>
	text
		.split("\n")
		.filter((line) => line.includes('void "migrating'))
		.map((line) => ({ path, line })),
);

const threeAudits: Task = {
	name: "long: audit three packages",
	expect: "delegate",
	driver: "rpc",
	timeoutMs: MULTI_TIMEOUT_MS,
	prompt: [
		"Three independent jobs, one per package. Each package has 36 modules in its src/ directory; read every one, do not guess from a sample.",
		"",
		'1. packages/ledger: write packages/ledger/undocumented.json, a JSON array of the functions that a module exports (through `module.exports`) and that have no JSDoc block (`/** ... */`) ending on the line directly above their `function` line. Each entry is "<file name>:<function name>", such as "m07.js:loadEntry"; sort the array. A `//` comment or a `/* ... */` comment is not JSDoc.',
		"",
		"2. packages/router: `legacyRequest(url, method, body)` in lib/http.js is deprecated. Replace every call to it in src/ with `request({ url, method, body })` (leave out `body` when the call has none), import `request` instead, then remove `legacyRequest` from lib/http.js. The requests made must stay exactly the same. Text that only mentions legacyRequest, such as a string, is not a call: leave it.",
		"",
		'3. packages/notes: write packages/notes/todos.json with every line comment of the form `// TODO(<owner>): <text>` in src/ (also after code on the same line; not inside strings, and not `// TODO:` without an owner). The JSON is an object from owner to an array of {"file": "src/<name>.js", "line": <1-based line number>, "text": "<text>"}, each array sorted by file then line.',
	].join("\n"),
	setup(repo) {
		for (const [path, text] of Object.entries({ ...ledger.files, ...router.files, ...notes.files }))
			write(repo, path, text);
	},
	check(repo) {
		const why: string[] = [];
		// 1. ledger
		const undocumented = read(repo, "packages/ledger/undocumented.json");
		try {
			const got = JSON.parse(undocumented ?? "null");
			if (!isDeepStrictEqual(got, ledger.undocumented))
				why.push(
					`ledger: undocumented.json differs (${Array.isArray(got) ? got.length : "no array"} entries, expected ${ledger.undocumented.length})`,
				);
		} catch {
			why.push("ledger: undocumented.json missing or not JSON");
		}
		// 2. router: the modules make the same requests through request(), and legacyRequest is gone.
		const expected = JSON.stringify(router.calls);
		const routerCheck = probe(
			join(repo, "packages/router"),
			[
				'const Module = require("module");',
				'const path = require("path");',
				'const http = require("./lib/http");',
				'if ("legacyRequest" in http) { console.log("lib/http.js still exports legacyRequest"); process.exit(0); }',
				"const log = [];",
				"const stub = { request: (o) => { log.push(o); return { ok: true }; } };",
				"const load = Module._load;",
				"Module._load = function (request, parent, isMain) { if (/lib[\\/]http(\\.js)?$/.test(request)) return stub; return load.apply(this, arguments); };",
				"const got = {};",
				'for (const f of require("fs").readdirSync("src").sort()) { log.length = 0; require(path.resolve("src", f)).run(); got[f] = log.map((o) => JSON.parse(JSON.stringify(o))); }',
				`const want = ${expected};`,
				// Key order is free: request({ method, url }) is the same request.
				'const bad = Object.keys(want).filter((f) => !require("node:util").isDeepStrictEqual(got[f], want[f]));',
				'console.log(bad.length === 0 ? "ok" : "requests differ in " + bad.join(", "));',
			].join("\n"),
		);
		if (routerCheck) why.push(`router: ${routerCheck}`);
		for (const { path, line } of routerStrings)
			if (!(read(repo, path) ?? "").split("\n").includes(line)) {
				why.push(`router: ${path} lost a string that only mentions legacyRequest`);
				break;
			}
		// 3. notes
		try {
			const got = JSON.parse(read(repo, "packages/notes/todos.json") ?? "null");
			// Key order (owners, and the fields of an entry) is free; the arrays are sorted by the task.
			if (!isDeepStrictEqual(got, notes.todos)) why.push("notes: todos.json differs");
		} catch {
			why.push("notes: todos.json missing or not JSON");
		}
		return why.length > 0 ? why.join("; ") : undefined;
	},
};

longTasks.push(threeLibraries, threeAudits);
