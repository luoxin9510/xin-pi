import { callAdapter } from "./adapter.ts";
import { configGet, currentBranch, readImportRecord } from "./config.ts";
import { git } from "./git.ts";
import type { Repo } from "./registry.ts";
import { listText } from "./sandbox.ts";
import { liveSessions } from "./sessions.ts";

/** git status, the commits ahead of `host`, the adapter's own summary, and a stopped import. */
export function status(repo: Repo): void {
	const out = repo.ctx.out;
	out(`repo ${repo.name}: ${repo.workspace} (adapter ${configGet(repo, "shadow.adapter") ?? "?"})\n`);
	const record = readImportRecord(repo);
	if (record) {
		out(
			`import STOPPED (SG_IMPORT, old host ${record.old.slice(0, 10)}${record.label ? `, label ${record.label}` : ", update not finished"}): xpi sg import resumes, xpi sg import --abort drops it\n`,
		);
	}
	const ahead = git(repo, ["rev-list", "--count", "host..main"], { allowFail: true });
	if (ahead.status === 0)
		out(
			`main is ${ahead.stdout.trim()} commit(s) ahead of host${currentBranch(repo) === "main" ? "" : ` (checked out: ${currentBranch(repo) ?? "detached"})`}\n`,
		);
	const sessions = liveSessions(repo);
	if (sessions.length > 0) out(`live sessions: pid ${sessions.join(", ")}\n`);
	out(git(repo, ["status", "--short", "--branch"]).stdout);
	const sandboxes = listText(repo);
	if (sandboxes.length > 0) out(`sandboxes:\n${sandboxes.map((line) => `  ${repo.name}/${line}`).join("\n")}\n`);
	try {
		const text = callAdapter(repo, "status").trimEnd();
		if (text)
			out(
				`host:\n${text
					.split("\n")
					.slice(0, 20)
					.map((line) => `  ${line}`)
					.join("\n")}\n`,
			);
	} catch (error) {
		out(`host: status unavailable (${(error as Error).message})\n`);
	}
}
