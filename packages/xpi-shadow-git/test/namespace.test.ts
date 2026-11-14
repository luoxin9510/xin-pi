import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createContext, prepareLaunch, probeNamespace, resolveRepo } from "../src/index.ts";
import { cleanup, initialised, type Lab, read, tempDir, write } from "./helpers.ts";

afterEach(cleanup);

// These tests need unprivileged user namespaces. Where they are forbidden (macOS, a restricted runner) they skip, and
// the skipped test says why.
const probe = probeNamespace(createContext({ cwd: "/", env: process.env }));
const sgMain = join(dirname(fileURLToPath(import.meta.url)), "sg-main.ts");

async function labWith(rules: string[], files: Record<string, string> = {}): Promise<Lab> {
	const l = await initialised({ "a.txt": "a\n", "src/b.txt": "b\n" });
	write(l.ws, "vendor/y.txt", "y\n");
	write(l.ws, "secret/token.txt", "token\n");
	write(l.ws, "key.txt", "key\n");
	write(l.ws, "cache/old.txt", "old\n");
	for (const [path, text] of Object.entries(files)) write(l.ws, path, text);
	expect((await l.sg(["config", "sandbox.backend", "namespace"])).code).toBe(0);
	for (const rule of rules) expect((await l.sg(["config", "--add", "sandbox.rule", rule])).code).toBe(0);
	const made = await l.sg(["sbx", "create", "a"]);
	expect(made.err).toBe("");
	expect(made.code).toBe(0);
	return l;
}

/** Run a shell script inside the sandbox; `$WS`, `$PRIMARY` and `$SCRATCH` are set in it. */
async function inside(l: Lab, script: string) {
	const root = join(realpathSync(l.store), "demo.sbx", "a");
	const result = await l.sg([
		"sbx",
		"run",
		"a",
		"--",
		"sh",
		"-c",
		`WS='${l.ws}'; PRIMARY='${root}/primary'; SCRATCH='${root}/scratch'; ${script}`,
	]);
	return { ...result, root };
}

if (!probe.ok) it.skip(`namespace backend: skipped, ${probe.message}`, () => {});

