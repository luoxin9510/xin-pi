// /upstream on a real xpi (rpc mode, Claude Haiku 5.5): a temp repo with a fake local `upstream` remote, a temp agent
// dir and HOME. The slash command goes in as an rpc prompt; the check is a report file with the four section headings.
// Run by hand: npm run build && npm run test:upstream:real (needs credentials; never part of `npm test`).
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { HAIKU, PI, sandbox } from "../../subagent/real/helpers.ts";

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
		cwd,
		encoding: "utf8",
	}).trim();
const put = (root: string, rel: string, text: string) => {
	mkdirSync(dirname(join(root, rel)), { recursive: true });
	writeFileSync(join(root, rel), text);
};

test("real xpi: /upstream writes a report with the four section headings", async () => {
	const s = sandbox();
	const dir = mkdtempSync(join(tmpdir(), "upstream-real-"));
	const up = join(dir, "up");
	const ours = join(dir, "ours");
	mkdirSync(up);
	git(up, "init", "-q", "-b", "main");
	put(up, "packages/coding-agent/src/foo.ts", "export const a = 1;\n");
	put(up, "packages/coding-agent/CHANGELOG.md", "# Changelog\n\n## [1.0.0]\n\n- old\n");
	git(up, "add", "-A");
	git(up, "commit", "-qm", "base");
	git(dir, "clone", "-q", up, "ours");
	git(ours, "remote", "rename", "origin", "upstream");
	git(ours, "mv", "packages/coding-agent", "packages/xpi-coding-agent");
	put(ours, "packages/xpi-coding-agent/src/extensions/subagent/index.ts", "export {};\n");
	git(ours, "add", "-A");
	git(ours, "commit", "-qm", "ours: rename and subagent");
	put(up, "packages/coding-agent/src/foo.ts", "export const a = 2;\n");
	put(up, "packages/coding-agent/src/bg-subagent.ts", "export const bg = 1;\n");
	put(
		up,
		"packages/coding-agent/CHANGELOG.md",
		"# Changelog\n\n## [Unreleased]\n\n### Added\n\n- background subagent runs\n\n## [1.0.0]\n\n- old\n",
	);
	git(up, "add", "-A");
	git(up, "commit", "-qm", "feat: background subagent runs");

	// Settings: the sandbox agent dir plus the fake checkout as the source.
	const settingsPath = join(s.agentDir, "settings.json");
	const base = JSON.parse(readFileSync(settingsPath, "utf8"));
	writeFileSync(settingsPath, JSON.stringify({ ...base, upstream: { sourceDir: ours } }));

	const child = spawn(
		process.execPath,
		[
			PI,
			"--mode",
			"rpc",
			"--model",
			HAIKU,
			"--thinking",
			"low",
			"--approve",
			"--session-dir",
			join(s.root, "sessions"),
		],
		{ cwd: s.repo, stdio: ["pipe", "pipe", "pipe"] },
	);
	let out = "";
	let err = "";
	child.stdout.on("data", (c: Buffer) => {
		out += c.toString("utf8");
	});
	child.stderr.on("data", (c: Buffer) => {
		err += c.toString("utf8");
	});
	child.stdin.write(`${JSON.stringify({ type: "prompt", message: "/upstream" })}\n`);

	const reportDir = join(s.agentDir, "upstream");
	const deadline = Date.now() + 180_000;
	const settled = () => out.split("\n").some((l) => l.startsWith("{") && JSON.parse(l).type === "agent_end");
	while (!settled() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
	child.kill("SIGKILL");
	assert.ok(settled(), `no agent_end; stderr: ${err.slice(-500)}; stdout tail: ${out.slice(-800)}`);

	assert.ok(existsSync(reportDir), "the upstream dir was created in the temp agent dir");
	const files = readdirSync(reportDir);
	const dataFile = files.find((f) => f.endsWith("-data.md"));
	const reportFile = files.find((f) => f.endsWith(".md") && !f.endsWith("-data.md"));
	assert.ok(dataFile, `data file in ${files.join(",")}`);
	assert.ok(reportFile, `report file in ${files.join(",")}`);
	const report = readFileSync(join(reportDir, reportFile), "utf8");
	for (const h of [
		"Upstream changes",
		"Conflicts with our changes",
		"Overlap with xin-pi built-ins",
		"Recommendations",
	]) {
		assert.match(report, new RegExp(`^## ${h}`, "m"), `heading ${h}`);
	}
	console.log(`report: ${join(reportDir, reportFile)}\n${report}`);
});
