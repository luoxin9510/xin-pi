import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gitCommandWord } from "../src/cli.ts";
import { createContext, SgError, withLock } from "../src/index.ts";
import { cleanup, initialised, installAdapter, type Lab, read, tempDir, write } from "./helpers.ts";

afterEach(cleanup);

const branch = (l: Lab): string => l.git("rev-parse", "--abbrev-ref", "HEAD").trim();
const plain = new URL("../adapters/sg-adapter-plain", import.meta.url).pathname;

/** A git that fails when a command's arguments contain `pattern`. */
function failingGit(l: Lab, name: string, pattern: string): string {
	const file = join(l.adapters, name);
	writeFileSync(
		file,
		`#!/bin/sh\ncase "$*" in *"${pattern}"*) echo "forced failure" >&2; exit 1;; esac\nexec git "$@"\n`,
	);
	chmodSync(file, 0o755);
	return file;
}

describe("resume", () => {
	it("refuses a dirty tree when the user left host during the stop, and commits nothing", async () => {
		const l = await initialised();
		installAdapter(
			l,
			"crash",
			`if [ "$1" = update ]; then sh "${plain}" update >/dev/null; exit 1; fi\nexec sh "${plain}" "$@"`,
		);
		await l.sg(["config", "shadow.adapter", "crash"]);
		l.hostCommit({ "z.txt": "z\n" });
		expect((await l.sg(["import"])).code).toBe(1);
		const hostBefore = l.git("rev-parse", "host").trim();
		await l.sg(["checkout", "-q", "-f", "main"]);
		write(l.ws, "a.txt", "my edit\n");
		const result = await l.sg(["import"]);
		expect(result.code).toBe(2);
		expect(result.err).toContain("a.txt");
		expect(branch(l)).toBe("main");
		expect(l.git("rev-parse", "host").trim()).toBe(hostBefore);
		expect(read(l.ws, "a.txt")).toBe("my edit\n");
	});
});

describe("import --abort", () => {
	// scope src/, so AGENTS.md is outside the scope: only the local-only pathspec in the clean removes the host's copy
	const stopped = async (): Promise<Lab> => {
		const l = await initialised({ "src/b.txt": "b\n" }, ["--scope", "src/", "--local-only", "AGENTS.md"]);
		write(l.ws, "AGENTS.md", "mine\n");
		await l.sg(["add", "-A"]);
		await l.sg(["commit", "-q", "-m", "notes"]);
		installAdapter(
			l,
			"ignore",
			`if [ "$1" = update ]; then XPI_SG_LOCAL_ONLY=; export XPI_SG_LOCAL_ONLY; fi\nexec sh "${plain}" "$@"`,
		);
		await l.sg(["config", "shadow.adapter", "ignore"]);
		write(l.upstream, "AGENTS.md", "theirs\n");
		l.hostCommit({ "src/b.txt": "b2\n" });
		write(l.ws, "../upstream/AGENTS.md", "theirs\n");
		return l;
	};

	it("removes a host file at a local-only path outside the scope and gets back to main", async () => {
		const l = await stopped();
		// the plain adapter copies only in-scope files; copy the colliding one by hand, as an adapter that did would
		write(l.ws, "AGENTS.md", "theirs\n");
		await l.sg(["checkout", "-q", "-f", "host"]);
		write(l.ws, "AGENTS.md", "theirs\n");
		write(l.store, "demo.git/SG_IMPORT", `old ${l.git("rev-parse", "host").trim()}\nlabel x\n`);
		const result = await l.sg(["import", "--abort"]);
		expect(result.err).toBe("");
		expect(result.code).toBe(0);
		expect(branch(l)).toBe("main");
		expect(read(l.ws, "AGENTS.md")).toBe("mine\n");
		expect(existsSync(join(l.store, "demo.git", "SG_IMPORT"))).toBe(false);
	});

	it("keeps the record when the checkout of main fails", async () => {
		const l = await initialised();
		installAdapter(
			l,
			"crash",
			`if [ "$1" = update ]; then sh "${plain}" update >/dev/null; exit 1; fi\nexec sh "${plain}" "$@"`,
		);
		await l.sg(["config", "shadow.adapter", "crash"]);
		l.hostCommit({ "z.txt": "z\n" });
		expect((await l.sg(["import"])).code).toBe(1);
		const git = failingGit(l, "git-nomain", "checkout -q main");
		const aborted = await l.sg(["import", "--abort"], { env: { XPI_SG_GIT: git } });
		expect(aborted.err).toContain("forced failure");
		expect(aborted.code).toBe(1);
		expect(existsSync(join(l.store, "demo.git", "SG_IMPORT"))).toBe(true);
		expect((await l.sg(["import", "--abort"])).code).toBe(0);
		expect(existsSync(join(l.store, "demo.git", "SG_IMPORT"))).toBe(false);
	});
});