describe.skipIf(!probe.ok)("namespace backend", () => {
	it("shows the sandbox's files at the workspace's own path, and its changes stay private", async () => {
		const l = await labWith([]);
		const result = await inside(
			l,
			'cd "$WS" && pwd -P && echo "$GIT_WORK_TREE" && cat a.txt vendor/y.txt && echo changed > a.txt && cat "$PRIMARY/a.txt" && git rev-parse --show-toplevel && git status --porcelain',
		);
		expect(result.err).toBe("");
		expect(result.out).toBe(`${l.ws}\n${l.ws}\na\ny\na\n${l.ws}\n M a.txt\n`);
		expect(read(l.ws, "a.txt")).toBe("a\n"); // the primary file is untouched
		expect(read(result.root, "tree/a.txt")).toBe("changed\n");
	});

	it("makes the primary read-only, also through links", async () => {
		const l = await labWith([]);
		const result = await inside(
			l,
			'(echo x > "$PRIMARY/a.txt") 2>/dev/null && echo wrote-a; (touch "$PRIMARY/new.txt") 2>/dev/null && echo wrote-new; (echo x >> "$WS/vendor/y.txt") 2>/dev/null && echo wrote-link; (rm "$PRIMARY/a.txt") 2>/dev/null && echo removed; cat "$PRIMARY/a.txt"',
		);
		expect(result.out).toBe("a\n");
		expect(read(l.ws, "a.txt")).toBe("a\n");
		expect(read(l.ws, "vendor/y.txt")).toBe("y\n");
		expect(existsSync(join(l.ws, "new.txt"))).toBe(false);
	});

	it("hides a directory, a file and the host metadata, also under primary", async () => {
		const l = await labWith(["hidden @ws/secret", "hidden @ws/key.txt"]);
		const result = await inside(
			l,
			'test ! -e "$WS/secret" && echo no-secret-in-tree; test ! -e "$WS/key.txt" && echo no-key-in-tree; ls -A "$PRIMARY/secret" | wc -l; wc -c < "$PRIMARY/key.txt"; ls -A "$PRIMARY/.plainvcs" | wc -l; (echo x > "$PRIMARY/secret/new") 2>/dev/null && echo wrote; cat "$PRIMARY/a.txt"',
		);
		expect(result.out.split("\n").map((line) => line.trim())).toEqual([
			"no-secret-in-tree",
			"no-key-in-tree",
			"0",
			"0",
			"0",
			"a",
			"",
		]);
		expect(read(l.ws, "secret/token.txt")).toBe("token\n");
	});

	it("gives a scratch path its own empty directory", async () => {
		const l = await labWith(["scratch @ws/build"]);
		const result = await inside(
			l,
			'cd "$WS" && mkdir -p build/obj && echo o > build/obj/a.o && ls build && ls "$SCRATCH/build"',
		);
		expect(result.err).toBe("");
		expect(result.out).toBe("obj\nobj\n");
		expect(read(result.root, "scratch/build/obj/a.o")).toBe("o\n");
		expect(existsSync(join(l.ws, "build"))).toBe(false);
	});

	it("shares a shared-rw path with the primary", async () => {
		const l = await labWith(["shared-rw @ws/cache"]);
		const result = await inside(
			l,
			'cd "$WS" && cat cache/old.txt && echo new > cache/new.txt && git status --porcelain',
		);
		expect(result.err).toBe("");
		expect(result.out).toBe("old\n"); // the bind point is not in the sandbox's status
		expect(read(l.ws, "cache/new.txt")).toBe("new\n");
	});

	it("binds a shared-ro path read-only, repeating the flags of a nosuid mount it sits on", async () => {
		const mount = join(tempDir("mnt"), "tools");
		mkdirSync(mount);
		const l = await labWith([`shared-ro ${mount}`]);
		// The tool directory is a nosuid mount made in a namespace of the test's own, so its flags are locked in the
		// sandbox's: a read-only remount that leaves them out fails.
		const script = [
			`mount -t tmpfs -o nosuid,nodev,noexec tmpfs '${mount}'`,
			`echo hi > '${mount}/f'`,
			`exec '${process.execPath}' '${sgMain}' sbx run a -- sh -c 'cat "$0/f"; (echo x > "$0/g") 2>/dev/null && echo wrote; (rm "$0/f") 2>/dev/null && echo removed; true' '${mount}'`,
		].join("; ");
		const outer = spawnSync("unshare", ["--user", "--map-root-user", "--mount", "sh", "-c", script], {
			cwd: l.ws,
			encoding: "utf8",
			env: { ...l.env, XPI_SG_STORE: l.store },
		});
		expect(outer.stderr).toBe("");
		expect(outer.stdout).toBe("hi\n");
		expect(outer.status).toBe(0);
	});

	it("commits on sbx/<id> from inside, with the workspace path as the work tree", async () => {
		const l = await labWith([]);
		const result = await inside(
			l,
			'cd "$WS" && echo n > new.txt && git add new.txt && git commit -qm "from inside" && git status --porcelain && git log --format=%s -1',
		);
		expect(result.err).toBe("");
		expect(result.out).toBe("from inside\n");
		expect(l.git("log", "--format=%s", "main..sbx/a").trim()).toBe("from inside");
		expect(existsSync(join(l.ws, "new.txt"))).toBe(false);
		expect(readFileSync(join(l.store, "demo.git", "refs", "heads", "main"), "utf8").trim()).toBe(
			l.git("rev-parse", "main").trim(),
		);
	});

	it("cannot reach the primary workspace through /proc of a process outside", async () => {
		const l = await labWith([]);
		// The test process is outside the sandbox; without a pid namespace, /proc/<pid>/root is the host's root.
		const result = await inside(
			l,
			`ls /proc/${process.pid}/root${l.ws}/a.txt 2>/dev/null && echo reached; (echo x >> /proc/${process.pid}/root${l.ws}/a.txt) 2>/dev/null && echo wrote; test -e /proc/${process.pid} || echo no-such-process; ls /proc | grep -c '^[0-9][0-9]*$'`,
		);
		expect(result.out).toBe("no-such-process\n2\n".replace("2", result.out.trim().split("\n").at(-1) ?? "0"));
		expect(Number(result.out.trim().split("\n").at(-1))).toBeLessThanOrEqual(4);
		expect(read(l.ws, "a.txt")).toBe("a\n");
	});

	it("cannot change the shared git directory's config, hooks or info", async () => {
		const l = await labWith([]);
		const gitDir = join(realpathSync(l.store), "demo.git");
		const result = await inside(
			l,
			[
				`(git config --file '${gitDir}/config' x.y z) 2>/dev/null && echo config-written`,
				`(echo x > '${gitDir}/hooks/pre-commit') 2>/dev/null && echo hook-written`,
				`(echo x >> '${gitDir}/info/exclude') 2>/dev/null && echo info-written`,
				`(echo x >> '${gitDir}/config.worktree') 2>/dev/null && echo main-worktree-config-written`,
				`(echo x >> '${gitDir}/worktrees/a/config.worktree') 2>/dev/null && echo own-config-written`,
				"echo n > new.txt; git add new.txt && git commit -qm ok && git log --format=%s -1",
			].join("; "),
		);
		expect(result.err).toBe("");
		expect(result.out).toBe("ok\n");
		expect(readFileSync(join(gitDir, "config"), "utf8")).not.toContain("[x]");
		expect(existsSync(join(gitDir, "hooks", "pre-commit"))).toBe(false);
	});

	it("cannot reach another sandbox, or change its own commondir or worktree config", async () => {
		const l = await labWith([]);
		expect((await l.sg(["sbx", "create", "b"])).code).toBe(0);
		const gitDir = join(realpathSync(l.store), "demo.git");
		const other = join(realpathSync(l.store), "demo.sbx", "b");
		const own = join(realpathSync(l.store), "demo.sbx", "a");
		const result = await inside(
			l,
			[
				`(echo '${l.ws}' > '${gitDir}/worktrees/a/commondir') 2>/dev/null && echo own-commondir-written`,
				`(echo x >> '${gitDir}/worktrees/a/gitdir') 2>/dev/null && echo own-gitdir-written`,
				`(echo x >> '${gitDir}/worktrees/b/config.worktree') 2>/dev/null && echo other-config-written`,
				`(echo x >> '${gitDir}/worktrees/b/commondir') 2>/dev/null && echo other-commondir-written`,
				`(echo x > '${other}/tree/a.txt') 2>/dev/null && echo other-tree-written`,
				`(touch '${other}/tree/new.txt') 2>/dev/null && echo other-tree-created`,
				`(echo x > '${own}/excludes') 2>/dev/null && echo own-excludes-written`,
				// what a sandbox needs stays writable: its tree at the workspace path and at its store path, scratch
				`echo ok > "$WS/new.txt" && echo ok > '${own}/tree/second.txt' && echo ok > "$SCRATCH/s.txt"`,
				`cd "$WS" && git add new.txt second.txt && git commit -qm two && git log --format=%s -1`,
			].join("; "),
		);
		expect(result.err).toBe("");
		expect(result.out).toBe("two\n");
		expect(readFileSync(join(gitDir, "worktrees", "a", "commondir"), "utf8").trim()).toBe("../..");
		expect(existsSync(join(other, "tree", "new.txt"))).toBe(false);
		expect(read(own, "scratch/s.txt")).toBe("ok\n");
		expect(l.git("log", "--format=%s", "main..sbx/a").trim()).toBe("two");
	});

	it("returns the command's exit code", async () => {
		const l = await labWith([]);
		expect((await l.sg(["sbx", "run", "a", "--", "sh", "-c", "exit 3"])).code).toBe(3);
	});
	it("prepareLaunch starts a command in a subdirectory of the workspace's own path, with the sandbox's variables", async () => {
		const l = await labWith([]);
		const repo = resolveRepo(createContext({ cwd: l.ws, env: l.env }), undefined);
		const launch = await prepareLaunch(repo, "a", false);
		expect(launch.backend).toBe("namespace");
		const command = launch.wrap(
			[
				"sh",
				"-c",
				'pwd -P; echo "$GIT_WORK_TREE|$XPI_SG_SANDBOX|$XPI_SG_BACKEND"; cat b.txt; git rev-parse --show-toplevel',
			],
			{
				env: { PATH: process.env.PATH },
				subdir: "src",
			},
		);
		const run = spawnSync(command.file, command.args, { cwd: command.cwd, env: command.env, encoding: "utf8" });
		expect(run.stderr).toBe("");
		expect(run.stdout).toBe(`${join(l.ws, "src")}\n${l.ws}|demo/a|namespace\nb\n${l.ws}\n`);
	});
});
