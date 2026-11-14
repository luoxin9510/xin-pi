import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createContext, SgError, withLock } from "../src/index.ts";
import { cleanup, initialised, tempDir } from "./helpers.ts";

afterEach(cleanup);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function context(dir: string, lockTimeoutMs = 200) {
	return createContext({ cwd: dir, env: { XPI_SG_STORE: dir }, lockTimeoutMs });
}

const deadPid = (): number => spawnSync(process.execPath, ["-e", ""]).pid;

describe("lock", () => {
	it("lets one writer in at a time", async () => {
		const dir = tempDir("lock");
		const ctx = context(dir, 5000);
		const lock = join(dir, "demo.lock");
		let inside = 0;
		let most = 0;
		const writer = () =>
			withLock(ctx, lock, async () => {
				inside++;
				most = Math.max(most, inside);
				await sleep(20);
				inside--;
			});
		await Promise.all([writer(), writer(), writer(), writer()]);
		expect(most).toBe(1);
		expect(existsSync(lock)).toBe(false);
	});

	it("is released when the writer throws", async () => {
		const dir = tempDir("lock");
		const lock = join(dir, "demo.lock");
		await expect(
			withLock(context(dir), lock, () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(existsSync(lock)).toBe(false);
	});

	it("is exit 2 while a live process holds it", async () => {
		const dir = tempDir("lock");
		const lock = join(dir, "demo.lock");
		writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }));
		const error = await withLock(context(dir, 100), lock, () => undefined).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(SgError);
		expect((error as SgError).code).toBe(2);
		expect((error as SgError).message).toContain(`pid ${process.pid}`);
		expect(existsSync(lock)).toBe(true);
	});

	it("takes over a lock whose holder is gone", async () => {
		const dir = tempDir("lock");
		const lock = join(dir, "demo.lock");
		writeFileSync(lock, JSON.stringify({ pid: deadPid(), at: Date.now() }));
		let ran = false;
		await withLock(context(dir), lock, () => {
			ran = true;
		});
		expect(ran).toBe(true);
		expect(existsSync(lock)).toBe(false);
		expect(existsSync(`${lock}.takeover`)).toBe(false);
	});

	it("lets only one of several takers take a stale lock over", async () => {
		const dir = tempDir("lock");
		const ctx = context(dir, 5000);
		const lock = join(dir, "demo.lock");
		writeFileSync(lock, JSON.stringify({ pid: deadPid(), at: 0 }));
		let inside = 0;
		let most = 0;
		const taker = () =>
			withLock(ctx, lock, async () => {
				inside++;
				most = Math.max(most, inside);
				await sleep(15);
				inside--;
			});
		await Promise.all([taker(), taker(), taker(), taker(), taker()]);
		expect(most).toBe(1);
	});

	it("waits for a lock file that cannot be read yet, then takes it when it is old", async () => {
		const dir = tempDir("lock");
		const lock = join(dir, "demo.lock");
		writeFileSync(lock, "");
		const waited = await withLock(context(dir, 100), lock, () => undefined).catch((e: unknown) => e);
		expect(waited).toBeInstanceOf(SgError);
		const old = new Date(Date.now() - 60_000);
		utimesSync(lock, old, old);
		await withLock(context(dir), lock, () => undefined);
		expect(existsSync(lock)).toBe(false);
	});

	it("holds back the commands that write the primary workspace", async () => {
		const l = await initialised();
		mkdirSync(l.store, { recursive: true });
		writeFileSync(join(l.store, "demo.lock"), JSON.stringify({ pid: process.pid, at: Date.now() }));
		for (const args of [["import"], ["export", "--apply"]]) {
			const result = await l.sg(args, { lockTimeoutMs: 100 });
			expect(result.code).toBe(2);
			expect(result.err).toContain("is held");
		}
		// a stale lock does not
		writeFileSync(join(l.store, "demo.lock"), JSON.stringify({ pid: deadPid(), at: Date.now() }));
		expect((await l.sg(["import"])).code).toBe(0);
		expect(existsSync(join(l.store, "demo.lock"))).toBe(false);
	});
});
