// Worktree isolation (v3b): one git worktree per isolated agent, on its own branch. Shells out to `git` only.
// Callers: agent-tool.ts (plan), exchange.ts (create before the run, settle after it).

import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

// Where a worktree is, and what it started from. Stored in the agent's meta file.
export interface WorktreeRef {
	root: string; // the main checkout (git root of the parent's cwd)
	path: string; // <root>/.pi/worktrees/<agentId>
	branch: string; // pipipi/<agentId>
	base: string; // commit the worktree started from
	subdir?: string; // the parent's cwd relative to the checkout; the child starts in the same directory inside the worktree
	removed?: "user"; // `/subagents worktrees` removed it (and its branch) while it held changes: a resume must not recreate it
}

// What an exchange leaves behind. `changed: false` means the worktree and its branch were removed; `gone` that the
// worktree's directory had already vanished when the exchange ended (the exchange then adds a warning).
export type WorktreeOutcome =
	| { changed: false; gone?: true }
	| { changed: true; path: string; branch: string; files: string[]; commits: string[]; note?: string };

const EXCLUDE_LINE = "/.pi/worktrees/";
const MAX_LISTED = 200; // files and commits reported per worktree

function git(cwd: string, args: string[], input?: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = execFile(
			"git",
			args,
			{ cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
			(err, stdout, stderr) => {
				if (!err) return resolve(stdout);
				const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
				const detail = missing
					? existsSync(cwd)
						? "git is not installed"
						: "the directory does not exist"
					: stderr.trim() || err.message;
				reject(
					Object.assign(new Error(`git ${args.slice(0, 2).join(" ")} failed in ${cwd}: ${detail}`), {
						exitCode: (err as { code?: unknown }).code,
					}),
				);
			},
		);
		if (input !== undefined) child.stdin!.end(input);
	});
}

const NOT_A_REPO = "not a git repository";

// The first `shown` entries of a list, indented two spaces, then an "N more" line. Shared by the result text for main
// and the `/subagents worktrees` confirm.
export function listLines(list: string[], shown: number): string[] {
	return [
		...list.slice(0, shown).map((e) => `  ${e}`),
		...(list.length > shown ? [`  ... and ${list.length - shown} more`] : []),
	];
}

const gitLine = async (cwd: string, args: string[]) => (await git(cwd, args)).trim();

// Git's own lock would fail concurrent `worktree add` calls in one repo: one at a time per root. In-process only: two pi
// processes in one repository are not serialised.
const locks = new Map<string, Promise<unknown>>();
function locked<T>(root: string, work: () => Promise<T>): Promise<T> {
	const run = (locks.get(root) ?? Promise.resolve()).then(work, work);
	const tail = run.then(
		() => {},
		() => {},
	);
	locks.set(root, tail);
	void tail.then(() => locks.get(root) === tail && locks.delete(root)); // idle: no entry left behind
	return run;
}

// Check that `cwd` is in a repository with a commit, and say where the worktree for `agentId` will be.
export async function planWorktree(cwd: string, agentId: string): Promise<WorktreeRef> {
	let root: string;
	try {
		root = await gitLine(cwd, ["rev-parse", "--show-toplevel"]);
	} catch (err) {
		if (!(err as Error).message.includes(NOT_A_REPO)) throw err;
		throw new Error(`isolation "worktree" needs a git repository: ${cwd} is not inside a git repository`);
	}
	let base: string;
	try {
		base = await gitLine(root, ["rev-parse", "--verify", "HEAD^{commit}"]);
	} catch {
		throw new Error(`isolation "worktree" needs a commit to start from: the repository at ${root} has no commits`);
	}
	return { root, path: join(root, ".pi", "worktrees", agentId), branch: `pipipi/${agentId}`, base };
}

