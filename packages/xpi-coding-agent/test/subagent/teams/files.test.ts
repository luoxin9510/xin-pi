// Agent teams, the file layer (team-files.ts): locks (exclusive create, retry, stale takeover by rename), atomic writes, the
// mailbox with its validation.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	appendEntry,
	entryProblem,
	type InboxEntry,
	LOCK_STALE_MS,
	newEntryId,
	peekEntries,
	putBack,
	takeEntries,
	withLock,
	writeAtomic,
} from "../../../src/extensions/subagent/team-files.ts";

const dir = () => mkdtempSync(join(tmpdir(), "team-files-"));
const entry = (n: number, extra: Partial<InboxEntry> = {}): InboxEntry => ({
	id: newEntryId(),
	from: "a",
	to: "b",
	text: `m${n}`,
	kind: "message",
	at: n,
	...extra,
});
// A pid that is not alive: a child that has exited.
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid;

test("a lock is created exclusively with the holder's pid; a second taker waits, then throws busy after 2 s", async () => {
	const d = dir();
	const file = join(d, "x.json");
	const t0 = Date.now();
	await assert.rejects(
		withLock(file, async () => {
			const info = JSON.parse(readFileSync(`${file}.lock`, "utf8"));
			assert.equal(info.pid, process.pid);
			assert.equal(statSync(`${file}.lock`).mode & 0o777, 0o600);
			await withLock(file, () => {});
		}),
		/busy: x\.json is locked/,
	);
	const waited = Date.now() - t0;
	assert.ok(waited >= 1900 && waited < 3500, `retried for about 2 s, took ${waited} ms`);
	assert.ok(!existsSync(`${file}.lock`), "the lock is gone after the holder ended");
});

test("a waiting taker gets the lock as soon as the holder releases it (25 ms retry)", async () => {
	const d = dir();
	const file = join(d, "x.json");
	const order: string[] = [];
	const first = withLock(file, async () => {
		order.push("first in");
		await new Promise((r) => setTimeout(r, 150));
		order.push("first out");
	});
	await new Promise((r) => setTimeout(r, 20));
	const second = withLock(file, () => {
		order.push("second in");
	});
	await Promise.all([first, second]);
	assert.deepEqual(order, ["first in", "first out", "second in"]);
});

test("a lock whose holder is gone is taken over", async () => {
	const d = dir();
	const file = join(d, "x.json");
	writeFileSync(`${file}.lock`, JSON.stringify({ pid: deadPid(), at: Date.now() }));
	const t0 = Date.now();
	await withLock(file, () => {});
	assert.ok(Date.now() - t0 < 500, "no waiting for a dead holder");
	assert.deepEqual(readdirSync(d), [], "no lock or stale file is left behind");
});

test("a lock older than 30 s is taken over even when its pid is alive; a fresh one is not", async () => {
	const d = dir();
	const file = join(d, "x.json");
	writeFileSync(`${file}.lock`, JSON.stringify({ pid: process.pid, at: Date.now() - LOCK_STALE_MS - 1000 }));
	await withLock(file, () => {});
	writeFileSync(`${file}.lock`, JSON.stringify({ pid: process.pid, at: Date.now() }));
	await assert.rejects(
		withLock(file, () => {}),
		/busy/,
	);
});

test("several processes take over one stale lock at once: they never hold it together, and each gets its turns", async () => {
	const d = dir();
	const file = join(d, "x.json");
	const log = join(d, "log");
	const counter = join(d, "counter");
	writeFileSync(`${file}.lock`, JSON.stringify({ pid: deadPid(), at: Date.now() }));
	const worker = fileURLToPath(new URL("./lock-worker.ts", import.meta.url));
	const startAt = String(Date.now() + 600);
	const workers = 5;
	const rounds = 6;
	await Promise.all(
		Array.from(
			{ length: workers },
			() =>
				new Promise<void>((resolve, reject) => {
					const child = spawn(
						process.execPath,
						["--experimental-strip-types", worker, file, log, counter, startAt, String(rounds)],
						{ stdio: ["ignore", "ignore", "inherit"] },
					);
					child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`worker exited ${code}`))));
				}),
		),
	);
	const lines = readFileSync(log, "utf8").trim().split("\n");
	assert.equal(lines.length, workers * rounds * 2);
	for (let i = 0; i < lines.length; i += 2) {
		const [enter, pid] = lines[i]!.split(" ");
		assert.equal(enter, "enter");
		assert.equal(lines[i + 1], `exit ${pid}`, `section ${i / 2} was entered by a second holder before it ended`);
	}
	assert.equal(Number(readFileSync(counter, "utf8")), workers * rounds, "no lost update");
});

