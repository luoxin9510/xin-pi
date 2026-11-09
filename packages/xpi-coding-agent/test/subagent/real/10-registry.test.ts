// Ticket v2-04: the subagent registry and `/subagents`, on real pi.
import assert from "node:assert/strict";
import { readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { registry, type SubagentRecord } from "../../../src/extensions/subagent/registry.ts";
import { loadTool, REPLY_OK, sandbox } from "./helpers.ts";

const readMeta = (dir: string, id: string) => JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8"));

test("a record appears when a run starts, updates while it runs, and settles with usage; the meta file follows", async () => {
	const s = sandbox();
	s.write(join(s.repo, "hello.txt"), "hello");
	const t = await loadTool({}, { cwd: s.repo, persist: join(s.root, "sessions") });

	const seen: { rec: SubagentRecord; live: boolean; meta: any }[] = [];
	const unsubscribe = registry.subscribe(() => {
		const rec = registry.list(t.sessionId)[0];
		if (!rec) return;
		seen.push({ rec, live: registry.handle(rec.id) !== undefined, meta: readMeta(t.sessionDir!, rec.id) });
	});
	const r = await t.result({
		subagent_type: "Explore",
		description: "read the file",
		prompt: "Read hello.txt with a tool, then reply with the single word OK.",
	});
	unsubscribe();
	assert.equal(r.status, "completed", r.error ?? "");

	const first = seen[0]!;
	assert.equal(first.rec.status, "running");
	assert.equal(first.rec.id, r.agentId);
	assert.equal(first.rec.parentSessionId, t.sessionId);
	assert.equal(first.rec.type, "Explore");
	assert.equal(first.rec.description, "read the file");
	assert.equal(first.rec.model, r.model);
	assert.equal(first.rec.thinking, "off");
	assert.equal(first.meta.status, "running", "the meta file is written at start");
	assert.equal(first.meta.agentType, "Explore");
	assert.ok(
		seen.some((x) => x.live && x.rec.status === "running"),
		"a running child has a handle",
	);
	assert.ok(
		seen.some((x) => x.rec.status === "running" && x.rec.lastTool !== undefined),
		"the last tool shows while running",
	);
	const turns = seen.map((x) => x.rec.turns);
	assert.deepEqual(
		turns,
		[...turns].sort((a, b) => a - b),
		"turns only grow",
	);

	const done = registry.get(r.agentId)!;
	assert.equal(done.status, "completed");
	assert.equal(done.turns, r.turns);
	assert.ok(done.turns >= 2);
	assert.deepEqual(done.usage, r.usage);
	assert.ok(done.endedAt! >= done.startedAt);
	assert.equal(registry.handle(r.agentId), undefined, "no handle once it ended");
	assert.deepEqual(readMeta(t.sessionDir!, r.agentId), {
		agentType: "Explore",
		description: "read the file",
		status: "completed",
		turns: r.turns,
		lastTool: done.lastTool,
		usage: r.usage,
		startedAt: done.startedAt,
		endedAt: done.endedAt,
		model: r.model,
		thinking: "off",
	});
});

test("after a fresh load the registry is rebuilt from meta files: finished runs, v1 files, resume; /subagents lists newest first", async () => {
	const s = sandbox();
	const persist = join(s.root, "sessions");
	const t = await loadTool({}, { cwd: s.repo, persist });
	const a = await t.result({ subagent_type: "Explore", description: "first job", prompt: REPLY_OK });
	const b = await t.result({ subagent_type: "Plan", description: "second job", prompt: REPLY_OK });
	assert.equal(a.status, "completed", a.error ?? "");
	assert.equal(b.status, "completed", b.error ?? "");
	// A v1 file: only the agent type, older than both.
	const v1 = join(t.sessionDir!, "v1agent0000.json");
	writeFileSync(v1, JSON.stringify({ agentType: "general-purpose" }));
	utimesSync(v1, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
	const before = [a.agentId, b.agentId].map((id) => registry.get(id)!);

	registry.clear(); // /reload: a new process-wide registry
	const t2 = await loadTool({}, { cwd: s.repo, persist, sessionId: t.sessionId, pick: (options) => options[1] });
	const rows = registry.list(t.sessionId);
	assert.deepEqual(
		rows.map((r) => r.id),
		[b.agentId, a.agentId, "v1agent0000"],
		"newest first",
	);
	assert.deepEqual(rows.slice(0, 2), before.reverse(), "records equal what the live runs had");
	assert.deepEqual([rows[2]!.type, rows[2]!.description, rows[2]!.status], ["general-purpose", "", "completed"]);

	await t2.command("subagents");
	assert.equal(t2.menus.length, 1);
	const { options } = t2.menus[0]!;
	assert.equal(options.length, 3);
	assert.match(options[0]!, /^completed +Plan\(second job\) · (\S+ · \S+ · )?\d+ turns · /);
	assert.ok(options[0]!.endsWith(b.agentId));
	assert.match(options[1]!, /Explore\(first job\)/);
	assert.match(options[2]!, /general-purpose · 0 turns · v1agent0000$/);
	assert.equal(t2.screens.length, 1, "choosing a row opens its subagent screen");
	assert.match(t2.screens[0]!, /Explore\(first job\)/);

	// Resume through the rebuilt registry: same record, totals add up, still second in line.
	const again = await t2.result({ resume: a.agentId, prompt: REPLY_OK });
	assert.equal(again.status, "completed", again.error ?? "");
	const resumed = registry.get(a.agentId)!;
	assert.equal(resumed.turns, before[1]!.turns + again.turns);
	assert.ok(Math.abs(resumed.usage.cost.total - (before[1]!.usage.cost.total + again.usage.cost.total)) < 1e-12);
	assert.equal(resumed.startedAt, before[1]!.startedAt);
	assert.deepEqual(
		registry.list(t.sessionId).map((r) => r.id),
		[b.agentId, a.agentId, "v1agent0000"],
	);
	assert.equal(readMeta(t.sessionDir!, a.agentId).turns, resumed.turns);
});

test("a meta file left 'running' by a dead process loads as stopped", async () => {
	const s = sandbox();
	const persist = join(s.root, "sessions");
	const t = await loadTool({}, { cwd: s.repo, persist });
	registry.clear();
	s.write(
		join(t.sessionDir!, "dead00000000.json"),
		JSON.stringify({ agentType: "Plan", description: "d", status: "running", startedAt: 1 }),
	);
	await loadTool({}, { cwd: s.repo, persist, sessionId: t.sessionId });
	assert.equal(registry.get("dead00000000")!.status, "stopped");
	assert.ok(
		registry.get("dead00000000")!.endedAt !== undefined,
		"a dead run has an end time, so it never counts as running",
	);
});

test("a corrupt meta file does not break session start: it is skipped with a warning, the other subagents load", async () => {
	const s = sandbox();
	const persist = join(s.root, "sessions");
	const t = await loadTool({}, { cwd: s.repo, persist });
	registry.clear();
	s.write(join(t.sessionDir!, "broken000000.json"), "{oops");
	s.write(join(t.sessionDir!, "fine00000000.json"), JSON.stringify({ agentType: "Plan", status: "completed" }));
	const t2 = await loadTool({}, { cwd: s.repo, persist, sessionId: t.sessionId });
	assert.ok(
		t2.notes.some((n) => n.includes("broken000000.json") && n.startsWith("subagent:")),
		t2.notes.join("\n"),
	);
	assert.equal(registry.get("fine00000000")!.type, "Plan");
	assert.equal(registry.get("broken000000"), undefined);
});

test("in-memory parent: /subagents shows the notice and no picker; no subagents yet: says so", async () => {
	const s = sandbox();
	const mem = await loadTool({}, { cwd: s.repo });
	await mem.command("subagents");
	assert.equal(mem.menus.length, 0);
	assert.match(mem.notes.at(-1)!, /in-memory session cannot be viewed/);

	const persisted = await loadTool({}, { cwd: s.repo, persist: join(s.root, "sessions") });
	await persisted.command("subagents");
	assert.equal(persisted.menus.length, 0);
	assert.match(persisted.notes.at(-1)!, /no subagents yet/);
});
