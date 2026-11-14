// The namespace backend end to end, offline with the fake child: an isolated subagent and a teammate really run under
// it (their cwd is the workspace's own path, which shows the sandbox's tree, and the primary is read-only from inside).
// Skips, with the probe's message, where unprivileged user namespaces do not work (macOS, a restricted runner).
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createContext, probeNamespace } from "xpi-shadow-git";
import { teams } from "../../../src/extensions/subagent/team.ts";
import { agentFile, ev, happyLines, loadTool, sandbox } from "../helpers.ts";
import { cleanupLater, cleanupNow } from "../teams/team-helpers.ts";
import { lab } from "./lab.ts";

const probe = probeNamespace(createContext({ cwd: "/", env: process.env }));
const skip = probe.ok ? false : `namespace backend: skipped, ${probe.message}`;

const savedHome = process.env.HOME;
test.after(async () => {
	await cleanupNow();
	process.env.HOME = savedHome;
});

async function setup(name: string) {
	const l = await lab("demo", { namespace: true });
	const s = sandbox();
	s.write(join(s.home, ".claude/agents/x.md"), agentFile("name: x\ndescription: d"));
	const t = await loadTool(
		{},
		{
			cwd: l.ws,
			sessionFile: join(l.root, `${name}.jsonl`),
			sessionId: `0190ns-${name}-${Math.random().toString(16).slice(2, 8)}`,
			topSettings: { agentTeams: { enabled: true } },
		},
	);
	cleanupLater(() => t.emit("session_shutdown", {}));
	return { l, s, t };
}

const until = async (what: string, pred: () => boolean, ms = 30_000) => {
	const t0 = Date.now();
	while (!pred()) {
		if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 20));
	}
};

test(
	"an isolated subagent runs under the namespace backend: the workspace path is its tree, the primary is read-only",
	{ skip },
	async () => {
		const { l, s, t } = await setup("iso");
		try {
			s.scenario({ lines: happyLines("hi"), writeFile: "out.txt", tryPrimaryWrite: "a.txt" });
			const r = (await t.run({ subagent_type: "x", isolation: "worktree" })).structuredContent;
			const rec = s.record();
			assert.equal(rec.env!.XPI_SG_BACKEND, "namespace");
			assert.equal(rec.cwd, l.ws, "the child's cwd is the workspace's own path");
			assert.equal(rec.env!.GIT_WORK_TREE, l.ws);
			assert.equal(rec.writes!.primary, "EROFS", "the primary is read-only from inside");
			// what it wrote at the workspace path went to its tree, not to the primary
			const tree = join(l.store, "demo.sbx", `sub-${r.agentId}`, "tree");
			assert.equal(readFileSync(join(tree, "out.txt"), "utf8"), "written by the fake child\n");
			assert.equal(existsSync(join(l.ws, "out.txt")), false);
			assert.equal(readFileSync(join(l.ws, "a.txt"), "utf8"), "a\n");
			assert.equal(r.worktree.path, tree);
			assert.ok(rec.systemPromptTail!.includes(`Working directory: ${l.ws}`), "the prompt says so too");
		} finally {
			l.restore();
		}
	},
);

test("a teammate runs under the namespace backend the same way", { skip, timeout: 60_000 }, async () => {
	const { l, s, t } = await setup("team");
	try {
		s.scenario({
			lines: [ev.session(), ev.assistant("final"), ev.turnEnd(), ev.settled()],
			writeFile: "alice.txt",
			tryPrimaryWrite: "a.txt",
		});
		await t.run({ name: "alice", subagent_type: "x" });
		await until("it is idle", () => teams.current()!.members.get("alice")!.status === "idle");
		const rec = s.record();
		assert.equal(rec.env!.XPI_SG_SANDBOX, "demo/team-alice");
		assert.equal(rec.env!.XPI_SG_BACKEND, "namespace");
		assert.equal(rec.cwd, l.ws);
		assert.equal(rec.writes!.primary, "EROFS");
		assert.equal(
			readFileSync(join(l.store, "demo.sbx", "team-alice", "tree", "alice.txt"), "utf8"),
			"written by the fake child\n",
		);
		assert.equal(existsSync(join(l.ws, "alice.txt")), false);
	} finally {
		l.restore();
	}
});
