// Agent teams (spec .scratch/agent-teams/01-agent-teams.md, "Files"): the file layer. Lock files made with an exclusive
// create, writes that go to a temporary file and are renamed, and the mailbox (one JSON array of entries per member)
// with its validation. Every process that touches a team file uses these; nothing else writes them.

import { randomBytes } from "node:crypto";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { AGENT_NAME } from "./registry.ts";
import { LEAD } from "./team-text.ts";

export const FILE_MODE = 0o600;
export const DIR_MODE = 0o700;

export const LOCK_RETRY_MS = 25;
export const LOCK_TIMEOUT_MS = 2000;
export const LOCK_STALE_MS = 30_000;
const GUARD_UNREADABLE_MS = 1000;

export const ensureDir = (dir: string): void => {
	mkdirSync(dir, { recursive: true, mode: DIR_MODE });
};

// The new content goes to a temporary file next to `path` and is renamed over it, so a reader sees the old file or the new
// one, never a half-written one.
export function writeAtomic(path: string, text: string): void {
	ensureDir(dirname(path));
	const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
	try {
		writeFileSync(tmp, text, { mode: FILE_MODE });
		renameSync(tmp, path);
	} catch (err) {
		rmSync(tmp, { force: true });
		throw err;
	}
}

export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM"; // alive, but not ours to signal
	}
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface LockInfo {
	pid: number;
	at: number;
}

function readLock(lock: string): { raw: string; info: LockInfo | undefined } | undefined {
	let raw: string;
	try {
		raw = readFileSync(lock, "utf8");
	} catch {
		return undefined; // gone
	}
	try {
		const info = JSON.parse(raw) as LockInfo;
		return { raw, info: Number.isInteger(info.pid) && Number.isFinite(info.at) ? info : undefined };
	} catch {
		return { raw, info: undefined };
	}
}

// A lock is stale when its holder is gone, or it is older than LOCK_STALE_MS. A lock file that cannot be read yet (its
// holder created it and has not written it) is not stale until it has been there that long.
function stale(
	lock: string,
	seen: { raw: string; info: LockInfo | undefined },
	now: number,
	unreadableMs = LOCK_STALE_MS,
): boolean {
	if (seen.info) return !pidAlive(seen.info.pid) || now - seen.info.at > LOCK_STALE_MS;
	try {
		return now - statSync(lock).mtimeMs > unreadableMs;
	} catch {
		return false;
	}
}

// Take over a stale lock. Only the holder of `<lock>.takeover` (an exclusive create too) may remove a lock, and it removes
// it only if it is still the one that was judged stale. A bare rename of the lock would not do: a second taker that judged
// the same stale lock could rename the fresh lock its rival had just created, and for a moment nobody would hold it.
function takeOver(lock: string, seen: { raw: string }): void {
	const guard = `${lock}.takeover`;
	let fd: number;
	try {
		fd = openSync(guard, "wx", FILE_MODE);
	} catch {
		// another taker is at it; a guard whose taker died is stale itself
		const g = readLock(guard);
		// (a guard is held for a moment: an empty or unreadable one older than a second is a taker that died)
		if (g && stale(guard, g, Date.now(), GUARD_UNREADABLE_MS)) rmSync(guard, { force: true });
		return;
	}
	try {
		writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() } satisfies LockInfo));
		if (readLock(lock)?.raw === seen.raw) rmSync(lock, { force: true });
	} finally {
		closeSync(fd);
		rmSync(guard, { force: true });
	}
}

// Run `fn` holding `<file>.lock`: created exclusively, holding `{ pid, at }`. A held lock is retried every LOCK_RETRY_MS for
// up to LOCK_TIMEOUT_MS, then the call throws `busy`.
export async function withLock<T>(file: string, fn: () => T | Promise<T>): Promise<T> {
	const lock = `${file}.lock`;
	ensureDir(dirname(file));
	const deadline = Date.now() + LOCK_TIMEOUT_MS;
	for (;;) {
		try {
			const fd = openSync(lock, "wx", FILE_MODE);
			try {
				writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() } satisfies LockInfo));
			} finally {
				closeSync(fd);
			}
			break;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		}
		const seen = readLock(lock);
		if (seen && stale(lock, seen, Date.now())) {
			takeOver(lock, seen);
			if (!existsSync(lock)) continue; // create our own lock straight away
			// another taker holds the guard: wait like any other contender (the deadline and the sleep below)
		}
		if (Date.now() >= deadline) throw new Error(`busy: ${basename(file)} is locked by another agent`);
		await sleep(LOCK_RETRY_MS);
	}
	try {
		return await fn();
	} finally {
		rmSync(lock, { force: true });
	}
}

