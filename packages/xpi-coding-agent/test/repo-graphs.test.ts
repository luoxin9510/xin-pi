// The two graphs this repository keeps for its own work, `.pi/graphs/dev.js` and `.pi/graphs/release.js`: they load,
// they pass the checks, and the checks do refuse them when a control is taken out.

import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { checkGraph, type Graph, GraphError, parseGraph } from "xpi-graph";
import { parseGraphText } from "../src/extensions/graph/files.ts";

interface RawGraph {
	name: string;
	start: string;
	nodes: Record<string, Record<string, unknown>>;
	edges: { from: string; to: string; exit: string; max?: number }[];
	requires: Record<string, unknown>[];
}

/** The literal of a graph file of this repository, as a fresh object a test may change. */
function literal(name: string): RawGraph {
	const path = fileURLToPath(new URL(`../../../.pi/graphs/${name}.js`, import.meta.url));
	return parseGraphText(readFileSync(path, "utf8")) as RawGraph;
}

const load = (raw: RawGraph): Graph => checkGraph(parseGraph(raw));

function problems(raw: RawGraph): string[] {
	try {
		load(raw);
	} catch (error) {
		if (error instanceof GraphError) return error.problems.map((problem) => `${problem.at}: ${problem.message}`);
		throw error;
	}
	return [];
}

const kinds = (graph: Graph) => Object.fromEntries(Object.entries(graph.nodes).map(([id, node]) => [id, node.kind]));

/** Temporary directories a test made; removed after each test. */
const made: string[] = [];

