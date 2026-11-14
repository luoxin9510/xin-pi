// Agent teams in a shadow-git workspace (decision 19): each teammate gets the sandbox `team-<name>`, kept when it holds
// work; a teammate inside a sandbox is refused. Fake pi as the teammate; real stores and sandboxes in tmpdir; no model.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { teams } from "../../../src/extensions/subagent/team.ts";
import { agentFile, ev, loadTool, sandbox } from "../helpers.ts";
import { cleanupLater, cleanupNow } from "../teams/team-helpers.ts";
import { lab } from "./lab.ts";

const ok = (text = "done") => [ev.session(), ev.assistant(text), ev.turnEnd(), ev.settled()];
const until = async (what: string, pred: () => boolean, ms = 30_000) => {
	const t0 = Date.now();
	while (!pred()) {
		if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 20));
	}
};

const savedHome = process.env.HOME;
test.after(async () => {
	await cleanupNow();
	process.env.HOME = savedHome;
});

let n = 0;
async function setup() {
	const l = await lab();
	const s = sandbox();
	s.write(join(s.home, ".claude/agents/x.md"), agentFile("name: x\ndescription: d"));
	const sessionId = `0190sgteam-${++n}-${Math.random().toString(16).slice(2, 8)}`;
	const t = await loadTool(
		{},
		{
			cwd: l.ws,
			sessionFile: join(l.root, "parent.jsonl"),
			sessionId,
			topSettings: { agentTeams: { enabled: true } },
		},
	);
	const end = () => t.emit("session_shutdown", {});
	cleanupLater(end);
	const tree = (name: string) => join(l.store, "demo.sbx", `team-${name}`, "tree");
	const recorded = async () => {
		await until("the child's record", () => {
			try {
				return s.record().commands.some((c) => c.type === "prompt");
			} catch {
				return false;
			}
		});
		return s.record();
	};
	return { l, s, t, sessionId, end, tree, recorded };
}

test("a teammate runs in the sandbox team-<name>; unchanged, it is removed once its exchange ends", async () => {
	const x = await setup();
	try {
		x.s.scenario({ lines: ok("final") });
		const r = (await x.t.run({ name: "alice", subagent_type: "x" })).structuredContent;
		assert.equal(r.status, "started");
		const rec = await x.recorded();
		assert.equal(rec.cwd, x.tree("alice"));
		assert.equal(rec.env!.XPI_SG_SANDBOX, "demo/team-alice");
		assert.equal(rec.env!.GIT_WORK_TREE, x.tree("alice"));
		assert.equal(rec.team!.XPI_TEAM_MEMBER, "alice", "still a teammate");
		await until("it is idle", () => teams.current()!.members.get("alice")!.status === "idle");
		await until("the sandbox is settled", () => !existsSync(x.tree("alice")));
		assert.equal(x.l.git("for-each-ref", "refs/heads/sbx/").trim(), "", "no branch left");
		const meta = JSON.parse(readFileSync(join(x.l.root, "subagents", x.sessionId, `${r.agentId}.json`), "utf8"));
		assert.equal(meta.worktree.kind, "shadow-git");
		assert.equal(meta.worktree.sandbox, "team-alice");
	} finally {
		await x.end();
		x.l.restore();
	}
});

test("a teammate that changed something keeps its sandbox after it stops, for the user to merge", async () => {
	const x = await setup();
	try {
		x.s.scenario({ lines: ok("final"), writeFile: "alice.txt" });
		await x.t.run({ name: "alice", subagent_type: "x" });
		await until("it is idle", () => teams.current()!.members.get("alice")!.status === "idle");
		assert.equal(readFileSync(join(x.tree("alice"), "alice.txt"), "utf8"), "written by the fake child\n");
		assert.equal(existsSync(join(x.l.ws, "alice.txt")), false, "the primary is untouched");
		assert.equal(x.l.git("for-each-ref", "--format=%(refname:short)", "refs/heads/sbx/").trim(), "sbx/team-alice");
		// a new session's teammate with the same name does not silently continue in it
		await x.end();
		const again = await loadTool(
			{},
			{
				cwd: x.l.ws,
				sessionFile: join(x.l.root, "parent2.jsonl"),
				sessionId: `0190sgteam-b-${Math.random().toString(16).slice(2, 8)}`,
				topSettings: { agentTeams: { enabled: true } },
			},
		);
		cleanupLater(() => again.emit("session_shutdown", {}));
		await assert.rejects(again.run({ name: "alice", subagent_type: "x" }), /sandbox team-alice exists already/);
		await again.emit("session_shutdown", {});
	} finally {
		await x.end();
		x.l.restore();
	}
});

test("a teammate inside a sandbox is refused: sandboxes do not nest, and no child starts", async () => {
	const x = await setup();
	try {
		await x.l.sg(["sbx", "create", "w1"]);
		process.env.XPI_SG_SANDBOX = "demo/w1";
		x.s.scenario({ lines: ok() });
		// a session in a sandbox has the sandbox's tree as its cwd, which is not a registered workspace
		const inside = await loadTool(
			{},
			{
				cwd: join(x.l.store, "demo.sbx", "w1", "tree"),
				sessionFile: join(x.l.root, "inside.jsonl"),
				sessionId: `0190sgteam-c-${Math.random().toString(16).slice(2, 8)}`,
				topSettings: { agentTeams: { enabled: true } },
			},
		);
		cleanupLater(() => inside.emit("session_shutdown", {}));
		await assert.rejects(inside.run({ name: "bob", subagent_type: "x" }), /sandboxes do not nest/);
		assert.equal(existsSync(join(x.s.root, "record.json")), false, "no child was started");
		assert.equal(existsSync(x.tree("bob")), false);
		await inside.emit("session_shutdown", {});
	} finally {
		await x.end();
		x.l.restore();
	}
});
