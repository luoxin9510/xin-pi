// /upstream on temp git repos with a fake `upstream` remote (a local directory) and a stubbed fetch: no network, no
// ~/.pi/agent. Never starts a test runner from inside a test.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
	defaultUpstreamBranch,
	gather,
	newerChangelogSections,
	numstatNewPath,
} from "../../src/extensions/upstream/data.ts";
import { createUpstreamExtension, readSourceDir } from "../../src/extensions/upstream/index.ts";
import { describeUpstreamPath, mapUpstreamPath } from "../../src/extensions/upstream/paths.ts";
import { buildPrompt, REPORT_SECTIONS } from "../../src/extensions/upstream/prompt.ts";

const tmp = mkdtempSync(join(tmpdir(), "xpi-upstream-test-"));
process.env.XPI_CODING_AGENT_DIR = join(tmp, "never-used-agent-dir");

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
		cwd,
		encoding: "utf8",
	}).trim();
const put = (root: string, rel: string, text: string) => {
	mkdirSync(dirname(join(root, rel)), { recursive: true });
	writeFileSync(join(root, rel), text);
};

/** Upstream repo U, our checkout C cloned from it (remote renamed `upstream`), then both sides diverge. */
function fixture(_unused = 0, branch = "main") {
	const dir = mkdtempSync(join(tmp, "fx-"));
	const up = join(dir, "up");
	const ours = join(dir, "ours");
	mkdirSync(up);
	git(up, "init", "-q", "-b", branch);
	put(up, "packages/coding-agent/src/foo.ts", "a\n");
	put(up, "packages/chord/x.ts", "a\n");
	put(up, "packages/coding-agent/CHANGELOG.md", "# Changelog\n\n## [1.0.0]\n\n- old\n");
	git(up, "add", "-A");
	git(up, "commit", "-qm", "base");
	git(dir, "clone", "-q", up, "ours");
	git(ours, "remote", "rename", "origin", "upstream");
	git(ours, "branch", "-m", "main"); // our product branch is always main
	// Our side: rename the package, change foo.ts, add the subagent extension.
	git(ours, "mv", "packages/coding-agent", "packages/xpi-coding-agent");
	put(ours, "packages/xpi-coding-agent/src/foo.ts", "a\nours\n");
	put(ours, "packages/xpi-coding-agent/src/extensions/subagent/index.ts", "x\n".repeat(10));
	git(ours, "add", "-A");
	git(ours, "commit", "-qm", "ours: rename and subagent");
	// Upstream side.
	put(up, "packages/coding-agent/src/foo.ts", "a\nup\n");
	git(up, "commit", "-qam", "fix: foo edge case");
	put(up, "packages/chord/x.ts", "b\n");
	put(
		up,
		"packages/coding-agent/CHANGELOG.md",
		"# Changelog\n\n## [Unreleased]\n\n### Added\n\n- shiny upstream thing\n\n## [1.0.0]\n\n- old\n",
	);
	git(up, "commit", "-qam", "feat: chord thing");
	for (let i = 0; i < 12; i++) put(up, `packages/ai/src/many${i}.ts`, "m\n");
	put(up, "packages/coding-agent/src/subagent-bg.ts", "bg\n");
	git(up, "add", "-A");
	git(up, "commit", "-qm", "feat: background subagent runs");
	return { dir, up, ours, agentDir: join(dir, "agent") };
}