// Append `line` to the repository's info/exclude once (also used for local agent memory).
export async function addExclude(root: string, line: string): Promise<void> {
	const file = resolve(root, await gitLine(root, ["rev-parse", "--git-path", "info/exclude"]));
	const text = existsSync(file) ? readFileSync(file, "utf8") : "";
	if (text.split(/\r?\n/).includes(line)) return;
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${line}\n`);
}

// The git root of `cwd`, or undefined outside a repository.
// In a linked worktree this is the main checkout (the parent of the shared `.git` directory).
export async function gitRoot(cwd: string): Promise<string | undefined> {
	try {
		const top = await gitLine(cwd, ["rev-parse", "--show-toplevel"]);
		const common = await gitLine(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).catch(() => "");
		return basename(common) === ".git" ? dirname(common) : top;
	} catch (err) {
		if (!(err as Error).message.includes(NOT_A_REPO)) throw err;
		return undefined;
	}
}

// Where in the worktree the child starts: the parent's cwd relative to the checkout, when that directory is in the
// commit the worktree starts from; else the worktree root, with a warning.
export async function worktreeSubdir(ref: WorktreeRef, cwd: string): Promise<{ subdir: string; warning?: string }> {
	const sub = relative(ref.root, cwd);
	if (sub === "" || sub.startsWith("..")) return { subdir: "" };
	try {
		await git(ref.root, ["cat-file", "-e", `${ref.base}:${sub.split(sep).join("/")}`]);
		return { subdir: sub };
	} catch {
		return {
			subdir: "",
			warning: `${cwd} is not in the worktree (it is untracked or new); the agent starts at the worktree root`,
		};
	}
}

// Claude Code's rules: gitignore syntax, and only files that match a pattern and are also gitignored are copied.
async function copyIncluded(root: string, path: string): Promise<void> {
	if (!existsSync(join(root, ".worktreeinclude"))) return;
	const listed = (
		await git(root, ["ls-files", "--others", "--ignored", "--exclude-from=.worktreeinclude", "-z"])
	).split("\0");
	const candidates = listed.filter((f) => f !== "" && !f.startsWith(".pi/worktrees/"));
	if (candidates.length === 0) return;
	// Exit code 1 means no candidate is ignored: nothing to copy. Any other failure is a real error.
	const checked = await git(root, ["check-ignore", "-z", "--stdin"], `${candidates.join("\0")}\0`).catch((err) => {
		if (err.exitCode === 1) return "";
		throw err;
	});
	const ignored = checked.split("\0");
	for (const file of ignored.filter((f) => f !== "")) {
		const to = join(path, file);
		if (existsSync(to)) continue;
		mkdirSync(dirname(to), { recursive: true });
		cpSync(join(root, file), to, { verbatimSymlinks: true });
	}
}

// Make sure the worktree exists. A kept one is re-entered as it is. Otherwise it is created from the main checkout's
// current HEAD (also when an unchanged one was removed after an earlier exchange): `ref.base` is updated. Returns warnings.
export function ensureWorktree(ref: WorktreeRef): Promise<string[]> {
	return locked(ref.root, async () => {
		if (existsSync(ref.path)) return [];
		if (ref.removed === "user") {
			throw new Error(
				`worktree ${ref.path} was removed by the user together with its changes; it cannot be resumed (start a new agent instead)`,
			);
		}
		const warnings: string[] = [];
		if ((await git(ref.root, ["branch", "--list", ref.branch])).trim() !== "") {
			throw new Error(
				`worktree ${ref.path} was removed but its branch ${ref.branch} still exists; remove the branch with "git branch -D ${ref.branch}" or restore the worktree with "git worktree add ${ref.path} ${ref.branch}"`,
			);
		}
		await addExclude(ref.root, EXCLUDE_LINE);
		await git(ref.root, ["worktree", "prune"]);
		if ((await git(ref.root, ["status", "--porcelain"])).trim() !== "") {
			warnings.push("the main checkout has uncommitted changes; the isolated agent does not see them");
		}
		ref.base = await gitLine(ref.root, ["rev-parse", "--verify", "HEAD^{commit}"]);
		await git(ref.root, ["worktree", "add", "-q", "-b", ref.branch, ref.path, ref.base]);
		try {
			await copyIncluded(ref.root, ref.path);
		} catch (err) {
			await remove(ref).catch(() => {}); // do not leave a half-made worktree behind
			throw err;
		}
		return warnings;
	});
}

// Entries of `git status --porcelain -z --ignored`: "XY path", and for a rename or copy the old path as an extra entry.
// Ignored files ("!!") count unless they are under .pi/ or a copy `.worktreeinclude` made that is still identical.
function statusPaths(out: string, ref: WorktreeRef): string[] {
	const entries = out.split("\0").filter((e) => e !== "");
	const paths: string[] = [];
	for (let i = 0; i < entries.length; i++) {
		const path = entries[i].slice(3);
		if (entries[i].startsWith("!!")) {
			if (!path.startsWith(".pi/") && !sameBytes(join(ref.path, path), join(ref.root, path))) paths.push(path);
		} else {
			paths.push(path);
			if (/^[RC]/.test(entries[i])) i++;
		}
	}
	return paths;
}

function sameBytes(a: string, b: string): boolean {
	try {
		return readFileSync(a).equals(readFileSync(b));
	} catch {
		return false;
	}
}

// Signs that work may sit outside the worktree's own branch: HEAD elsewhere, or a stash made on the branch.
async function strayNotes(ref: WorktreeRef): Promise<string[]> {
	const notes: string[] = [];
	const head = await gitLine(ref.path, ["symbolic-ref", "-q", "HEAD"]).catch(() => "");
	if (head !== `refs/heads/${ref.branch}`) {
		notes.push(
			`the worktree is not on branch ${ref.branch} (HEAD is ${head === "" ? "detached" : head.replace("refs/heads/", "")}); its commits may be reachable only from there`,
		);
	}
	const stashes = (await gitLine(ref.root, ["stash", "list", "--format=%gs"]))
		.split("\n")
		.filter((l) => /^(WIP on|On) /.test(l) && l.split(":")[0].endsWith(` ${ref.branch}`));
	if (stashes.length > 0)
		notes.push(
			`${stashes.length} stash entr${stashes.length === 1 ? "y" : "ies"} made on ${ref.branch} (git stash list)`,
		);
	return notes;
}

async function inspect(ref: WorktreeRef): Promise<WorktreeOutcome> {
	const status = statusPaths(
		await git(ref.path, ["status", "--porcelain", "-z", "--untracked-files=all", "--ignored"]),
		ref,
	);
	const head = await gitLine(ref.path, ["rev-parse", "HEAD"]);
	const notes = await strayNotes(ref);
	if (status.length === 0 && head === ref.base && notes.length === 0) return { changed: false };
	const committed =
		head === ref.base
			? []
			: (await git(ref.path, ["diff", "--name-only", "-z", ref.base, "HEAD"])).split("\0").filter((f) => f !== "");
	const commits =
		head === ref.base
			? []
			: (await gitLine(ref.path, ["log", "--format=%h %s", `${ref.base}..HEAD`]))
					.split("\n")
					.filter((l) => l !== "");
	const files = [...new Set([...status, ...committed])];
	return {
		changed: true,
		path: ref.path,
		branch: ref.branch,
		files: files.slice(0, MAX_LISTED),
		commits: commits.slice(0, MAX_LISTED),
		...(notes.length > 0 ? { note: notes.join("; ") } : {}),
	};
}

async function remove(ref: WorktreeRef): Promise<void> {
	if (existsSync(ref.path)) await git(ref.root, ["worktree", "remove", "--force", ref.path]);
	await git(ref.root, ["worktree", "prune"]);
	if ((await git(ref.root, ["branch", "--list", ref.branch])).trim() !== "")
		await git(ref.root, ["branch", "-D", ref.branch]); // already gone is fine
}

// End of an exchange, after the child has exited: an unchanged worktree is removed with its branch, a changed one is kept.
export function settleWorktree(ref: WorktreeRef): Promise<WorktreeOutcome> {
	return locked(ref.root, async () => {
		if (!existsSync(ref.path)) {
			// Someone deleted the directory during the run. The branch is left alone: it may hold commits.
			await git(ref.root, ["worktree", "prune"]);
			return { changed: false, gone: true };
		}
		const outcome = await inspect(ref);
		if (!outcome.changed) await remove(ref);
		return outcome;
	});
}

// Remove a worktree whatever it holds (`/subagents worktrees`).
export function removeWorktree(ref: WorktreeRef): Promise<void> {
	return locked(ref.root, () => remove(ref));
}

// A kept worktree as `/subagents worktrees` shows it.
export interface WorktreeInfo {
	agentId: string;
	ref: WorktreeRef; // base = the commit the branch forked from main's HEAD
	outcome: WorktreeOutcome; // changed: false = nothing in it yet
}

// The `pipipi/*` worktrees of the main checkout that `cwd` belongs to (also when `cwd` is inside one of them), from
// `git worktree list --porcelain`. Outside a repository: none.
export async function listWorktrees(cwd: string): Promise<WorktreeInfo[]> {
	let out: string;
	try {
		out = await git(cwd, ["worktree", "list", "--porcelain"]);
	} catch (err) {
		if (!(err as Error).message.includes(NOT_A_REPO)) throw err;
		return [];
	}
	const entries = out.split("\n\n").map((block) => {
		const field = (name: string) =>
			block
				.split("\n")
				.find((l) => l.startsWith(`${name} `))
				?.slice(name.length + 1);
		return { path: field("worktree"), branch: field("branch")?.replace(/^refs\/heads\//, "") };
	});
	const root = entries[0]?.path;
	if (root === undefined) return [];
	// A repository without commits has no HEAD to compare with: bases then default to each worktree's own HEAD.
	const mainHead = await gitLine(root, ["rev-parse", "HEAD"]).catch((err) => {
		if (err.exitCode === 128) return undefined;
		throw err;
	});
	const found: WorktreeInfo[] = [];
	const dir = join(root, ".pi", "worktrees") + sep;
	for (const { path } of entries.slice(1)) {
		// By location, not branch name: a detached or renamed branch still belongs to the agent. Its branch is pipipi/<id>.
		if (path === undefined || !path.startsWith(dir) || !existsSync(path)) continue;
		const branch = `pipipi/${basename(path)}`;
		const head = await gitLine(path, ["rev-parse", "HEAD"]);
		const base =
			mainHead === undefined
				? head
				: await gitLine(path, ["merge-base", head, mainHead]).catch((err) => {
						if (err.exitCode === 1) return head; // no common ancestor
						throw err;
					});
		const ref: WorktreeRef = { root, path, branch, base };
		found.push({ agentId: branch.slice("pipipi/".length), ref, outcome: await inspect(ref) });
	}
	return found;
}

// Where project and local agent memory live: the main checkout (git root of `cwd`, never an agent's worktree), else `cwd`.
// Local scope also keeps its directory out of git status through info/exclude. undefined for user memory or none.
export async function memoryRoot(
	memory: "user" | "project" | "local" | undefined,
	name: string,
	cwd: string,
): Promise<string | undefined> {
	if (memory !== "project" && memory !== "local") return undefined;
	const root = await gitRoot(cwd);
	if (root && memory === "local") await addExclude(root, `/.claude/agent-memory-local/${name}/`);
	return root ?? cwd;
}
