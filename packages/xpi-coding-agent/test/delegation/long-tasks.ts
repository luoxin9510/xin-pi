// Long tasks: features of this repository, built again from their spec. The files of the commit before a feature was
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
import type { Task } from "./tasks.ts";

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
			`The work is in ${PACKAGE}/src/extensions/subagent/. The tests for the feature are already in ${PACKAGE}/test/subagent/ and fail now.`,
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
];