test("git mode: the data file holds the fork point, mapped paths, both-side files, our stat, overlap and changelog", async () => {
	const f = fixture();
	const r = await gather({
		sourceDir: f.ours,
		agentDir: f.agentDir,
		version: "1.0.0",
		now: new Date(2026, 10, 9, 14, 5, 7),
	});
	assert.equal(r.mode, "git");
	assert.equal(r.partial, false);
	assert.equal(r.stamp, "2026-11-09-140507");
	assert.equal(r.dataPath, join(f.agentDir, "upstream", "2026-11-09-140507-data.md"));
	assert.equal(r.reportPath, join(f.agentDir, "upstream", "2026-11-09-140507.md"));
	const d = readFileSync(r.dataPath, "utf8");
	const base = git(f.ours, "merge-base", "main", "upstream/main");
	assert.ok(d.includes(`fork point (merge-base): ${base.slice(0, 9)}`));
	assert.ok(d.includes("upstream commits since the fork point: 3"));
	assert.ok(d.includes("fix: foo edge case"));
	assert.ok(d.includes("packages/coding-agent/src/foo.ts -> packages/xpi-coding-agent/src/foo.ts"));
	assert.ok(d.includes("packages/chord/x.ts (removed in xin-pi)"));
	// Both sides changed foo.ts (our name).
	const both = d.split("## Files changed on both sides")[1].split("## Overlap")[0];
	assert.ok(both.includes("packages/xpi-coding-agent/src/foo.ts: 1 upstream commit"));
	// Our diff stat is in xpi-* names, with the subagent extension counted.
	const ourStat = d.split("## Our changes since the fork point")[1].split("## Files changed on both sides")[0];
	assert.match(ourStat, /- packages\/xpi-coding-agent: \d+ files, \+\d+ -\d+/);
	assert.ok(!ourStat.includes("packages/coding-agent"), ourStat);
	// Per-commit file lists are capped.
	assert.match(d, /\.\.\. \+\d+ more/);
	// Overlap candidate and changelog entry.
	assert.ok(d.split("## Overlap candidates")[1].includes("feat: background subagent runs"));
	assert.ok(d.split("## New upstream coding-agent CHANGELOG entries")[1].includes("shiny upstream thing"));
});

test("git mode: fetch failure is a note, not an error", async () => {
	const f = fixture();
	git(f.ours, "remote", "set-url", "upstream", join(f.dir, "gone"));
	const r = await gather({ sourceDir: f.ours, agentDir: f.agentDir, version: "1.0.0" });
	assert.equal(r.mode, "git");
	assert.ok(r.notes.some((n) => n.includes("git fetch upstream failed")));
});

test("U3: the upstream branch is the remote's default branch (here `trunk`), not a hard-coded main", async () => {
	const f = fixture(2, "trunk");
	const r = await gather({ sourceDir: f.ours, agentDir: f.agentDir, version: "1.0.0" });
	assert.equal(r.mode, "git");
	const d = readFileSync(r.dataPath, "utf8");
	assert.ok(d.includes("upstream ref: upstream/trunk"), d.split("\n").slice(0, 8).join("\n"));
	assert.ok(d.includes("upstream commits since the fork point: 3"));
});

test("U3: with no refs/remotes/upstream/HEAD the default branch is asked from the remote", async () => {
	const f = fixture(2, "trunk");
	git(f.ours, "remote", "set-head", "upstream", "-d");
	assert.equal(await defaultUpstreamBranch(f.ours), "trunk");
	// a remote that cannot be asked ends at main
	git(f.ours, "remote", "set-url", "upstream", join(f.dir, "gone"));
	assert.equal(await defaultUpstreamBranch(f.ours), "main");
});

test("U3: a missing upstream branch falls back to the CHANGELOG with a notice instead of throwing", async () => {
	const f = fixture();
	const r = await gather({
		sourceDir: f.ours,
		agentDir: f.agentDir,
		version: "1.0.0",
		upstreamBranch: "nope",
		fetch: async () => ({ ok: true, status: 200, text: async () => "# Changelog\n\n## [1.1.0]\n\n- new thing\n" }),
	});
	assert.equal(r.mode, "fallback");
	assert.equal(r.partial, true);
	assert.ok(
		r.notes.some((n) => n.includes("upstream/nope does not exist")),
		r.notes.join("|"),
	);
	assert.ok(readFileSync(r.dataPath, "utf8").includes("new thing"));
});

test("U3: git runs with GIT_TERMINAL_PROMPT=0", async () => {
	const f = fixture();
	const bin = mkdtempSync(join(tmp, "bin-"));
	const log = join(bin, "env.log");
	const real = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
	writeFileSync(join(bin, "git"), `#!/bin/sh\necho "$GIT_TERMINAL_PROMPT" >> '${log}'\nexec '${real}' "$@"\n`, {
		mode: 0o755,
	});
	const oldPath = process.env.PATH;
	process.env.PATH = `${bin}:${oldPath}`;
	try {
		await gather({ sourceDir: f.ours, agentDir: f.agentDir, version: "1.0.0" });
	} finally {
		process.env.PATH = oldPath;
	}
	const seen = readFileSync(log, "utf8").trim().split("\n");
	assert.ok(seen.length > 3);
	assert.ok(
		seen.every((v) => v === "0"),
		seen.join(","),
	);
});

