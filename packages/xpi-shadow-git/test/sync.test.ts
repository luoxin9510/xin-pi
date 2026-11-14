import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, initialised, installAdapter, type Lab, read, write } from "./helpers.ts";

afterEach(cleanup);

const plain = join(dirname(fileURLToPath(import.meta.url)), "..", "adapters", "sg-adapter-plain");
const lines = (n: number, replace: Record<number, string> = {}): string =>
	Array.from({ length: n }, (_, i) => `${replace[i + 1] ?? `line ${i + 1}`}\n`).join("");

/**
 * An adapter that wraps the plain one, so a test can make it misbehave: SG_UNPROTECT makes `update` ignore the
 * local-only globs, SG_CRASH makes `update` do its work and then fail, SG_FAIL_CHECKIN makes `checkin` fail.
 */
async function wrapped(l: Lab): Promise<string> {
	const log = join(l.store, "adapter.log");
	installAdapter(
		l,
		"wrap",
		`echo "$1" >> "${log}"
if [ "$1" = update ]; then
	[ -z "\${SG_UNPROTECT:-}" ] || export XPI_SG_LOCAL_ONLY=
	if [ -n "\${SG_CRASH:-}" ]; then sh "${plain}" update > /dev/null; echo "adapter crashed" >&2; exit 1; fi
fi
if [ "$1" = checkin ] && [ -n "\${SG_FAIL_CHECKIN:-}" ]; then cat > /dev/null; echo "host said no" >&2; exit 3; fi
exec sh "${plain}" "$@"`,
	);
	expect((await l.sg(["config", "shadow.adapter", "wrap"])).code).toBe(0);
	return log;
}

const calls = (log: string, op: string): number =>
	existsSync(log)
		? readFileSync(log, "utf8")
				.split("\n")
				.filter((line) => line === op).length
		: 0;

const dirty = (l: Lab): string => l.git("status", "--porcelain");
const branch = (l: Lab): string => l.git("rev-parse", "--abbrev-ref", "HEAD").trim();
const sha = (l: Lab, ref: string): string => l.git("rev-parse", ref).trim();