// --- mailboxes

export const ENTRY_KINDS = ["message", "idle", "shutdown_request", "shutdown_response", "held"] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

export interface InboxEntry {
	id: string;
	from: string;
	to: string;
	text: string;
	summary?: string;
	kind: EntryKind;
	at: number;
	approve?: boolean; // a shutdown_response: the teammate agrees to stop
}

const MEMBER_NAME = (s: unknown): boolean => typeof s === "string" && (s === LEAD || AGENT_NAME.test(s));

// Why this is not a valid entry; undefined when it is one. The mailbox is a trust boundary: any process may write it.
export function entryProblem(entry: unknown): string | undefined {
	if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return "not an object";
	const e = entry as Record<string, unknown>;
	if (typeof e.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(e.id)) return "bad id";
	if (!MEMBER_NAME(e.from)) return "bad from";
	if (!MEMBER_NAME(e.to)) return "bad to";
	if (typeof e.text !== "string") return "no text";
	if (!(ENTRY_KINDS as readonly unknown[]).includes(e.kind)) return `unknown kind ${JSON.stringify(e.kind)}`;
	if (typeof e.at !== "number" || !Number.isFinite(e.at)) return "bad time";
	if (e.summary !== undefined && typeof e.summary !== "string") return "bad summary";
	if (e.approve !== undefined && typeof e.approve !== "boolean") return "bad approve";
	return undefined;
}

export const inboxFile = (dir: string, name: string): string => join(dir, "inboxes", `${name}.json`);

export const newEntryId = (): string => randomBytes(8).toString("hex");

// The raw array of the file (an empty one when it does not exist or does not hold an array).
function readRaw(file: string): unknown[] {
	if (!existsSync(file)) return [];
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

// Append one entry. It counts as sent once this returns; throws when the write fails (`busy` included).
export async function appendEntry(file: string, entry: InboxEntry): Promise<void> {
	await withLock(file, () => {
		writeAtomic(file, JSON.stringify([...readRaw(file), entry]));
	});
}

// Put entries back at the front (a delivery failed before the target took them).
export async function putBack(file: string, entries: InboxEntry[]): Promise<void> {
	if (entries.length === 0) return;
	await withLock(file, () => {
		writeAtomic(file, JSON.stringify([...entries, ...readRaw(file)]));
	});
}

// Remove from the file the valid entries `select` takes, and every invalid one; the rest stay in order. `select` runs
// while the lock is held: it must not wait. A file that is not an array of entries is dropped as a whole.
export async function takeEntries(
	file: string,
	select: (entry: InboxEntry) => boolean = () => true,
): Promise<{ taken: InboxEntry[]; dropped: string[] }> {
	if (!existsSync(file)) return { taken: [], dropped: [] };
	return withLock(file, () => {
		const taken: InboxEntry[] = [];
		const dropped: string[] = [];
		const kept: InboxEntry[] = [];
		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(file, "utf8"));
		} catch {
			dropped.push("the file is not valid JSON");
			rmSync(file, { force: true });
			return { taken, dropped };
		}
		if (!Array.isArray(raw)) {
			dropped.push("the file does not hold an array");
			rmSync(file, { force: true });
			return { taken, dropped };
		}
		for (const [i, entry] of raw.entries()) {
			const problem = entryProblem(entry);
			if (problem !== undefined) dropped.push(`entry ${i}: ${problem}`);
			else if (select(entry as InboxEntry)) taken.push(entry as InboxEntry);
			else kept.push(entry as InboxEntry);
		}
		if (taken.length > 0 || dropped.length > 0) writeAtomic(file, JSON.stringify(kept));
		return { taken, dropped };
	});
}

// The valid entries waiting, without taking them.
export function peekEntries(file: string): InboxEntry[] {
	return readRaw(file).filter((e) => entryProblem(e) === undefined) as InboxEntry[];
}

export function removeFile(path: string): void {
	try {
		unlinkSync(path);
	} catch {
		// already gone
	}
}
