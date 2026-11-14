// Worktree isolation in a shadow-git workspace: the second kind of `WorktreeRef`. Instead of a git worktree at
// `<root>/.pi/worktrees/<agentId>`, the agent gets the sandbox `sub-<agentId>` (a teammate `team-<name>`) of the
// workspace's shadow repo, on branch `sbx/<id>`, and its child process runs in it through the sandbox's backend.
// worktree.ts dispatches here by `ref.kind`; docs/shadow-git.md, "Agents in xpi".

import { existsSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
	changedFiles,
	createSandbox,
	currentBranch,
	dirtyPaths,
	git,
	listSandboxes,
	loadSandbox,
	prepareLaunch,
	type Repo,
	removeSandbox,
	resolveBackend,
	resolveRepo,
	revParse,
	sandboxesDir,
	sandboxGit,
	splitZ,
} from "xpi-shadow-git";
import { quietContext } from "../shadow-git/workspace.ts";
import type { WorktreeInfo, WorktreeOutcome, WorktreeRef } from "./worktree.ts";

const MAX_LISTED = 200; // files and commits reported per sandbox

/** The sandboxes xpi makes for agents: `sub-<agentId>` for isolation, `team-<name>` for a teammate. */
const AGENT_SANDBOX = /^(sub|team)-/;

const repoOf = (ref: WorktreeRef): Repo => resolveRepo(quietContext(ref.root), ref.repo);

/** Where an agent's own work starts: the primary's current branch, else its HEAD. */
const startPoint = (repo: Repo): string => currentBranch(repo) ?? "HEAD";

export function planSandbox(repo: Repo, id: string): WorktreeRef {
	const branch = `sbx/${id}`;
	const tree = join(sandboxesDir(repo), id, "tree");
	if (
		existsSync(tree) ||
		git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { allowFail: true }).status === 0
	) {
		throw new Error(
			`shadow-git sandbox ${id} exists already (an earlier agent of that name left it); merge ${branch} with /sg merge, then remove it with /subagents worktrees, or choose another name`,
		);
	}
	let base: string;
	try {
		base = revParse(repo, startPoint(repo));
	} catch {
		throw new Error(`isolation "worktree" needs a commit to start from: the shadow repo ${repo.name} has no commits`);
	}
	return {
		kind: "shadow-git",
		root: repo.workspace,
		path: tree,
		branch,
		base,
		repo: repo.name,
		sandbox: id,
		backend: resolveBackend(repo, false),
	};
}

/** Whether the parent's cwd is in the commit the sandbox starts from; else the child starts at the root, with a warning. */
export function sandboxSubdir(ref: WorktreeRef, cwd: string): { subdir: string; warning?: string } {
	const sub = relative(ref.root, realpathSync(cwd));
	if (sub === "" || sub.startsWith("..")) return { subdir: "" };
	const found = git(repoOf(ref), ["cat-file", "-e", `${ref.base}:${sub.split(sep).join("/")}`], { allowFail: true });
	if (found.status === 0) return { subdir: sub };
	return {
		subdir: "",
		warning: `${cwd} is not in the sandbox (it is untracked or new); the agent starts at the sandbox root`,
	};
}