describe("import", () => {
	it("brings host changes into host and main, and leaves the workspace clean on main", async () => {
		const l = await initialised();
		l.hostCommit({ "a.txt": "a2\n", "new.txt": "n\n", "src/c.txt": null });
		const result = await l.sg(["import"]);
		expect(result.code).toBe(0);
		expect(result.out).toContain("imported plain v2");
		expect(read(l.ws, "a.txt")).toBe("a2\n");
		expect(read(l.ws, "new.txt")).toBe("n\n");
		expect(existsSync(join(l.ws, "src/c.txt"))).toBe(false);
		expect(l.git("log", "--format=%s", "host", "-1").trim()).toBe("sg: import plain v2");
		expect(sha(l, "main")).toBe(sha(l, "host"));
		expect(branch(l)).toBe("main");
		expect(dirty(l)).toBe("");
		expect(existsSync(join(l.store, "demo.git", "SG_IMPORT"))).toBe(false);
		expect(existsSync(join(l.store, "demo.lock"))).toBe(false);
	});

	it("commits nothing when the host did not change", async () => {
		const l = await initialised();
		const before = sha(l, "host");
		expect((await l.sg(["import"])).code).toBe(0);
		expect(sha(l, "host")).toBe(before);
	});

	it("merges host changes with local work, and lists files changed on both sides", async () => {
		const l = await initialised({ "a.txt": lines(9), "b.txt": "b\n" });
		write(l.ws, "a.txt", lines(9, { 1: "mine" }));
		write(l.ws, "mine.txt", "mine\n");
		await l.sg(["add", "-A"]);
		await l.sg(["commit", "-q", "-m", "local work"]);
		l.hostCommit({ "a.txt": lines(9, { 9: "theirs" }), "b.txt": "b2\n" });

		const result = await l.sg(["import"]);
		expect(result.code).toBe(0);
		expect(result.out).toMatch(/changed in the import and in your work since the last import \(1\):\n {2}a\.txt\n/);
		expect(result.out).not.toContain("b.txt\n  ");
		expect(read(l.ws, "a.txt")).toBe(lines(9, { 1: "mine", 9: "theirs" }));
		expect(read(l.ws, "b.txt")).toBe("b2\n");
		expect(l.git("log", "--format=%s", "-1").trim()).toMatch(/^Merge/);
		expect(branch(l)).toBe("main");
		// host is still an ancestor of main
		expect(
			spawnSync("git", ["merge-base", "--is-ancestor", "host", "main"], {
				env: { ...l.env, GIT_DIR: join(l.store, "demo.git") },
			}).status,
		).toBe(0);
	});

	it("stops on a conflict with git's own state, and the user finishes with plain git", async () => {
		const l = await initialised({ "a.txt": lines(3) });
		write(l.ws, "a.txt", lines(3, { 2: "mine" }));
		await l.sg(["commit", "-q", "-a", "-m", "mine"]);
		l.hostCommit({ "a.txt": lines(3, { 2: "theirs" }) });

		const result = await l.sg(["import"]);
		expect(result.code).toBe(1);
		expect(result.out).toContain("CONFLICT");
		expect(result.err).toContain("the merge stopped");
		expect(result.out).toContain("a.txt");
		expect(existsSync(join(l.store, "demo.git", "MERGE_HEAD"))).toBe(true);
		expect(existsSync(join(l.store, "demo.git", "SG_IMPORT"))).toBe(false);
		expect(existsSync(join(l.store, "demo.lock"))).toBe(false);
		expect(read(l.ws, "a.txt")).toContain("<<<<<<<");

		write(l.ws, "a.txt", lines(3, { 2: "both" }));
		await l.sg(["add", "a.txt"]);
		expect((await l.sg(["merge", "--continue"], { env: { GIT_EDITOR: "true" } })).code).toBe(0);
		expect(read(l.ws, "a.txt")).toBe(lines(3, { 2: "both" }));
		expect(dirty(l)).toBe("");
	});

	it("is aborted by git merge --abort after a conflict", async () => {
		const l = await initialised({ "a.txt": lines(3) });
		write(l.ws, "a.txt", lines(3, { 2: "mine" }));
		await l.sg(["commit", "-q", "-a", "-m", "mine"]);
		l.hostCommit({ "a.txt": lines(3, { 2: "theirs" }) });
		expect((await l.sg(["import"])).code).toBe(1);
		expect((await l.sg(["merge", "--abort"])).code).toBe(0);
		expect(read(l.ws, "a.txt")).toBe(lines(3, { 2: "mine" }));
		expect(existsSync(join(l.store, "demo.git", "MERGE_HEAD"))).toBe(false);
	});

	it("needs a clean tree (exit 2), and takes nothing from a dirty one", async () => {
		const l = await initialised();
		write(l.ws, "a.txt", "dirty\n");
		write(l.ws, "untracked.txt", "u\n");
		l.hostCommit({ "b.txt": "b\n" });
		const result = await l.sg(["import"]);
		expect(result.code).toBe(2);
		expect(result.err).toContain("a.txt");
		expect(result.err).toContain("untracked.txt");
		expect(existsSync(join(l.ws, "b.txt"))).toBe(false);
		expect(existsSync(join(l.store, "demo.git", "SG_IMPORT"))).toBe(false);
	});

	it("does not import what the host changed outside the scope", async () => {
		const l = await initialised({ "a.txt": "a\n", "src/b.txt": "b\n" }, ["--scope", "src/"]);
		l.hostCommit({ "a.txt": "changed\n", "src/b.txt": "b2\n" });
		expect((await l.sg(["import"])).code).toBe(0);
		expect(read(l.ws, "src/b.txt")).toBe("b2\n");
		expect(read(l.ws, "a.txt")).toBe("a\n");
		expect(l.git("ls-files").trim().split("\n")).toEqual(["src/b.txt"]);
	});
});

