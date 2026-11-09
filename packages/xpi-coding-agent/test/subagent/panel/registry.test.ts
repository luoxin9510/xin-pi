// The registry's queue and meta-file rules, no pi and no model.
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { registry } from "../../../src/extensions/subagent/registry.ts";

test("turn() leaves no abort listener on the caller's signal, after a normal run or an abort while waiting", async () => {
	const ctl = new AbortController();
	await registry.turn("q1", ctl.signal, async () => 1);
	assert.equal(getEventListeners(ctl.signal, "abort").length, 0);

	let release!: () => void;
	const first = registry.turn("q2", undefined, () => new Promise<void>((r) => (release = r)));
	const second = new AbortController();
	const waiting = registry.turn("q2", second.signal, async () => 2);
	assert.equal(getEventListeners(second.signal, "abort").length, 1, "waiting turns listen");
	second.abort();
	await assert.rejects(waiting, /aborted/);
	assert.equal(getEventListeners(second.signal, "abort").length, 0);
	release();
	await first;
});

test("busy() is false the moment the last turn has ended", async () => {
	await registry.turn("q3", undefined, async () => {
		assert.equal(registry.busy("q3"), true);
	});
	assert.equal(registry.busy("q3"), false);
});

test("a corrupt or incomplete meta file is skipped with a warning, the good files still load", () => {
	const dir = mkdtempSync(join(tmpdir(), "subagent-reg-"));
	const sub = join(dir, "subagents", "r1");
	mkdirSync(sub, { recursive: true });
	writeFileSync(join(sub, "bad000000001.json"), "{not json");
	writeFileSync(join(sub, "bad000000002.json"), JSON.stringify({ description: "no type" }));
	writeFileSync(join(sub, "good00000001.json"), JSON.stringify({ agentType: "Plan", status: "completed" }));
	const warnings = registry.rebuild({
		thinking: "off",
		cwd: "/tmp",
		trusted: true,
		sessionId: "r1",
		sessionFile: join(dir, "s.jsonl"),
	});
	assert.equal(warnings.length, 2);
	assert.ok(
		warnings.some((w) => w.includes("bad000000001.json")),
		warnings.join("\n"),
	);
	assert.ok(
		warnings.some((w) => w.includes("bad000000002.json") && w.includes("agentType")),
		warnings.join("\n"),
	);
	assert.equal(registry.get("good00000001")!.type, "Plan");
	assert.equal(registry.get("bad000000001"), undefined);
});
