import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SgContext } from "./context.ts";
import { precondition } from "./errors.ts";

interface LockInfo {
	pid: number;
	at: number;
}

const RETRY_MS = 25;
// A lock file that cannot be read yet (its holder created it and has not written it) is stale only after this long.
const UNREADABLE_MS = 5000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

interface Seen {
	raw: string;
	info: LockInfo | undefined;
}

function read(file: string): Seen | undefined {
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
	try {
		const parsed = JSON.parse(raw) as Partial<LockInfo>;
		const ok = Number.isInteger(parsed.pid) && Number.isFinite(parsed.at);
		return { raw, info: ok ? (parsed as LockInfo) : undefined };
	} catch {
		return { raw, info: undefined };
	}
}

// A lock is stale when its holder is gone. A long-running holder is never stale: an import can take minutes.
function stale(file: string, seen: Seen): boolean {
	if (seen.info) return !pidAlive(seen.info.pid);
	try {
		return Date.now() - statSync(file).mtimeMs > UNREADABLE_MS;
	} catch {
		return false;
	}
}

function create(file: string): boolean {
	let fd: number;
	try {
		fd = openSync(file, "wx", 0o600);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	}
	try {
		writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() } satisfies LockInfo));
	} finally {
		closeSync(fd);
	}
	return true;
}

// Take over a stale lock. Only the holder of `<lock>.takeover` (an exclusive create too) may remove a lock, and it
// removes it only if it is still the one that was judged stale. A bare removal would let a second taker, which judged
// the same stale lock, remove the fresh lock its rival had just created.
function takeOver(lock: string, seen: Seen): void {
	const guard = `${lock}.takeover`;
	if (!create(guard)) {
		const g = read(guard);
		if (g && stale(guard, g)) rmSync(guard, { force: true });
		return;
	}
	try {
		if (read(lock)?.raw === seen.raw) rmSync(lock, { force: true });
	} finally {
		rmSync(guard, { force: true });
	}
}

/** Run `fn` holding `lock`, a file created exclusively that holds the pid. A stale lock is taken over. */
export async function withLock<T>(ctx: SgContext, lock: string, fn: () => T | Promise<T>): Promise<T> {
	mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
	const deadline = Date.now() + ctx.lockTimeoutMs;
	for (;;) {
		if (create(lock)) break;
		const seen = read(lock);
		if (seen && stale(lock, seen)) {
			takeOver(lock, seen);
		}
		// also after a takeover: a taker that keeps losing the guard must not spin past the deadline
		if (Date.now() >= deadline) {
			const holder = seen?.info ? ` (pid ${seen.info.pid})` : "";
			throw precondition(`${lock} is held${holder}; another shadow-git command is writing the workspace`);
		}
		await sleep(RETRY_MS);
	}
	try {
		return await fn();
	} finally {
		rmSync(lock, { force: true });
	}
}