describe("local-only paths", () => {
	const setup = async (): Promise<Lab> => {
		const l = await initialised({ "a.txt": "a\n", "src/b.txt": "b\n" }, ["--local-only", "AGENTS.md", ".pi/"]);
		write(l.ws, "AGENTS.md", "notes\n");
		write(l.ws, ".pi/settings.json", "{}\n");
		write(l.ws, "src/new.txt", "new\n");
		await l.sg(["add", "-A"]);
		await l.sg(["commit", "-q", "-m", "work and notes"]);
		return l;
	};

	it("stay out of the export plan and the host", async () => {
		const l = await setup();
		const plan = await l.sg(["export"]);
		expect(plan.code).toBe(0);
		expect(plan.out).toContain("1 path(s) from 1 commit(s)");
		expect(plan.out).toContain("A\tsrc/new.txt");
		expect(plan.out).not.toContain("AGENTS.md");
		expect(plan.out).not.toContain(".pi");
		expect((await l.sg(["export", "--apply"])).code).toBe(0);
		expect(existsSync(join(l.upstream, "AGENTS.md"))).toBe(false);
		expect(existsSync(join(l.upstream, ".pi"))).toBe(false);
		expect(read(l.upstream, "src/new.txt")).toBe("new\n");
		// after an export host holds them too
		expect(l.git("ls-tree", "-r", "--name-only", "host").split("\n")).toContain("AGENTS.md");
	});

	it.each([
		["the adapter honours XPI_SG_LOCAL_ONLY", false],
		["the adapter deletes them", true],
	])("survive an import after an export when %s", async (_name, unprotected) => {
		const l = await setup();
		await wrapped(l);
		expect((await l.sg(["export", "--apply"])).code).toBe(0);
		l.hostCommit({ "a.txt": "a2\n" });
		const result = await l.sg(["import"], { env: unprotected ? { SG_UNPROTECT: "1" } : {} });
		expect(result.code).toBe(0);
		expect(read(l.ws, "AGENTS.md")).toBe("notes\n");
		expect(read(l.ws, ".pi/settings.json")).toBe("{}\n");
		expect(read(l.ws, "a.txt")).toBe("a2\n");
		expect(l.git("show", "host:AGENTS.md")).toBe("notes\n");
		expect(dirty(l)).toBe("");
	});

	describe("a host file at a local-only path", () => {
		// The host has AGENTS.md, which the user already has on main and has not exported.
		const collide = async (): Promise<{ l: Lab; log: string }> => {
			const l = await initialised({ "a.txt": "a\n" }, ["--local-only", "AGENTS.md"]);
			write(l.ws, "AGENTS.md", "mine\n");
			await l.sg(["add", "-A"]);
			await l.sg(["commit", "-q", "-m", "my notes"]);
			const log = await wrapped(l);
			l.hostCommit({ "AGENTS.md": "theirs\n", "a.txt": "a2\n" });
			return { l, log };
		};

		it("stops import on host with SG_IMPORT left, and a rerun resumes at the commit", async () => {
			const { l, log } = await collide();
			const stopped = await l.sg(["import"], { env: { SG_UNPROTECT: "1" } });
			expect(stopped.code).toBe(1);
			expect(stopped.err).toContain("AGENTS.md");
			expect(stopped.err).toContain("local-only");
			expect(branch(l)).toBe("host");
			expect(existsSync(join(l.store, "demo.git", "SG_IMPORT"))).toBe(true);
			expect(read(l.store, "demo.git/SG_IMPORT")).toMatch(/^old [0-9a-f]{40}\nlabel plain v2\n$/);
			expect(existsSync(join(l.store, "demo.lock"))).toBe(false);

			// a rerun resumes at the commit step: update does not run again, and the collision stops it again
			expect(calls(log, "update")).toBe(1);
			const again = await l.sg(["import"], { env: { SG_UNPROTECT: "1" } });
			expect(again.code).toBe(1);
			expect(calls(log, "update")).toBe(1);
			expect(existsSync(join(l.store, "demo.git", "SG_IMPORT"))).toBe(true);

			// the user moves the host's file out of the way
			rmSync(join(l.ws, "AGENTS.md"));
			const done = await l.sg(["import"], { env: { SG_UNPROTECT: "1" } });
			expect(done.code).toBe(0);
			expect(calls(log, "update")).toBe(1);
			expect(existsSync(join(l.store, "demo.git", "SG_IMPORT"))).toBe(false);
			expect(branch(l)).toBe("main");
			expect(read(l.ws, "AGENTS.md")).toBe("mine\n");
			expect(read(l.ws, "a.txt")).toBe("a2\n");
		});

		it("is dropped by --abort, which returns to the last host state", async () => {
			const { l } = await collide();
			const hostBefore = sha(l, "host");
			expect((await l.sg(["import"], { env: { SG_UNPROTECT: "1" } })).code).toBe(1);
			const aborted = await l.sg(["import", "--abort"]);
			expect(aborted.code).toBe(0);
			expect(existsSync(join(l.store, "demo.git", "SG_IMPORT"))).toBe(false);
			expect(branch(l)).toBe("main");
			expect(sha(l, "host")).toBe(hostBefore);
			expect(read(l.ws, "AGENTS.md")).toBe("mine\n");
			expect(read(l.ws, "a.txt")).toBe("a\n");
			expect(dirty(l)).toBe("");
		});

		it("makes export, merge and a plain import's guards refuse while the record exists", async () => {
			const { l } = await collide();
			expect((await l.sg(["import"], { env: { SG_UNPROTECT: "1" } })).code).toBe(1);
			for (const args of [["export"], ["export", "--apply"], ["merge", "main"]]) {
				const result = await l.sg(args);
				expect(result.code).toBe(2);
				expect(result.err).toContain("SG_IMPORT");
			}
			const status = await l.sg(["status"]);
			expect(status.out).toContain("import STOPPED");
			expect(status.out).toContain("label plain v2");
		});
	});

	it("--abort without a stopped import is exit 2", async () => {
		const l = await initialised();
		const result = await l.sg(["import", "--abort"]);
		expect(result.code).toBe(2);
		expect(result.err).toContain("nothing to abort");
	});

	it("reruns update after a crash in it", async () => {
		const l = await initialised();
		const log = await wrapped(l);
		l.hostCommit({ "a.txt": "a2\n", "z.txt": "z\n" });
		const crashed = await l.sg(["import"], { env: { SG_CRASH: "1" } });
		expect(crashed.code).toBe(1);
		expect(crashed.err).toContain("adapter crashed");
		expect(read(l.store, "demo.git/SG_IMPORT")).toMatch(/^old [0-9a-f]{40}\n$/);
		expect(branch(l)).toBe("host");
		expect(existsSync(join(l.store, "demo.lock"))).toBe(false);
		expect((await l.sg(["export"])).code).toBe(2);

		const resumed = await l.sg(["import"]);
		expect(resumed.code).toBe(0);
		expect(calls(log, "update")).toBe(2);
		expect(read(l.ws, "z.txt")).toBe("z\n");
		expect(branch(l)).toBe("main");
		expect(existsSync(join(l.store, "demo.git", "SG_IMPORT"))).toBe(false);
	});
});

