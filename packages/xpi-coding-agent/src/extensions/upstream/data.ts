// Gathers the facts for /upstream into a data file. Git mode reads a local checkout with an `upstream` remote;
// fallback mode compares upstream's CHANGELOG (GitHub raw) with this build's version and is marked partial.
// Nothing here edits the checkout: the only git write is `git fetch upstream` (updates remote-tracking refs).

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describeUpstreamPath, groupOf, mapUpstreamPath } from "./paths.ts";

const run = promisify(execFile);

export const CHANGELOG_URL =
	"https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/CHANGELOG.md";
const MAX_COMMITS = 400;
const MAX_FILES_PER_COMMIT = 8;
const MAX_CHANGELOG_LINES = 250;
const MAX_OWN_FILES = 40;
const MAX_OVERLAP = 40;
const MAX_BOTH = 80;

export type FetchFn = (
	url: string,
	init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** How long the CHANGELOG fallback waits for GitHub. */
export const FETCH_TIMEOUT_MS = 15_000;

export interface GatherOptions {
	sourceDir: string;
	agentDir: string;
	/** Version of this build's coding agent (fallback mode compares against it). */
	version: string;
	fetch?: FetchFn;
	/** Timeout of the CHANGELOG fallback request; default {@link FETCH_TIMEOUT_MS}. */
	fetchTimeoutMs?: number;
	now?: Date;
	/** Branch of the `upstream` remote; default: the remote's default branch (`main` when it cannot be told). */
	upstreamBranch?: string;
	/** Our product branch; default `main`. */
	ourBranch?: string;
}

export interface GatherResult {
	mode: "git" | "fallback";
	partial: boolean;
	stamp: string;
	dataPath: string;
	reportPath: string;
	/** One-line description of what ran, for the notice. */
	summary: string;
	notes: string[];
}

export function stampOf(d: Date): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function firstLine(err: unknown): string {
	return (err instanceof Error ? err.message : String(err)).split("\n")[0];
}

async function git(dir: string, args: string[], timeout = 30_000): Promise<string> {
	const { stdout } = await run("git", ["-C", dir, ...args], {
		encoding: "utf8",
		timeout,
		maxBuffer: 64 * 1024 * 1024,
		// Never wait for a credential prompt: a private or renamed remote fails instead of hanging.
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
	});
	return stdout;
}

async function gitOk(dir: string, args: string[]): Promise<string | undefined> {
	try {
		return (await git(dir, args)).trim();
	} catch {
		return undefined;
	}
}

interface Commit {
	hash: string;
	date: string;
	author: string;
	subject: string;
	files: string[];
}

function parseLog(out: string): Commit[] {
	const commits: Commit[] = [];
	for (const block of out.split("\x1e")) {
		const lines = block.split("\n").filter((l) => l !== "");
		if (lines.length === 0) continue;
		const [hash, date, author, subject] = lines[0].split("\x1f");
		commits.push({ hash, date, author, subject, files: lines.slice(1) });
	}
	return commits;
}

/** Resolves a numstat path, which may be a rename like `packages/{ai => xpi-ai}/x.ts` or `a => b`, to the new path. */
export function numstatNewPath(p: string): string {
	const brace = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(p);
	if (brace) return `${brace[1]}${brace[3]}${brace[4]}`.replace(/\/\//g, "/").replace(/^\//, "");
	const arrow = / => /.exec(p);
	return arrow ? p.slice(arrow.index + 4) : p;
}

/**
 * The branch to compare with: the remote's default branch. Read from `refs/remotes/upstream/HEAD` when the clone set it,
 * else asked from the remote (`git ls-remote --symref`), else `main`. Reads only: nothing is written.
 */
export async function defaultUpstreamBranch(dir: string): Promise<string> {
	const head = await gitOk(dir, ["symbolic-ref", "--short", "refs/remotes/upstream/HEAD"]);
	if (head?.startsWith("upstream/")) return head.slice("upstream/".length);
	const remote = await gitOk(dir, ["ls-remote", "--symref", "upstream", "HEAD"]);
	const m = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(remote ?? "");
	return m?.[1] ?? "main";
}

/** Signals that git mode cannot run for a reason the caller answers with the CHANGELOG fallback. */
class NoUpstreamBranch extends Error {}

interface Body {
	body: string;
	notes: string[];
	summary: string;
}

async function gitMode(o: GatherOptions, stamp: string): Promise<Body> {
	const notes: string[] = [];
	const ours = o.ourBranch ?? "main";
	const up = o.upstreamBranch ?? (await defaultUpstreamBranch(o.sourceDir));
	let fetched = "";
	try {
		await git(o.sourceDir, ["fetch", "upstream"], 120_000);
		fetched = `fetched just now (${new Date().toISOString()})`;
	} catch (err) {
		notes.push(`git fetch upstream failed (${firstLine(err)}); using the last fetched upstream/${up}`);
	}
	const upRef = `upstream/${up}`;
	if ((await gitOk(o.sourceDir, ["rev-parse", "--verify", `${upRef}^{commit}`])) === undefined) {
		throw new NoUpstreamBranch(`${upRef} does not exist in ${o.sourceDir}`);
	}
	const ourRef = (await gitOk(o.sourceDir, ["rev-parse", "--verify", `${ours}^{commit}`])) ? ours : "HEAD";
	if (ourRef !== ours) notes.push(`branch ${ours} not found; compared with HEAD`);
	const head = await gitOk(o.sourceDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
	if (ourRef === ours && head && head !== "HEAD" && head !== ours) {
		const ahead = await gitOk(o.sourceDir, ["rev-list", "--count", `${ours}..HEAD`]);
		if (ahead && ahead !== "0") {
			notes.push(
				`the checkout is on branch ${head}, ${ahead} commits ahead of ${ours}; those are not in "our changes"`,
			);
		}
	}
	const base = await gitOk(o.sourceDir, ["merge-base", ourRef, upRef]);
	if (!base) throw new Error(`no common history between ${ourRef} and ${upRef}`);

	// Upstream commits since the fork point.
	const logOut = await git(o.sourceDir, [
		"log",
		"--no-merges",
		"--name-only",
		"--format=%x1e%h%x1f%aI%x1f%an%x1f%s",
		`${base}..${upRef}`,
	]);
	const all = parseLog(logOut);
	const commits = all.slice(0, MAX_COMMITS);

	// Our changes: per-package diff stat of ours vs the fork point, in xpi-* names.
	const numstat = await git(o.sourceDir, ["diff", "-M30%", "--numstat", base, ourRef]);
	const groups = new Map<string, { files: number; add: number; del: number }>();
	const ownFiles = new Map<string, number>();
	for (const line of numstat.split("\n")) {
		const m = /^(\S+)\t(\S+)\t(.*)$/.exec(line);
		if (!m) continue;
		const raw = numstatNewPath(m[3]);
		// A file whose rename git did not detect shows as an add under xpi-* and a delete under the old name: fold them.
		const path = mapUpstreamPath(raw).path ?? raw;
		const add = m[1] === "-" ? 0 : Number(m[1]);
		const del = m[2] === "-" ? 0 : Number(m[2]);
		const key = groupOf(path);
		const g = groups.get(key) ?? { files: 0, add: 0, del: 0 };
		g.files++;
		g.add += add;
		g.del += del;
		groups.set(key, g);
		ownFiles.set(path, add + del);
	}

	// Upstream files that xin-pi also changed (mapped to our names) are the conflict candidates.
	const touched = new Map<string, Set<string>>(); // our path -> upstream commit hashes
	const removedTouched = new Set<string>();
	for (const c of all) {
		for (const f of c.files) {
			const mp = mapUpstreamPath(f);
			if (mp.removed) {
				removedTouched.add(f);
				continue;
			}
			if (mp.path && ownFiles.has(mp.path)) {
				const s = touched.get(mp.path) ?? new Set<string>();
				s.add(c.hash);
				touched.set(mp.path, s);
			}
		}
	}

	// Overlap candidates: commits that look like subagents, background scripts, codemode, or worktrees.
	const overlapRe = /sub-?agent|\bagent tool\b|background|codemode|detach|worktree/i;
	const overlap = commits.filter((c) => overlapRe.test(c.subject) || c.files.some((f) => overlapRe.test(f)));

	const L: string[] = [];
	L.push(`# Upstream data (git mode, ${stamp})`, "");
	L.push(`- source: ${o.sourceDir}`);
	L.push(
		`- upstream ref: ${upRef} (${await gitOk(o.sourceDir, ["rev-parse", "--short", upRef])})${fetched ? `, ${fetched}` : ""}`,
	);
	L.push(`- our ref: ${ourRef} (${await gitOk(o.sourceDir, ["rev-parse", "--short", ourRef])})`);
	L.push(`- fork point (merge-base): ${base.slice(0, 9)}`);
	L.push(
		`- upstream commits since the fork point: ${all.length}${all.length > MAX_COMMITS ? ` (first ${MAX_COMMITS} listed)` : ""}`,
	);
	for (const n of notes) L.push(`- note: ${n}`);
	L.push(
		"",
		"Path mapping: upstream `packages/<x>` is `packages/xpi-<x>` here (agent -> xpi-agent-core); chord, durable, env and apps/* are removed in xin-pi.",
		"",
	);

	L.push("## Upstream commits since the fork point", "");
	if (commits.length === 0) L.push("(none: xin-pi is at the fork point)");
	for (const c of commits) {
		L.push(`- ${c.hash} ${c.date.slice(0, 10)} ${c.author}: ${c.subject}`);
		const shown = c.files.slice(0, MAX_FILES_PER_COMMIT).map(describeUpstreamPath);
		if (shown.length) {
			const more = c.files.length > shown.length ? `, ... +${c.files.length - shown.length} more` : "";
			L.push(`  files: ${shown.join(", ")}${more}`);
		}
	}
	L.push("");

	L.push("## Our changes since the fork point (diff stat, xpi-* names)", "");
	const sorted = [...groups.entries()].sort((a, b) => b[1].add + b[1].del - (a[1].add + a[1].del));
	if (sorted.length === 0) L.push("(none)");
	for (const [g, s] of sorted) L.push(`- ${g}: ${s.files} files, +${s.add} -${s.del}`);
	const biggest = [...ownFiles.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_OWN_FILES);
	if (biggest.length) {
		L.push("", `Largest changed files (top ${biggest.length}):`);
		for (const [p, n] of biggest) L.push(`- ${p} (${n} lines)`);
	}
	L.push("");

	L.push("## Files changed on both sides (conflict candidates, our names)", "");
	if (touched.size === 0) L.push("(none)");
	for (const [p, hs] of [...touched.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, MAX_BOTH)) {
		const list = [...hs].slice(0, 5).join(", ") + (hs.size > 5 ? ", ..." : "");
		L.push(`- ${p}: ${hs.size} upstream commit${hs.size === 1 ? "" : "s"} (${list})`);
	}
	if (removedTouched.size) {
		L.push(
			"",
			`Upstream also changed ${removedTouched.size} files in removed packages (chord, durable, env, apps): skip.`,
		);
	}
	L.push("");

	L.push("## Overlap candidates with xin-pi built-ins", "");
	L.push(
		"xin-pi built-ins: `subagent` (Agent tool, /subagents, background codemode scripts), `codemode` (native background scripts), `upstream`.",
		"",
	);
	if (overlap.length === 0) L.push("(no upstream commit looks related)");
	for (const c of overlap.slice(0, MAX_OVERLAP)) L.push(`- ${c.hash} ${c.subject}`);
	if (overlap.length > MAX_OVERLAP) L.push(`- ... +${overlap.length - MAX_OVERLAP} more`);
	L.push("");

	L.push("## New upstream coding-agent CHANGELOG entries", "");
	const cl = await gitOk(o.sourceDir, [
		"diff",
		"--unified=0",
		base,
		upRef,
		"--",
		"packages/coding-agent/CHANGELOG.md",
	]);
	const added = (cl ?? "")
		.split("\n")
		.filter((l) => l.startsWith("+") && !l.startsWith("+++") && l.trim() !== "+")
		.map((l) => l.slice(1));
	if (added.length === 0) L.push("(none)");
	for (const l of added.slice(0, MAX_CHANGELOG_LINES)) L.push(l);
	if (added.length > MAX_CHANGELOG_LINES) {
		L.push(`... +${added.length - MAX_CHANGELOG_LINES} more lines (see the changelog in ${upRef})`);
	}
	L.push("");
	return { body: L.join("\n"), notes, summary: `git mode: ${all.length} upstream commits since ${base.slice(0, 9)}` };
}

function cmpVersion(a: string, b: string): number {
	const pa = a.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
	const pb = b.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d !== 0) return d;
	}
	return 0;
}

export function newerChangelogSections(text: string, version: string): { heading: string; lines: string[] }[] {
	const sections: { heading: string; lines: string[] }[] = [];
	let cur: { heading: string; lines: string[] } | undefined;
	for (const line of text.split("\n")) {
		const h = /^## \[?([^\]\s]+)\]?/.exec(line);
		if (h) {
			cur = { heading: h[1], lines: [] };
			sections.push(cur);
		} else cur?.lines.push(line);
	}
	return sections.filter((s) => s.heading.toLowerCase() === "unreleased" || cmpVersion(s.heading, version) > 0);
}

async function fallbackMode(o: GatherOptions, stamp: string, why: string): Promise<Body> {
	const doFetch: FetchFn = o.fetch ?? ((url, init) => fetch(url, init));
	let text: string;
	try {
		const res = await doFetch(CHANGELOG_URL, { signal: AbortSignal.timeout(o.fetchTimeoutMs ?? FETCH_TIMEOUT_MS) });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		text = await res.text();
	} catch (err) {
		const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
		throw new Error(
			`could not fetch upstream CHANGELOG (${timedOut ? `no answer within ${(o.fetchTimeoutMs ?? FETCH_TIMEOUT_MS) / 1000}s` : firstLine(err)}) from ${CHANGELOG_URL}`,
			{ cause: err },
		);
	}
	const sections = newerChangelogSections(text, o.version);
	const L: string[] = [];
	L.push(`# Upstream data (fallback mode, partial, ${stamp})`, "");
	L.push(`- reason: ${why}`);
	L.push(`- source: ${CHANGELOG_URL}`);
	L.push(`- this build's coding-agent version: ${o.version}`);
	L.push(
		"- PARTIAL: only upstream's CHANGELOG is available. No commit list, no diff stat, no file overlap: say so in the report and mark confidence low.",
		"",
	);
	L.push("## New upstream coding-agent CHANGELOG entries", "");
	if (sections.length === 0) L.push("(none newer than this build)");
	let n = 0;
	for (const s of sections) {
		L.push(`### ${s.heading}`);
		for (const l of s.lines) {
			if (l.trim() === "") continue;
			if (n++ >= MAX_CHANGELOG_LINES) break;
			L.push(l);
		}
	}
	if (n > MAX_CHANGELOG_LINES) L.push("... (truncated)");
	L.push("");
	return {
		body: L.join("\n"),
		notes: [why],
		summary: `fallback mode (partial): ${sections.length} upstream changelog sections newer than ${o.version}`,
	};
}

/** True when `dir` is a git checkout with a remote named `upstream`. */
export async function isUpstreamCheckout(dir: string): Promise<boolean> {
	if (!existsSync(dir)) return false;
	if ((await gitOk(dir, ["rev-parse", "--git-dir"])) === undefined) return false;
	return (await gitOk(dir, ["remote", "get-url", "upstream"])) !== undefined;
}

export async function gather(o: GatherOptions): Promise<GatherResult> {
	const dir = join(o.agentDir, "upstream");
	mkdirSync(dir, { recursive: true });
	// Seconds are part of the stamp, and a stamp that is taken gets a suffix: no run overwrites another's files.
	const base = stampOf(o.now ?? new Date());
	let stamp = base;
	for (let n = 2; existsSync(join(dir, `${stamp}-data.md`)) || existsSync(join(dir, `${stamp}.md`)); n++) {
		stamp = `${base}-${n}`;
	}
	let r: Body;
	let mode: "git" | "fallback";
	if (await isUpstreamCheckout(o.sourceDir)) {
		try {
			mode = "git";
			r = await gitMode(o, stamp);
		} catch (err) {
			if (!(err instanceof NoUpstreamBranch)) throw err;
			mode = "fallback";
			r = await fallbackMode(o, stamp, `${err.message}; showing the upstream CHANGELOG only`);
		}
	} else {
		mode = "fallback";
		r = await fallbackMode(o, stamp, `${o.sourceDir} is not a git checkout with an \`upstream\` remote`);
	}
	const dataPath = join(dir, `${stamp}-data.md`);
	writeFileSync(dataPath, r.body);
	return {
		mode,
		partial: mode === "fallback",
		stamp,
		dataPath,
		reportPath: join(dir, `${stamp}.md`),
		summary: r.summary,
		notes: r.notes,
	};
}