test("U3: the CHANGELOG fallback gives up after the timeout with a clear error", async () => {
	const dir = mkdtempSync(join(tmp, "to-"));
	await assert.rejects(
		gather({
			sourceDir: join(dir, "nothing-here"),
			agentDir: join(dir, "agent"),
			version: "1.0.0",
			fetchTimeoutMs: 50,
			fetch: (_url, init) =>
				new Promise((_resolve, reject) =>
					init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
				),
		}),
		/could not fetch upstream CHANGELOG \(no answer within 0\.05s\)/,
	);
});

test("U3: two runs in the same minute (even the same second) never overwrite each other's files", async () => {
	const f = fixture();
	const now = new Date(2026, 10, 9, 14, 5, 7);
	const a = await gather({ sourceDir: f.ours, agentDir: f.agentDir, version: "1.0.0", now });
	const b = await gather({ sourceDir: f.ours, agentDir: f.agentDir, version: "1.0.0", now });
	const c = await gather({
		sourceDir: f.ours,
		agentDir: f.agentDir,
		version: "1.0.0",
		now: new Date(2026, 10, 9, 14, 5, 8),
	});
	assert.equal(new Set([a.dataPath, b.dataPath, c.dataPath]).size, 3);
	assert.match(a.stamp, /^2026-11-09-140507$/);
	assert.equal(b.stamp, "2026-11-09-140507-2");
	assert.equal(c.stamp, "2026-11-09-140508");
});

test("fallback mode: no checkout -> CHANGELOG through the stubbed fetch, newer sections only, marked partial", async () => {
	const dir = mkdtempSync(join(tmp, "fb-"));
	let url = "";
	const changelog =
		"# Changelog\n\n## [Unreleased]\n\n- pending\n\n## [1.6.0]\n\n- six\n\n## [1.5.0]\n\n- five\n\n## [1.4.9]\n\n- older\n";
	const r = await gather({
		sourceDir: join(dir, "nothing-here"),
		agentDir: join(dir, "agent"),
		version: "1.5.0",
		fetch: async (u) => {
			url = u;
			return { ok: true, status: 200, text: async () => changelog };
		},
	});
	assert.equal(r.mode, "fallback");
	assert.equal(r.partial, true);
	assert.ok(url.endsWith("/packages/coding-agent/CHANGELOG.md"));
	const d = readFileSync(r.dataPath, "utf8");
	assert.ok(d.includes("fallback mode, partial"));
	assert.ok(d.includes("- six") && d.includes("- pending"));
	assert.ok(!d.includes("- five") && !d.includes("- older"));
	await assert.rejects(
		gather({
			sourceDir: join(dir, "nothing-here"),
			agentDir: join(dir, "agent"),
			version: "1.5.0",
			fetch: async () => ({ ok: false, status: 404, text: async () => "" }),
		}),
		/HTTP 404/,
	);
});

test("a directory without an `upstream` remote also falls back", async () => {
	const dir = mkdtempSync(join(tmp, "nr-"));
	git(dir, "init", "-q", "-b", "main");
	const r = await gather({
		sourceDir: dir,
		agentDir: join(dir, "agent"),
		version: "9.9.9",
		fetch: async () => ({ ok: true, status: 200, text: async () => "## [1.0.0]\n\n- x\n" }),
	});
	assert.equal(r.mode, "fallback");
});