describe("export", () => {
	it("prints the plan with commit subjects, a rename as D and A, and changes nothing", async () => {
		const l = await initialised();
		write(l.ws, "a.txt", "a2\n");
		await l.sg(["commit", "-q", "-a", "-m", "edit a"]);
		await l.sg(["mv", "src/b.txt", "src/renamed.txt"]);
		write(l.ws, "added.txt", "x\n");
		await l.sg(["rm", "-q", "src/c.txt"]);
		await l.sg(["add", "-A"]);
		await l.sg(["commit", "-q", "-m", "move and add"]);
		const hostBefore = sha(l, "host");
		const result = await l.sg(["export"]);
		expect(result.code).toBe(0);
		expect(result.out.split("\n")).toEqual([
			"export plan: 5 path(s) from 2 commit(s) in host..main",
			"  edit a",
			"  move and add",
			"M\ta.txt",
			"A\tadded.txt",
			"D\tsrc/b.txt",
			"D\tsrc/c.txt",
			"A\tsrc/renamed.txt",
			"",
		]);
		expect(sha(l, "host")).toBe(hostBefore);
		expect(read(l.upstream, "a.txt")).toBe("a\n");
	});

	it("applies through the adapter and advances host", async () => {
		const l = await initialised();
		write(l.ws, "a.txt", "a2\n");
		write(l.ws, "added.txt", "x\n");
		await l.sg(["add", "-A"]);
		await l.sg(["commit", "-q", "-m", "edit and add"]);
		await l.sg(["rm", "-q", "src/c.txt"]);
		await l.sg(["commit", "-q", "-m", "drop c"]);
		const result = await l.sg(["export", "--apply"]);
		expect(result.code).toBe(0);
		expect(result.out).toContain("exported");
		expect(read(l.upstream, "a.txt")).toBe("a2\n");
		expect(read(l.upstream, "added.txt")).toBe("x\n");
		expect(existsSync(join(l.upstream, "src/c.txt"))).toBe(false);
		expect(read(l.upstream, ".plainvcs/version")).toBe("2\n");
		const hostLog = read(l.upstream, ".plainvcs/log");
		expect(hostLog).toContain("edit and add");
		expect(hostLog).toContain("- drop c");
		expect(sha(l, "host")).toBe(sha(l, "main"));
		expect((await l.sg(["export"])).out).toContain("0 path(s) from 0 commit(s)");
		expect(existsSync(join(l.store, "demo.lock"))).toBe(false);
	});

	it("changes nothing in git when the adapter fails", async () => {
		const l = await initialised();
		await wrapped(l);
		write(l.ws, "a.txt", "a2\n");
		await l.sg(["commit", "-q", "-a", "-m", "edit"]);
		const hostBefore = sha(l, "host");
		const result = await l.sg(["export", "--apply"], { env: { SG_FAIL_CHECKIN: "1" } });
		expect(result.code).toBe(1);
		expect(result.err).toContain("host said no");
		expect(sha(l, "host")).toBe(hostBefore);
		expect(read(l.upstream, "a.txt")).toBe("a\n");
		expect(existsSync(join(l.store, "demo.lock"))).toBe(false);
		expect(existsSync(join(l.store, "demo.checkin-message"))).toBe(false);
	});

	it("checks the plain adapter in without a partial effect when a file is missing", async () => {
		const l = await initialised();
		const input = "M\ta.txt\nA\tmissing.txt\n";
		const result = spawnSync("sh", [plain, "checkin"], {
			cwd: l.ws,
			input,
			encoding: "utf8",
			env: { ...l.env, XPI_SG_WORKSPACE: l.ws, XPI_SG_GIT_DIR: join(l.store, "demo.git"), XPI_SG_GIT: "git" },
		});
		expect(result.status).toBe(1);
		expect(read(l.upstream, ".plainvcs/version")).toBe("1\n");
	});

	it("refuses paths outside shadow.scope, and nothing is exported", async () => {
		const l = await initialised({ "a.txt": "a\n", "src/b.txt": "b\n" }, ["--scope", "src/"]);
		write(l.ws, "src/b.txt", "b2\n");
		write(l.ws, "a.txt", "outside\n");
		await l.sg(["add", "-f", "a.txt", "src/b.txt"]);
		await l.sg(["commit", "-q", "-m", "inside and outside"]);
		const hostBefore = sha(l, "host");
		for (const args of [["export"], ["export", "--apply"]]) {
			const result = await l.sg(args);
			expect(result.code).toBe(2);
			expect(result.err).toContain("outside shadow.scope");
			expect(result.err).toContain("  a.txt");
			expect(result.err).not.toContain("  src/b.txt");
		}
		expect(sha(l, "host")).toBe(hostBefore);
		expect(read(l.upstream, "src/b.txt")).toBe("b\n");
	});

	it("is exit 2 on a dirty tree, off main, and when host is not an ancestor of main", async () => {
		const l = await initialised();
		write(l.ws, "a.txt", "dirty\n");
		const dirtyResult = await l.sg(["export"]);
		expect(dirtyResult.code).toBe(2);
		expect(dirtyResult.err).toContain("a.txt");
		await l.sg(["checkout", "-q", "--", "a.txt"]);

		await l.sg(["checkout", "-q", "-b", "other"]);
		const off = await l.sg(["export", "--apply"]);
		expect(off.code).toBe(2);
		expect(off.err).toContain("main checked out");
		await l.sg(["checkout", "-q", "main"]);

		// a commit on host that main does not have
		await l.sg(["checkout", "-q", "host"]);
		write(l.ws, "h.txt", "h\n");
		await l.sg(["add", "h.txt"]);
		await l.sg(["commit", "-q", "-m", "host only"]);
		await l.sg(["checkout", "-q", "main"]);
		const broken = await l.sg(["export"]);
		expect(broken.code).toBe(2);
		expect(broken.err).toContain("not an ancestor");
		expect((await l.sg(["export", "--apply"])).code).toBe(2);
	});

	it("applies with only local-only changes by moving host without calling the adapter", async () => {
		const l = await initialised({ "a.txt": "a\n" }, ["--local-only", "AGENTS.md"]);
		const log = await wrapped(l);
		write(l.ws, "AGENTS.md", "notes\n");
		await l.sg(["add", "-A"]);
		await l.sg(["commit", "-q", "-m", "notes"]);
		const result = await l.sg(["export", "--apply"]);
		expect(result.code).toBe(0);
		expect(result.out).toContain("0 path(s)");
		expect(calls(log, "checkin")).toBe(0);
		expect(sha(l, "host")).toBe(sha(l, "main"));
	});
});