test("writeAtomic leaves no temporary file and the file is 0600 in a 0700 directory", () => {
	const d = join(dir(), "sub", "deeper");
	const file = join(d, "x.json");
	writeAtomic(file, "[1]");
	writeAtomic(file, "[2]");
	assert.equal(readFileSync(file, "utf8"), "[2]");
	assert.deepEqual(readdirSync(d), ["x.json"]);
	assert.equal(statSync(file).mode & 0o777, 0o600);
	assert.equal(statSync(d).mode & 0o777, 0o700);
});

test("concurrent appenders lose nothing, and a taker removing entries meanwhile loses nothing either", async () => {
	const d = dir();
	const file = join(d, "inboxes", "b.json");
	const total = 40;
	const taken: InboxEntry[] = [];
	const appenders = Array.from({ length: total }, (_, i) => appendEntry(file, entry(i)));
	const taker = (async () => {
		for (let i = 0; i < 6; i++) {
			taken.push(...(await takeEntries(file)).taken);
			await new Promise((r) => setTimeout(r, 3));
		}
	})();
	await Promise.all([...appenders, taker]);
	taken.push(...(await takeEntries(file)).taken);
	assert.equal(taken.length, total);
	assert.equal(new Set(taken.map((e) => e.id)).size, total, "each entry taken once");
});

test("takeEntries removes what select takes and leaves the rest in order; putBack puts entries back first", async () => {
	const d = dir();
	const file = join(d, "b.json");
	for (let i = 0; i < 4; i++) await appendEntry(file, entry(i, { from: i % 2 === 0 ? "a" : "c" }));
	const { taken } = await takeEntries(file, (e) => e.from === "a");
	assert.deepEqual(
		taken.map((e) => e.text),
		["m0", "m2"],
	);
	assert.deepEqual(
		peekEntries(file).map((e) => e.text),
		["m1", "m3"],
	);
	await putBack(file, taken);
	assert.deepEqual(
		peekEntries(file).map((e) => e.text),
		["m0", "m2", "m1", "m3"],
	);
});

test("invalid entries are dropped with a reason and the valid ones are delivered; a file that is not an array is dropped", async () => {
	const d = dir();
	const file = join(d, "b.json");
	const good = entry(1);
	mkdirSync(d, { recursive: true });
	writeFileSync(
		file,
		JSON.stringify([
			good,
			{ ...entry(2), kind: "shout" },
			"just text",
			{ ...entry(3), from: "bad name!" },
			{ ...entry(4), text: 5 },
			{ ...entry(5), at: "now" },
			{ ...entry(6), id: "" },
			{ ...entry(7), approve: "yes" },
		]),
	);
	const { taken, dropped } = await takeEntries(file);
	assert.deepEqual(
		taken.map((e) => e.id),
		[good.id],
	);
	assert.equal(dropped.length, 7);
	assert.match(dropped[0]!, /entry 1: unknown kind "shout"/);
	assert.match(dropped[1]!, /entry 2: not an object/);
	assert.match(dropped[2]!, /entry 3: bad from/);
	assert.deepEqual(peekEntries(file), [], "the bad entries are gone from the file");
	writeFileSync(file, "{ not json");
	assert.deepEqual((await takeEntries(file)).dropped, ["the file is not valid JSON"]);
	writeFileSync(file, '{"a":1}');
	assert.deepEqual((await takeEntries(file)).dropped, ["the file does not hold an array"]);
});

test("entryProblem accepts every kind, the lead, and an optional summary and approve", () => {
	for (const kind of ["message", "idle", "shutdown_request", "shutdown_response", "held"] as const) {
		assert.equal(entryProblem(entry(1, { kind, from: "lead", to: "b", summary: "s", approve: true })), undefined);
	}
});