test("path mapping and helpers", () => {
	assert.deepEqual(mapUpstreamPath("packages/agent/src/a.ts"), { path: "packages/xpi-agent-core/src/a.ts" });
	assert.deepEqual(mapUpstreamPath("packages/durable/a.ts"), { removed: true });
	assert.deepEqual(mapUpstreamPath("apps/p2/a.ts"), { removed: true });
	assert.deepEqual(mapUpstreamPath("README.md"), { path: "README.md" });
	assert.equal(describeUpstreamPath("packages/tui/a.ts"), "packages/tui/a.ts -> packages/xpi-tui/a.ts");
	assert.equal(numstatNewPath("packages/{ai => xpi-ai}/src/a.ts"), "packages/xpi-ai/src/a.ts");
	assert.equal(numstatNewPath("a.md => b.md"), "b.md");
	assert.equal(numstatNewPath("{old => }/x.ts"), "x.ts");
	const s = newerChangelogSections("## [2.0.0]\n- a\n## [1.0.0]\n- b\n", "1.0.0");
	assert.deepEqual(
		s.map((x) => x.heading),
		["2.0.0"],
	);
	assert.match(readSourceDir(undefined), /Developer\/xin-pi$/);
	assert.equal(readSourceDir({ sourceDir: "/x" }), "/x");
	assert.throws(() => readSourceDir({ sourceDir: 3 }), /upstream\.sourceDir/);
	assert.throws(() => readSourceDir([]), /upstream settings/);
});

test("prompt: points at the files, names the four sections, is read-only and small", () => {
	const p = buildPrompt({
		mode: "fallback",
		partial: true,
		stamp: "s",
		dataPath: "/d/s-data.md",
		reportPath: "/d/s.md",
		summary: "",
		notes: [],
	});
	assert.ok(p.includes("/d/s-data.md") && p.includes("/d/s.md"));
	for (const h of REPORT_SECTIONS) assert.ok(p.includes(`## ${h}`));
	assert.ok(p.includes("Read-only") && p.includes("do not merge"));
	assert.ok(p.includes("PARTIAL"));
	assert.ok(p.includes("xpi-rename.mjs"));
	assert.ok(p.length < 3000);
});

type Handler = (args: string, ctx: unknown) => Promise<void>;
function fakePi(settings: unknown) {
	const sent: { text: string; opts: unknown }[] = [];
	const commands: Record<string, Handler> = {};
	const pi = {
		registerCommand: (name: string, o: { handler: Handler }) => {
			commands[name] = o.handler;
		},
		getSettings: () => settings,
		sendUserMessage: (text: string, opts: unknown) => sent.push({ text, opts }),
	};
	const notes: { m: string; level: string }[] = [];
	const ctx = { hasUI: true, ui: { notify: (m: string, level: string) => notes.push({ m, level }) } };
	return { pi, sent, commands, notes, ctx };
}

test("command: gathers, notifies the mode, injects the prompt as a steer-capable user message", async () => {
	const f = fixture();
	const t = fakePi({ upstream: { sourceDir: f.ours } });
	createUpstreamExtension({ agentDir: f.agentDir, version: "1.0.0" })(t.pi as never);
	await t.commands.upstream("", t.ctx);
	assert.equal(t.sent.length, 1);
	assert.deepEqual(t.sent[0].opts, { deliverAs: "steer" });
	assert.ok(t.sent[0].text.includes(f.agentDir));
	assert.ok(t.notes[0].m.includes("git mode"));
	const data = /Data \(git mode\): (\S+)/.exec(t.sent[0].text)![1];
	assert.ok(existsSync(data));
});

test("command: a bad setting or a failed fetch notifies an error and injects nothing", async () => {
	const t = fakePi({ upstream: { sourceDir: 5 } });
	createUpstreamExtension({ agentDir: join(tmp, "a") })(t.pi as never);
	await t.commands.upstream("", t.ctx);
	assert.equal(t.sent.length, 0);
	assert.equal(t.notes[0].level, "error");
	const t2 = fakePi({ upstream: { sourceDir: join(tmp, "missing") } });
	createUpstreamExtension({
		agentDir: join(tmp, "a"),
		fetch: async () => ({ ok: false, status: 500, text: async () => "" }),
	})(t2.pi as never);
	await t2.commands.upstream("", t2.ctx);
	assert.equal(t2.sent.length, 0);
	assert.match(t2.notes[0].m, /HTTP 500/);
});

test("command: subagent children do not get it", () => {
	process.env.XPI_SUBAGENT_DEPTH = "1";
	try {
		const t = fakePi({});
		createUpstreamExtension()(t.pi as never);
		assert.deepEqual(Object.keys(t.commands), []);
	} finally {
		delete process.env.XPI_SUBAGENT_DEPTH;
	}
});