describe("merge", () => {
	it("merges a branch into main", async () => {
		const l = await initialised();
		await l.sg(["checkout", "-q", "-b", "sbx/one"]);
		write(l.ws, "one.txt", "1\n");
		await l.sg(["add", "one.txt"]);
		await l.sg(["commit", "-q", "-m", "one"]);
		await l.sg(["checkout", "-q", "main"]);
		write(l.ws, "a.txt", "main side\n");
		await l.sg(["commit", "-q", "-a", "-m", "main work"]);
		const result = await l.sg(["merge", "sbx/one"]);
		expect(result.code).toBe(0);
		expect(read(l.ws, "one.txt")).toBe("1\n");
		expect(l.git("log", "--format=%s", "-1").trim()).toMatch(/^Merge/);
		expect(existsSync(join(l.store, "demo.lock"))).toBe(false);
	});

	it("is exit 2 for an unknown branch, a dirty tree, another branch checked out and a bad argument", async () => {
		const l = await initialised();
		expect((await l.sg(["merge", "ghost"])).code).toBe(2);
		expect((await l.sg(["merge"])).code).toBe(2);
		expect((await l.sg(["merge", "--squash", "x"])).code).toBe(2);
		await l.sg(["branch", "side"]);
		write(l.ws, "a.txt", "dirty\n");
		expect((await l.sg(["merge", "side"])).code).toBe(2);
		await l.sg(["checkout", "-q", "--", "a.txt"]);
		await l.sg(["checkout", "-q", "side"]);
		const off = await l.sg(["merge", "main"]);
		expect(off.code).toBe(2);
		expect(off.err).toContain("main checked out");
	});

	it("stops on a conflict with exit 1", async () => {
		const l = await initialised({ "a.txt": lines(3) });
		await l.sg(["checkout", "-q", "-b", "side"]);
		write(l.ws, "a.txt", lines(3, { 2: "side" }));
		await l.sg(["commit", "-q", "-a", "-m", "side"]);
		await l.sg(["checkout", "-q", "main"]);
		write(l.ws, "a.txt", lines(3, { 2: "main" }));
		await l.sg(["commit", "-q", "-a", "-m", "main"]);
		const result = await l.sg(["merge", "side"]);
		expect(result.code).toBe(1);
		expect(result.out).toContain("CONFLICT");
		expect(existsSync(join(l.store, "demo.git", "MERGE_HEAD"))).toBe(true);
	});
});

