import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callAdapter, lines } from "./adapter.ts";
import {
	assertNoImport,
	currentBranch,
	dirtyPaths,
	type ImportRecord,
	importSpecs,
	inScope,
	localOnlySpecs,
	planSpecs,
	readImportRecord,
	removeImportRecord,
	revParse,
	scopeOf,
	writeImportRecord,
} from "./config.ts";
import { failure, precondition } from "./errors.ts";
import { git, splitZ } from "./git.ts";
import { withLock } from "./lock.ts";
import type { Repo } from "./registry.ts";
import { assertNoOtherSession } from "./sessions.ts";

export const lockOf = (repo: Repo): string => join(repo.ctx.store, `${repo.name}.lock`);

const MERGE_STOPPED =
	"the merge stopped. Resolve the conflicts with plain git, then xpi sg merge --continue (or xpi sg merge --abort).";

function list(title: string, paths: string[]): string {
	return `${title}\n${paths.map((path) => `  ${path}`).join("\n")}\n`;
}

function requireBranches(repo: Repo): void {
	for (const branch of ["host", "main"]) {
		if (git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { allowFail: true }).status !== 0) {
			throw precondition(`${repo.name} has no ${branch} branch`);
		}
	}
}

/** Exit 2 unless `main` is checked out with a clean tree. */
function requireCleanMain(repo: Repo, what: string): void {
	const branch = currentBranch(repo);
	if (branch !== "main") throw precondition(`${what} needs main checked out (now ${branch ?? "a detached HEAD"})`);
	const dirty = dirtyPaths(repo);
	if (dirty.length > 0)
		throw precondition(list(`${what} needs a clean tree; these paths have changes:`, dirty).trimEnd());
}

function runUpdate(repo: Repo): string {
	const label = lines(callAdapter(repo, "update"))[0]?.trim() || "update";
	return label.replace(/\s+/g, " ");
}

/** Put tracked local-only paths back as they are on `host`. Stop on a host file that collides with an untracked one. */
function restoreLocalOnly(repo: Repo): void {
	const specs = localOnlySpecs(repo);
	if (specs.length === 0) return;
	const changed = new Set(splitZ(git(repo, ["ls-files", "-m", "-d", "-z", "--", ...specs]).stdout));
	const files = [...changed];
	for (let at = 0; at < files.length; at += 200) git(repo, ["checkout", "--", ...files.slice(at, at + 200)]);
	const collisions = splitZ(git(repo, ["ls-files", "-o", "--exclude-standard", "-z", "--", ...specs]).stdout);
	if (collisions.length > 0) {
		throw failure(
			`${list("host has files at local-only paths that host does not track:", collisions)}` +
				"Rename one of them, or change shadow.localOnly (xpi sg config --add shadow.localOnly <glob>, or --unset-all), then run xpi sg import to resume, or xpi sg import --abort.",
		);
	}
}

/** Steps 4 to 6 of an import, from the adapter's label on. */
function finishImport(repo: Repo, record: ImportRecord & { label: string }): void {
	restoreLocalOnly(repo);
	git(repo, ["add", "-A", "--", ...importSpecs(repo)]);
	if (git(repo, ["diff", "--cached", "--quiet"], { allowFail: true }).status !== 0) {
		git(repo, ["commit", "-q", "-m", `sg: import ${record.label}`]);
	}
	removeImportRecord(repo);

	git(repo, ["checkout", "-q", "main", "--"]);
	const changedSince = (ref: string): string[] =>
		splitZ(git(repo, ["diff", "--name-only", "-z", record.old, ref, "--"]).stdout);
	const importedFiles = new Set(changedSince("host"));
	const both = changedSince("main").filter((path) => importedFiles.has(path));
	if (both.length > 0)
		repo.ctx.out(list(`changed in the import and in your work since the last import (${both.length}):`, both));

	const merged = git(repo, ["merge", "--no-edit", "host"], { allowFail: true });
	repo.ctx.out(merged.stdout);
	if (merged.stderr) repo.ctx.err(merged.stderr);
	if (merged.status !== 0) {
		throw failure(MERGE_STOPPED);
	}
	repo.ctx.out(`imported ${record.label}\n`);
}

/**
 * Bring the host's changes into `host` and merge them into `main`. A stopped import leaves `SG_IMPORT` and is resumed
 * by running import again.
 */
export async function importHost(repo: Repo): Promise<void> {
	assertNoOtherSession(repo, "import");
	await withLock(repo.ctx, lockOf(repo), () => {
		requireBranches(repo);
		let record = readImportRecord(repo);
		if (!record) {
			const dirty = dirtyPaths(repo);
			if (dirty.length > 0)
				throw precondition(list("import needs a clean tree; these paths have changes:", dirty).trimEnd());
			git(repo, ["checkout", "-q", "host", "--"]);
			record = { old: revParse(repo, "host") };
			writeImportRecord(repo, record);
		} else if (currentBranch(repo) !== "host") {
			// the user left host during the stop: their edits must not be committed into it
			const dirty = dirtyPaths(repo);
			if (dirty.length > 0)
				throw precondition(
					list("import cannot resume with changes in the tree; these paths have changes:", dirty).trimEnd(),
				);
			git(repo, ["checkout", "-q", "host", "--"]);
		}
		const label = record.label ?? runUpdate(repo);
		if (record.label === undefined) writeImportRecord(repo, { old: record.old, label });
		finishImport(repo, { old: record.old, label });
	});
}