describe("plain adapter local-only globs", () => {
	it("follow git's pathspec rules: * does not cross /, and **/x matches a root x", async () => {
		const l = await initialised({ "a.txt": "a\n" }, ["--local-only", "docs/*.md", "**/LOCAL.md"]);
		l.hostCommit({ "docs/sub/x.md": "x\n", "docs/top.md": "top\n", "LOCAL.md": "root\n", "deep/LOCAL.md": "deep\n" });
		const result = await l.sg(["import"]);
		expect(result.err).toBe("");
		expect(result.code).toBe(0);
		// docs/sub/x.md is not matched by docs/*.md, so it is imported; docs/top.md and both LOCAL.md are protected
		expect(read(l.ws, "docs/sub/x.md")).toBe("x\n");
		expect(existsSync(join(l.ws, "docs/top.md"))).toBe(false);
		expect(existsSync(join(l.ws, "LOCAL.md"))).toBe(false);
		expect(existsSync(join(l.ws, "deep/LOCAL.md"))).toBe(false);
	});
});

describe("plain adapter robustness", () => {
	it("handles file names that start with a dash, in import and export", async () => {
		const l = await initialised({ "a.txt": "a\n" });
		l.hostCommit({ "-dash.txt": "d\n" });
		const imported = await l.sg(["import"]);
		expect(imported.err).toBe("");
		expect(read(l.ws, "-dash.txt")).toBe("d\n");
		write(l.ws, "-other.txt", "o\n");
		await l.sg(["add", "-A"]);
		await l.sg(["commit", "-q", "-m", "dash"]);
		const exported = await l.sg(["export", "--apply"]);
		expect(exported.err).toBe("");
		expect(exported.code).toBe(0);
		expect(read(l.upstream, "-other.txt")).toBe("o\n");
	});

	it("fails the update when listing the tracked files fails, and deletes nothing", async () => {
		const l = await initialised();
		l.hostCommit({ "a.txt": null });
		const git = failingGit(l, "git-nols", "ls-tree");
		const result = await l.sg(["import"], { env: { XPI_SG_GIT: git } });
		expect(result.code).toBe(1);
		expect(result.err).toContain("cannot list");
		expect(read(l.ws, "a.txt")).toBe("a\n");
	});
});

describe("blocked commands", () => {
	it("are found after git's global options", async () => {
		expect(gitCommandWord(["-c", "k=v", "-C", "dir", "--no-pager", "push"])).toBe("push");
		expect(gitCommandWord(["--git-dir=/x", "fetch", "origin"])).toBe("fetch");
		expect(gitCommandWord(["log", "-c"])).toBe("log");
		const l = await initialised();
		for (const args of [
			["-c", "x.y=z", "push"],
			["-C", ".", "fetch"],
			["--no-pager", "pull"],
		]) {
			const result = await l.sg(args);
			expect(result.code).toBe(2);
			expect(result.err).toContain("is not available");
		}
	});
});

describe("merge --continue and --abort", () => {
	it("take the lock and refuse beside a live session", async () => {
		const l = await initialised();
		mkdirSync(join(l.store, "demo.sessions"), { recursive: true });
		writeFileSync(join(l.store, "demo.sessions", String(process.pid)), "");
		for (const flag of ["--continue", "--abort"]) {
			const result = await l.sg(["merge", flag]);
			expect(result.code).toBe(2);
			expect(result.err).toContain("live");
		}
		await l.sg(["status"]); // keep the entry for the lock case below
		const other = await initialised({ "a.txt": "a\n" }, [], "second");
		writeFileSync(join(other.store, "second.lock"), JSON.stringify({ pid: process.pid, at: Date.now() }));
		const held = await other.sg(["merge", "--abort"], { lockTimeoutMs: 100 });
		expect(held.code).toBe(2);
		expect(held.err).toContain("is held");
	});
});

describe("lock deadline", () => {
	it("is checked after a takeover attempt that loses the guard", async () => {
		const dir = tempDir("lock");
		const lock = join(dir, "demo.lock");
		// a stale lock, and a takeover guard held by a live process: no taker can ever finish
		writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 1, at: 0 }));
		writeFileSync(`${lock}.takeover`, JSON.stringify({ pid: process.pid, at: Date.now() }));
		const ctx = createContext({ cwd: dir, env: { XPI_SG_STORE: dir }, lockTimeoutMs: 150 });
		const error = await withLock(ctx, lock, () => undefined).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(SgError);
		expect((error as SgError).code).toBe(2);
	}, 3000);
});