describe("live sessions", () => {
	const session = (l: Lab, pid: number): void => {
		mkdirSync(join(l.store, "demo.sessions"), { recursive: true });
		writeFileSync(join(l.store, "demo.sessions", String(pid)), "");
	};

	const deadPid = (): number => {
		const child = spawnSync(process.execPath, ["-e", ""]);
		return child.pid;
	};

	it("make import, export --apply and merge exit 2, while the plan and status still work", async () => {
		const l = await initialised();
		await l.sg(["branch", "side"]);
		session(l, process.pid);
		for (const args of [["import"], ["import", "--abort"], ["export", "--apply"], ["merge", "side"]]) {
			const result = await l.sg(args);
			expect(result.code).toBe(2);
			expect(result.err).toContain(`pid ${process.pid}`);
		}
		expect((await l.sg(["export"])).code).toBe(0);
		expect((await l.sg(["status"])).out).toContain(`live sessions: pid ${process.pid}`);
	});

	it("do not count when they are the caller's own", async () => {
		const l = await initialised();
		session(l, process.pid);
		expect((await l.sg(["import"], { ownSessionPid: process.pid })).code).toBe(0);
	});

	it("drop a pid that is not alive", async () => {
		const l = await initialised();
		const dead = deadPid();
		session(l, dead);
		expect((await l.sg(["import"])).code).toBe(0);
		expect(existsSync(join(l.store, "demo.sessions", String(dead)))).toBe(false);
	});
});