/** Return to the last host state, drop what the update brought, and go back to `main`. */
export async function abortImport(repo: Repo): Promise<void> {
	assertNoOtherSession(repo, "import --abort");
	await withLock(repo.ctx, lockOf(repo), () => {
		if (!readImportRecord(repo))
			throw precondition("no import is stopped, nothing to abort (a conflicted merge: git merge --abort)");
		git(repo, ["checkout", "-q", "-f", "host", "--"]);
		const scope = scopeOf(repo);
		// Local-only paths are cleaned too: a host file at one of them would block the checkout of main.
		git(repo, [
			"clean",
			"-q",
			"-fd",
			"--",
			...(scope.length === 0 ? ["."] : scope.map((path) => `:(literal)${path.replace(/\/+$/, "")}`)),
			...localOnlySpecs(repo),
		]);
		git(repo, ["checkout", "-q", "main", "--"]);
		removeImportRecord(repo);
		repo.ctx.out("import aborted; the workspace is back at main\n");
	});
}

export interface PlanEntry {
	status: "A" | "M" | "D";
	path: string;
}

export interface ExportPlan {
	entries: PlanEntry[];
	subjects: string[];
}

/** `host..main` minus the local-only paths. A rename is a `D` and an `A`. */
export function exportPlan(repo: Repo): ExportPlan {
	const raw = splitZ(
		git(repo, ["diff", "--no-renames", "--name-status", "-z", "host", "main", "--", ...planSpecs(repo)]).stdout,
	);
	const entries: PlanEntry[] = [];
	for (let at = 0; at + 1 < raw.length; at += 2) {
		const code = raw[at][0];
		entries.push({ status: code === "A" || code === "D" ? code : "M", path: raw[at + 1] });
	}
	const subjects = lines(git(repo, ["log", "--reverse", "--format=%s", "host..main"]).stdout);
	return { entries, subjects };
}

function printPlan(repo: Repo, plan: ExportPlan): void {
	const n = plan.subjects.length;
	repo.ctx.out(`export plan: ${plan.entries.length} path(s) from ${n} commit(s) in host..main\n`);
	for (const subject of plan.subjects) repo.ctx.out(`  ${subject}\n`);
	for (const entry of plan.entries) repo.ctx.out(`${entry.status}\t${entry.path}\n`);
}

/** Print the plan of an export, or with `apply` check it in through the adapter and advance `host`. */
export async function exportMain(repo: Repo, apply: boolean): Promise<void> {
	assertNoImport(repo, "export");
	if (apply) assertNoOtherSession(repo, "export --apply");
	const run = (): void => {
		requireBranches(repo);
		requireCleanMain(repo, "export");
		if (git(repo, ["merge-base", "--is-ancestor", "host", "main"], { allowFail: true }).status !== 0) {
			throw precondition("host is not an ancestor of main; merge host into main first (xpi sg merge host)");
		}
		const plan = exportPlan(repo);
		printPlan(repo, plan);
		const scope = scopeOf(repo);
		const outside = plan.entries.filter((entry) => !inScope(scope, entry.path)).map((entry) => entry.path);
		if (outside.length > 0) {
			throw precondition(
				`${list("these paths are outside shadow.scope and cannot be exported:", outside)}Move them to another branch, or widen shadow.scope.`.trimEnd(),
			);
		}
		if (!apply) return;
		if (plan.entries.length > 0) {
			const message = `${plan.subjects[0] ?? "export"}${plan.subjects.length > 1 ? `\n\n${plan.subjects.map((s) => `- ${s}`).join("\n")}` : ""}\n`;
			const file = join(repo.ctx.store, `${repo.name}.checkin-message`);
			writeFileSync(file, message);
			try {
				callAdapter(repo, "checkin", {
					args: ["--message-file", file],
					input: `${plan.entries.map((entry) => `${entry.status}\t${entry.path}`).join("\n")}\n`,
				});
			} finally {
				rmSync(file, { force: true });
			}
		}
		const main = revParse(repo, "main");
		git(repo, ["update-ref", "-m", "sg: export", "refs/heads/host", main, revParse(repo, "host")]);
		repo.ctx.out(plan.entries.length > 0 ? "exported; host is at main\n" : "nothing to export; host is at main\n");
	};
	if (apply) await withLock(repo.ctx, lockOf(repo), run);
	else run();
}

/** Merge a branch into `main` in the primary workspace. */
export async function mergeBranch(repo: Repo, branch: string): Promise<void> {
	assertNoImport(repo, "merge");
	assertNoOtherSession(repo, "merge");
	await withLock(repo.ctx, lockOf(repo), () => {
		requireCleanMain(repo, "merge");
		if (
			git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`], { allowFail: true })
				.status !== 0
		) {
			throw precondition(`no branch ${branch}`);
		}
		const merged = git(repo, ["merge", "--no-edit", `refs/heads/${branch}`], { allowFail: true });
		repo.ctx.out(merged.stdout);
		if (merged.stderr) repo.ctx.err(merged.stderr);
		if (merged.status !== 0) throw failure(MERGE_STOPPED);
	});
}

/** Run `fn` as a writer of the primary workspace: no other live session, and the lock held. */
export async function asWriter<T>(repo: Repo, what: string, fn: () => T): Promise<T> {
	assertNoOtherSession(repo, what);
	return withLock(repo.ctx, lockOf(repo), fn);
}
