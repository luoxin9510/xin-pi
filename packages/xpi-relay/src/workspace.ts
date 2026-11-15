// What the extension runs itself in the session's directory: the acceptance commands, and git for the diff the lead
// reviews.

import { spawn } from "node:child_process";
import type { AcceptanceResult } from "./record.ts";

const OUTPUT_CHARS = 4000;

interface RunResult {
	code: number | null;
	timedOut: boolean;
	output: string;
}

/** Run a shell command. The whole process group is killed on timeout or abort. */
function run(
	command: string,
	cwd: string,
	timeoutMs: number,
	signal?: AbortSignal,
	keep = OUTPUT_CHARS,
): Promise<RunResult> {
	return new Promise((resolve) => {
		const posix = process.platform !== "win32";
		const child = spawn(command, { cwd, shell: true, detached: posix, stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		let timedOut = false;
		const add = (chunk: Buffer) => {
			output = (output + chunk.toString("utf8")).slice(-keep * 2);
		};
		child.stdout.on("data", add);
		child.stderr.on("data", add);
		const kill = () => {
			try {
				if (posix && child.pid) process.kill(-child.pid, "SIGKILL");
				else child.kill("SIGKILL");
			} catch {
				// already gone
			}
		};
		const timer = setTimeout(() => {
			timedOut = true;
			kill();
		}, timeoutMs);
		signal?.addEventListener("abort", kill, { once: true });
		const done = (code: number | null) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", kill);
			resolve({ code, timedOut, output: output.slice(-keep) });
		};
		child.on("error", (error) => {
			output += String(error.message);
			done(null);
		});
		child.on("close", done);
	});
}

export async function runAcceptance(
	commands: readonly string[],
	cwd: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<AcceptanceResult[]> {
	const results: AcceptanceResult[] = [];
	for (const command of commands) {
		if (signal?.aborted) break;
		results.push({ command, ...(await run(command, cwd, timeoutMs, signal)) });
	}
	return results;
}

const GIT_TIMEOUT_MS = 30_000;

/**
 * A commit that holds the work tree as it is now, without touching the tree, the index or the stash list. Undefined
 * outside a git repository or in one without commits.
 */
export async function snapshot(cwd: string): Promise<string | undefined> {
	const stash = await run("git stash create", cwd, GIT_TIMEOUT_MS);
	if (stash.code !== 0) return undefined;
	const id = stash.output.trim();
	if (/^[0-9a-f]{7,64}$/.test(id)) return id;
	// A clean tree: there is nothing to stash, the snapshot is HEAD.
	const head = await run("git rev-parse HEAD", cwd, GIT_TIMEOUT_MS);
	const headId = head.output.trim();
	return head.code === 0 && /^[0-9a-f]{7,64}$/.test(headId) ? headId : undefined;
}

/** What changed in the work tree since `base`: the stat, the diff up to `diffChars`, and files git does not track. */
export async function describeChanges(cwd: string, base: string | undefined, diffChars: number): Promise<string> {
	if (!base) return "";
	const stat = await run(`git diff --stat ${base}`, cwd, GIT_TIMEOUT_MS, undefined, 8000);
	if (stat.code !== 0) return `git diff failed:\n${stat.output.trim()}`;
	const parts: string[] = [];
	if (stat.output.trim()) parts.push("```", stat.output.trimEnd(), "```");
	const untracked = await run("git ls-files --others --exclude-standard", cwd, GIT_TIMEOUT_MS, undefined, 4000);
	if (untracked.code === 0 && untracked.output.trim()) {
		parts.push("Files git does not track (new files show here, not in the diff; some may predate the handover):");
		parts.push(
			...untracked.output
				.trim()
				.split("\n")
				.map((file) => `- ${file}`),
		);
	}
	if (stat.output.trim() && diffChars > 0) {
		const diff = await run(`git diff ${base}`, cwd, GIT_TIMEOUT_MS, undefined, 4_000_000);
		const text = diff.output;
		if (text.length <= diffChars) parts.push("```diff", text.trimEnd(), "```");
		else {
			parts.push(
				"```diff",
				text.slice(0, diffChars).trimEnd(),
				"```",
				`The diff is ${text.length} characters; the first ${diffChars} are above. Read the files you need, or run \`git diff ${base} -- <path>\`.`,
			);
		}
	}
	return parts.join("\n");
}