afterEach(() => {
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A command node's text, run with `sh -c` in `cwd`; `bin` is put first on `PATH` when given. */
function runSh(command: string, cwd: string, bin?: string) {
	const result = spawnSync("sh", ["-c", command], {
		cwd,
		encoding: "utf8",
		env: bin ? { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` } : process.env,
	});
	return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** A temporary repository with one commit on `main`. */
function repoOnMain(): string {
	const dir = mkdtempSync(join(tmpdir(), "graph-branch-"));
	made.push(dir);
	git(dir, "init", "-q", "-b", "main");
	git(
		dir,
		"-c",
		"user.name=test",
		"-c",
		"user.email=test@example.com",
		"-c",
		"commit.gpgsign=false",
		"commit",
		"-q",
		"--allow-empty",
		"-m",
		"init",
	);
	return dir;
}

/** A directory with a fake `gh` that has no pull request, and a fake `sleep` that logs each call. */
function fakeGh(): { bin: string; sleepLog: string } {
	const bin = mkdtempSync(join(tmpdir(), "graph-fake-gh-"));
	made.push(bin);
	const sleepLog = join(bin, "sleep.log");
	writeFileSync(join(bin, "gh"), "#!/bin/sh\necho 'no pull requests found for branch' >&2\nexit 1\n");
	writeFileSync(join(bin, "sleep"), `#!/bin/sh\necho called >> '${sleepLog}'\n`);
	chmodSync(join(bin, "gh"), 0o755);
	chmodSync(join(bin, "sleep"), 0o755);
	return { bin, sleepLog };
}

/** The run text of a command node of this repository's graphs. */
function runOf(name: string, id: string): string {
	const node = load(literal(name)).nodes[id];
	if (node.kind !== "command") throw new Error(`${name}.${id} is not a command node`);
	return node.run;
}

describe("the commands that make the branch and wait for CI", () => {
	describe("dev: branch", () => {
		it("makes the work branch from main", () => {
			const dir = repoOnMain();
			const result = runSh(runOf("dev", "branch"), dir);
			expect(result.status, result.output).toBe(0);
			expect(git(dir, "branch", "--show-current")).toMatch(/^dev-\d{8}-\d{6}$/);
		});

		it("fails on a detached HEAD and makes no branch", () => {
			const dir = repoOnMain();
			git(dir, "checkout", "-q", "--detach");
			const result = runSh(runOf("dev", "branch"), dir);
			expect(result.status).not.toBe(0);
			expect(result.output).toContain("detached");
			expect(git(dir, "branch", "--list", "dev-*")).toBe("");
		});

		it("fails on another branch and stays on it", () => {
			const dir = repoOnMain();
			git(dir, "switch", "-q", "-c", "feature");
			const result = runSh(runOf("dev", "branch"), dir);
			expect(result.status).not.toBe(0);
			expect(result.output).toContain("feature");
			expect(git(dir, "branch", "--show-current")).toBe("feature");
			expect(git(dir, "branch", "--list", "dev-*")).toBe("");
		});
	});

	describe.each(["dev", "release"])("%s: ci", (name) => {
		it("fails at once, without a wait, when the branch has no pull request", () => {
			const dir = repoOnMain();
			const { bin, sleepLog } = fakeGh();
			const result = runSh(runOf(name, "ci"), dir, bin);
			expect(result.status).not.toBe(0);
			expect(result.output).toContain('ci: no pull request for branch "main"');
			expect(result.output).toContain("no pull requests found");
			expect(existsSync(sleepLog)).toBe(false);
		});
	});
});

describe("the repository's own graphs", () => {
	describe("dev", () => {
		it("loads and passes the checks", () => {
			const graph = load(literal("dev"));
			expect(graph.name).toBe("dev");
			expect(kinds(graph)).toEqual({
				grill: "model",
				spec: "model",
				branch: "command",
				build: "model",
				ci: "command",
				review: "model",
				merge: "command",
			});
		});

		it("lets no model node run the merge or push to main", () => {
			const graph = load(literal("dev"));
			for (const id of ["build", "review"]) {
				const node = graph.nodes[id];
				expect(node.kind === "model" && node.deny).toContain("gh pr merge");
			}
			const build = graph.nodes.build;
			for (const text of [
				"git push origin main",
				"HEAD:main",
				"git push --force",
				"git switch main",
				"--no-verify",
			]) {
				expect(build.kind === "model" && build.deny, text).toContain(text);
			}
		});

		it("starts the build on a branch that is not main: a command node stands between the spec and the build", () => {
			const graph = load(literal("dev"));
			const into = (to: string) =>
				graph.edges.filter((edge) => edge.to === to).map((edge) => `${edge.from}:${edge.exit}`);
			expect(into("branch")).toEqual(["spec:approve"]);
			// From the spec the build is reached only through `branch`; the other two ways in come from later nodes.
			expect(into("build")).toEqual(["branch:pass", "ci:fail", "review:model"]);
			const branch = graph.nodes.branch;
			expect(branch.kind === "command" && branch.run).toContain("git switch -c");
		});

		it("keeps the nodes that only think or review from writing with the file tools", () => {
			const graph = load(literal("dev"));
			const readOnly = (id: string) => {
				const node = graph.nodes[id];
				return node.kind === "model" ? node.readOnly : [];
			};
			expect(readOnly("grill")).toEqual(["**"]);
			for (const id of ["spec", "review"]) {
				for (const pattern of ["packages/**", "scripts/**", "docs/**", ".github/**", "package.json"]) {
					expect(readOnly(id), `${id}: ${pattern}`).toContain(pattern);
				}
			}
			// The spec node writes under .scratch/, and the build node writes code.
			expect(readOnly("spec")).not.toContain("**");
			expect(readOnly("build")).toEqual([]);
		});

		it("is refused without its ci node", () => {
			const raw = literal("dev");
			delete raw.nodes.ci;
			raw.edges = raw.edges.filter((edge) => edge.from !== "ci" && edge.to !== "ci");
			raw.edges.push({ from: "build", to: "review", exit: "model" });
			expect(problems(raw)).toEqual(['requires[0].passed: no node "ci"']);
		});

		it("is refused with an edge from build straight to the merge, and the message shows the path", () => {
			const raw = literal("dev");
			raw.edges.push({ from: "build", to: "merge", exit: "model" });
			expect(problems(raw)).toEqual([
				'requires[0]: "merge" can be reached without a pass of "ci": grill -> spec -> branch -> build -> merge',
				'requires[0]: "merge" can be reached from "build" with no pass of "ci" after it: build -> merge',
			]);
		});

		it("is refused when the review may change code and merge without another check", () => {
			const raw = literal("dev");
			raw.nodes.patch = { prompt: "Make the small fixes the review asked for." };
			raw.edges.push({ from: "review", to: "patch", exit: "model" }, { from: "patch", to: "merge", exit: "model" });
			raw.requires = [{ before: "merge", passed: "ci", notAfter: ["build", "patch"] }];
			expect(problems(raw)).toEqual([
				'requires[0]: "merge" can be reached from "patch" with no pass of "ci" after it: patch -> merge',
			]);
		});

		it("limits its loops", () => {
			const graph = load(literal("dev"));
			const max = (from: string, to: string) =>
				graph.edges.find((edge) => edge.from === from && edge.to === to)?.max;
			expect(max("ci", "build")).toBe(3);
			expect(max("review", "build")).toBe(3);
			// Not set in the file: an edge on a loop gets the default.
			expect(max("build", "ci")).toBe(3);
			expect(max("grill", "spec")).toBeUndefined();
		});
	});

	describe("release", () => {
		it("loads and passes the checks", () => {
			const graph = load(literal("release"));
			expect(graph.name).toBe("release");
			expect(Object.keys(graph.nodes)).toEqual([
				"plan",
				"patch",
				"minor",
				"ci",
				"fix",
				"review",
				"merge",
				"sync",
				"main-ci",
				"tag",
				"done",
			]);
		});

		it("runs the bump, the merge and the tag itself, and asks before the bump and the merge", () => {
			const graph = load(literal("release"));
			for (const id of ["patch", "minor", "merge", "sync", "tag"]) expect(graph.nodes[id].kind).toBe("command");
			const exitInto = (to: string) => graph.edges.filter((edge) => edge.to === to).map((edge) => edge.exit);
			expect(exitInto("patch")).toEqual(["approve"]);
			expect(exitInto("minor")).toEqual(["approve"]);
			expect(exitInto("merge")).toEqual(["approve"]);
			expect(exitInto("tag")).toEqual(["pass"]);
		});

		it("lets no model node publish to npm or tag", () => {
			const graph = load(literal("release"));
			for (const [id, node] of Object.entries(graph.nodes)) {
				if (node.kind !== "model") continue;
				expect(node.deny, id).toContain("npm publish");
				expect(node.deny, id).toContain("git tag");
			}
			// The nodes before the tag may not run the tag script either, and none of them may merge.
			for (const id of ["plan", "fix", "review"]) {
				const node = graph.nodes[id];
				expect(node.kind === "model" && node.deny, id).toContain("release:tag");
			}
			for (const id of ["fix", "review"]) {
				const node = graph.nodes[id];
				expect(node.kind === "model" && node.deny, id).toContain("gh pr merge");
			}
		});

		it("waits for CI of the merge commit itself before the tag", () => {
			const graph = load(literal("release"));
			const node = graph.nodes["main-ci"];
			const run = node.kind === "command" ? node.run : "";
			expect(run).toContain("git rev-parse HEAD");
			expect(run).toContain("--commit");
			expect(run).toContain("--exit-status");
		});

		it("is refused when the tag can be reached without CI on main", () => {
			const raw = literal("release");
			raw.edges = raw.edges.filter((edge) => !(edge.from === "sync" && edge.to === "main-ci"));
			raw.edges.push({ from: "sync", to: "tag", exit: "pass" });
			expect(problems(raw)).toContain(
				'requires[2]: "tag" can be reached without a pass of "main-ci": plan -> patch -> ci -> review -> merge -> sync -> tag',
			);
		});

		it("is refused when the tag can be reached without the merge", () => {
			const raw = literal("release");
			raw.edges.push({ from: "review", to: "tag", exit: "model" });
			expect(
				problems(raw).some((problem) => problem.includes('"tag" can be reached without a pass of "merge"')),
			).toBe(true);
		});

		it("is refused when a fix can reach the merge without another check", () => {
			const raw = literal("release");
			raw.edges.push({ from: "fix", to: "merge", exit: "approve" });
			expect(problems(raw)).toContain(
				'requires[0]: "merge" can be reached from "fix" with no pass of "ci" after it: fix -> merge',
			);
		});
	});
});