/** Create the sandbox when it is not there. A kept one is re-entered as it is. Returns warnings. */
export function ensureSandbox(ref: WorktreeRef): string[] {
	if (existsSync(ref.path)) return [];
	if (ref.removed === "user") {
		throw new Error(
			`sandbox ${ref.sandbox} was removed by the user together with its changes; it cannot be resumed (start a new agent instead)`,
		);
	}
	const repo = repoOf(ref);
	if (git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${ref.branch}`], { allowFail: true }).status === 0) {
		throw new Error(
			`sandbox ${ref.sandbox} was removed but its branch ${ref.branch} still exists; merge it (/sg merge ${ref.branch}) or delete it with "xpi sg branch -D ${ref.branch}"`,
		);
	}
	const warnings: string[] = [];
	if (dirtyPaths(repo).length > 0) {
		warnings.push("the workspace has uncommitted changes; the sandboxed agent does not see them");
	}
	const from = startPoint(repo);
	ref.base = revParse(repo, from);
	createSandbox(repo, ref.sandbox!, { from });
	ref.backend = resolveBackend(repo, false);
	return warnings;
}

/** What a sandbox holds that its branch point does not: changed files and commits, or `changed: false` when nothing. */
function inspectSandbox(repo: Repo, ref: WorktreeRef): WorktreeOutcome {
	const sbx = loadSandbox(repo, ref.sandbox!);
	const status = changedFiles(sbx).map((entry) => entry.slice(3));
	const head = sandboxGit(sbx, ["rev-parse", "HEAD"]).stdout.trim();
	const notes: string[] = [];
	const onBranch = sandboxGit(sbx, ["symbolic-ref", "-q", "HEAD"], { allowFail: true }).stdout.trim();
	if (onBranch !== `refs/heads/${ref.branch}`) {
		notes.push(
			`the sandbox is not on branch ${ref.branch} (HEAD is ${onBranch === "" ? "detached" : onBranch.replace("refs/heads/", "")}); its commits may be reachable only from there`,
		);
	}
	if (status.length === 0 && head === ref.base && notes.length === 0) return { changed: false };
	const committed =
		head === ref.base ? [] : splitZ(sandboxGit(sbx, ["diff", "--name-only", "-z", ref.base, "HEAD"]).stdout);
	const commits =
		head === ref.base
			? []
			: sandboxGit(sbx, ["log", "--format=%h %s", `${ref.base}..HEAD`])
					.stdout.split("\n")
					.filter((line) => line !== "");
	return {
		changed: true,
		path: ref.path,
		branch: ref.branch,
		files: [...new Set([...status, ...committed])].slice(0, MAX_LISTED),
		commits: commits.slice(0, MAX_LISTED),
		note: [...notes, `the user merges it with /sg merge ${ref.branch}`].join("; "),
	};
}

/** End of an exchange: a sandbox with no changes and no commits is removed with its branch; otherwise it is kept. */
export function settleSandbox(ref: WorktreeRef): WorktreeOutcome {
	const repo = repoOf(ref);
	if (!existsSync(ref.path)) {
		// Someone removed the directory during the run. The branch is left alone: it may hold commits.
		git(repo, ["worktree", "prune"]);
		return { changed: false, gone: true };
	}
	const outcome = inspectSandbox(repo, ref);
	if (!outcome.changed) removeSandbox(repo, ref.sandbox!, false, true);
	return outcome;
}

/** Remove a sandbox and its branch whatever it holds (`/subagents worktrees`). */
export function removeSandboxWorktree(ref: WorktreeRef): void {
	removeSandbox(repoOf(ref), ref.sandbox!, true, true);
}

/** The kept sandboxes xpi made for agents in the workspace that contains `cwd`. */
export function listSandboxWorktrees(repo: Repo): WorktreeInfo[] {
	const found: WorktreeInfo[] = [];
	const from = startPoint(repo);
	for (const sbx of listSandboxes(repo)) {
		if (!AGENT_SANDBOX.test(sbx.id)) continue;
		const head = sandboxGit(sbx, ["rev-parse", "HEAD"]).stdout.trim();
		const merged = git(repo, ["merge-base", sbx.branch, from], { allowFail: true });
		const ref: WorktreeRef = {
			kind: "shadow-git",
			root: repo.workspace,
			path: sbx.tree,
			branch: sbx.branch,
			base: merged.status === 0 ? merged.stdout.trim() : head,
			repo: repo.name,
			sandbox: sbx.id,
		};
		found.push({ agentId: sbx.id.replace(/^sub-/, ""), ref, outcome: inspectSandbox(repo, ref) });
	}
	return found;
}

/**
 * Open the sandbox for a child: its links are refreshed and the backend chosen. The result says what to start instead
 * of the child's own command (the same wrapper `xpi sg sbx run` uses).
 */
export async function sandboxLauncher(ref: WorktreeRef) {
	const launch = await prepareLaunch(repoOf(ref), ref.sandbox!, false);
	return (command: string, args: string[], env: NodeJS.ProcessEnv) => {
		const wrapped = launch.wrap([command, ...args], { env, subdir: ref.subdir });
		return { command: wrapped.file, args: wrapped.args, cwd: wrapped.cwd, env: wrapped.env };
	};
}
