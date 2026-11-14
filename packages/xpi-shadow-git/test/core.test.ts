import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, initialised, lab, read, tempDir, tree, write } from "./helpers.ts";

afterEach(cleanup);

const adaptersDir = join(dirname(fileURLToPath(import.meta.url)), "..", "adapters");

describe("init", () => {
	it("writes nothing into the workspace and builds the shadow repo in the store", async () => {
		const l = lab();
		write(l.ws, "a.txt", "a\n");
		write(l.ws, "src/b.txt", "b\n");
		write(l.upstream, "a.txt", "a\n");
		write(l.ws, ".plainvcs/version", "1\n");
		const before = tree(l.ws);
		const modified = statSync(join(l.ws, "a.txt")).mtimeMs;

		const result = await l.sg([
			"init",
			"demo",
			"--adapter",
			"plain",
			"--config",
			`shadow.plain.upstream=${l.upstream}`,
		]);
		expect(result.code).toBe(0);

		expect(tree(l.ws)).toEqual(before);
		expect(statSync(join(l.ws, "a.txt")).mtimeMs).toBe(modified);
		expect(existsSync(join(l.ws, ".git"))).toBe(false);

		const gitDir = join(l.store, "demo.git");
		expect(read(gitDir, "config")).toContain("worktreeConfig = true");
		expect(read(gitDir, "config")).toContain("repositoryformatversion = 1");
		// core.worktree is in the main worktree's own config, not the shared one
		expect(read(gitDir, "config")).not.toContain("worktree =\t");
		expect(read(gitDir, "config.worktree")).toContain(`worktree = ${l.ws}`);
		expect(read(gitDir, "info/exclude")).toContain("/.plainvcs");

		expect(l.git("rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");
		expect(l.git("log", "--format=%s", "host").trim()).toBe("sg: baseline");
		expect(l.git("rev-parse", "main").trim()).toBe(l.git("rev-parse", "host").trim());
		expect(l.git("ls-files").trim().split("\n").sort()).toEqual(["a.txt", "src/b.txt"]);
		expect(read(l.store, "registry")).toBe(`${l.ws}\tdemo\n`);
	});

	it("tracks only the scope and the local-only paths", async () => {
		const l = await initialised(
			{ "a.txt": "a\n", "src/b.txt": "b\n", "AGENTS.md": "agents\n", "docs/d.txt": "d\n" },
			["--scope", "src/", "--local-only", "AGENTS.md"],
		);
		expect(l.git("ls-files").trim().split("\n").sort()).toEqual(["AGENTS.md", "src/b.txt"]);
		expect((await l.sg(["status"])).out).toContain("## main");
	});

	it("refuses a workspace that is registered, above or below a registered one, and a name in use", async () => {
		const l = await initialised();
		const flags = ["--adapter", "plain"];
		const nested = join(l.ws, "src");
		const other = await l.sg(["init", "inner", ...flags], { cwd: nested });
		expect(other.code).toBe(2);
		expect(other.err).toContain("overlaps");
		expect((await l.sg(["init", "again", ...flags])).code).toBe(2);

		const above = join(l.ws, "..");
		const parent = await l.sg(["init", "outer", ...flags], { cwd: above });
		expect(parent.code).toBe(2);
		expect(parent.err).toContain("overlaps");

		const sibling = tempDir("sibling");
		const reused = await l.sg(["init", "demo", ...flags], { cwd: sibling });
		expect(reused.code).toBe(2);
		expect(reused.err).toContain("exists already");
		expect(read(l.store, "registry")).toBe(`${l.ws}\tdemo\n`);
	});

	it("rolls back when the adapter fails, and rejects bad input", async () => {
		const l = lab();
		write(l.ws, "a.txt", "a\n");
		const failed = await l.sg(["init", "demo", "--adapter", "plain", "--scope", "../x"]);
		expect(failed.code).toBe(2);
		expect((await l.sg(["init", "demo", "--adapter", "nope"])).err).toContain("no executable sg-adapter-nope");
		// the template adapter refuses every op: init stops and leaves nothing registered
		const template = await l.sg(["init", "demo", "--adapter", "template"], {
			env: { XPI_SG_ADAPTER_PATH: adaptersDir },
		});
		expect(template.code).toBe(1);
		expect(template.err).toContain("not implemented");
		expect(existsSync(join(l.store, "demo.git"))).toBe(false);
		expect(existsSync(join(l.store, "registry")) ? readFileSync(join(l.store, "registry"), "utf8") : "").toBe("");
		expect((await l.sg(["list"])).out).toBe("");
	});

	it("writes the opt-in .git file only with --gitfile", async () => {
		const l = await initialised({ "a.txt": "a\n" }, ["--gitfile"]);
		expect(read(l.ws, ".git")).toBe(`gitdir: ${join(l.store, "demo.git")}\n`);
		expect(read(l.store, "demo.git/info/exclude")).toContain("/.git");
		const status = spawnSync("git", ["status", "--short"], { cwd: l.ws, encoding: "utf8", env: l.env });
		expect(status.status).toBe(0);
		expect(status.stdout).toBe("");
	});
});

describe("registry", () => {
	it("resolves by the longest registered path, and --repo overrides", async () => {
		const l = await initialised();
		const other = tempDir("other");
		write(other, "x.txt", "x\n");
		write(l.upstream, "x.txt", "x\n");
		expect((await l.sg(["init", "second", "--adapter", "plain"], { cwd: other })).code).toBe(0);

		expect((await l.sg(["list"])).out).toBe(`${l.ws}\tdemo\n${other}\tsecond\n`);
		expect((await l.sg(["env"], { cwd: join(l.ws, "src") })).out).toBe(
			`export GIT_DIR='${join(l.store, "demo.git")}' GIT_WORK_TREE='${l.ws}'\n`,
		);
		expect((await l.sg(["env"], { cwd: other })).out).toContain("second.git");
		expect((await l.sg(["--repo", "demo", "env"], { cwd: other })).out).toContain("demo.git");
		expect((await l.sg(["--repo=second", "env"], { cwd: l.ws })).out).toContain("second.git");
	});

	it("is exit 2 with no match, an unknown --repo or a bad line", async () => {
		const l = await initialised();
		const elsewhere = tempDir("elsewhere");
		const none = await l.sg(["status"], { cwd: elsewhere });
		expect(none.code).toBe(2);
		expect(none.err).toContain("not in a registered workspace");
		expect((await l.sg(["--repo", "ghost", "status"])).code).toBe(2);
		writeFileSync(join(l.store, "registry"), "not a registry line\n");
		const bad = await l.sg(["list"]);
		expect(bad.code).toBe(2);
		expect(bad.err).toContain("registry:1");
	});

	it("matches a path only below a registered root, not a name that merely starts with it", async () => {
		const l = await initialised();
		const lookalike = `${l.ws}-copy`;
		mkdirSync(lookalike);
		expect((await l.sg(["status"], { cwd: lookalike })).code).toBe(2);
	});
});

describe("git version", () => {
	const fakeGit = (dir: string, name: string, version: string): string => {
		const file = join(dir, name);
		writeFileSync(
			file,
			`#!/bin/sh\nif [ "$1" = --version ]; then echo "git version ${version}"; exit 0; fi\nexec git "$@"\n`,
		);
		chmodSync(file, 0o755);
		return file;
	};

	it("is exit 2 below 2.20 and names XPI_SG_GIT", async () => {
		const l = await initialised();
		const old = fakeGit(l.adapters, "git-old", "2.19.9");
		const result = await l.sg(["status"], { env: { XPI_SG_GIT: old } });
		expect(result.code).toBe(2);
		expect(result.err).toContain("XPI_SG_GIT");
		expect(result.err).toContain("2.20");
	});

	it("accepts 2.20 and newer, and a vendor suffix", async () => {
		const l = await initialised();
		expect((await l.sg(["status"], { env: { XPI_SG_GIT: fakeGit(l.adapters, "git-min", "2.20.0") } })).code).toBe(0);
		expect(
			(await l.sg(["status"], { env: { XPI_SG_GIT: fakeGit(l.adapters, "git-apple", "2.39.3 (Apple Git-145)") } }))
				.code,
		).toBe(0);
	});

	it("is exit 2 when git cannot be run", async () => {
		const l = await initialised();
		const result = await l.sg(["status"], { env: { XPI_SG_GIT: join(l.adapters, "no-such-git") } });
		expect(result.code).toBe(2);
		expect(result.err).toContain("XPI_SG_GIT");
	});
});

describe("pass-through and blocked commands", () => {
	it("hands other commands to git on the shadow repo, with its exit code", async () => {
		const l = await initialised();
		write(l.ws, "new.txt", "new\n");
		expect((await l.sg(["add", "new.txt"])).code).toBe(0);
		expect((await l.sg(["commit", "-q", "-m", "add new"])).code).toBe(0);
		const log = await l.sg(["log", "--format=%s"]);
		expect(log.out).toBe("add new\nsg: baseline\n");
		const bad = await l.sg(["checkout", "no-such-branch"]);
		expect(bad.code).not.toBe(0);
		expect(bad.err).toContain("no-such-branch");
		// the state is in the store, so a git started from the workspace's own directory finds nothing
		const plain = spawnSync("git", ["rev-parse", "--git-dir"], { cwd: l.ws, encoding: "utf8", env: l.env });
		expect(plain.status).not.toBe(0);
	});

	it.each(["push", "fetch", "pull", "clone", "remote", "submodule"])("refuses %s with exit 2", async (command) => {
		const l = await initialised();
		const result = await l.sg([command, "x"]);
		expect(result.code).toBe(2);
		expect(result.err).toContain(`xpi sg ${command} is not available`);
		expect(result.err).toContain("local");
	});

	it("does not offer sandboxes yet", async () => {
		const l = await initialised();
		const result = await l.sg(["sbx", "ls"]);
		expect(result.code).toBe(2);
		expect(result.err).toContain("not available yet");
	});

	it("prints help, and exit 2 with no command", async () => {
		const l = lab();
		expect((await l.sg(["--help"])).out).toContain("Usage: xpi sg");
		expect((await l.sg([])).code).toBe(2);
		expect((await l.sg(["list", "extra"])).code).toBe(2);
	});
});

describe("status", () => {
	it("shows git status, the commits ahead of host and the adapter's summary", async () => {
		const l = await initialised();
		write(l.ws, "a.txt", "changed\n");
		await l.sg(["commit", "-q", "-a", "-m", "change a"]);
		const result = await l.sg(["status"]);
		expect(result.code).toBe(0);
		expect(result.out).toContain("main is 1 commit(s) ahead of host");
		expect(result.out).toContain("repo demo");
		expect(result.out).toContain("upstream");
	});
});

describe("adapters", () => {
	it("ship executable, with the plain adapter first in line after the configured directories", () => {
		for (const name of ["sg-adapter-plain", "sg-adapter-template"]) {
			expect(statSync(join(adaptersDir, name)).mode & 0o111).toBe(0o111);
			const syntax = spawnSync("sh", ["-n", join(adaptersDir, name)]);
			expect(syntax.status).toBe(0);
		}
		const tracked = spawnSync("git", ["ls-files", "-s", "--", "sg-adapter-plain", "sg-adapter-template"], {
			cwd: adaptersDir,
			encoding: "utf8",
		});
		// in a checkout the files carry mode 100755 in git; an unpacked tarball has no index to ask
		for (const line of tracked.stdout.split("\n").filter(Boolean)) expect(line.startsWith("100755")).toBe(true);
	});

	it("template: every op that needs a decision fails, and an unknown op is exit 2", () => {
		const run = (op: string) => spawnSync("sh", [join(adaptersDir, "sg-adapter-template"), op], { encoding: "utf8" });
		for (const op of ["metadata", "excludes", "prepare", "update", "checkin"]) {
			const result = run(op);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain(`op '${op}' is not implemented`);
		}
		expect(run("status").status).toBe(0);
		expect(run("frobnicate").status).toBe(2);
	});

	it("are found in XPI_SG_ADAPTER_PATH before the shipped ones", async () => {
		const l = lab();
		write(l.ws, "a.txt", "a\n");
		// an adapter named plain in the extra directory wins over the shipped one
		writeFileSync(join(l.adapters, "sg-adapter-plain"), "#!/bin/sh\necho custom-plain >&2\nexit 7\n");
		chmodSync(join(l.adapters, "sg-adapter-plain"), 0o755);
		const result = await l.sg(["init", "demo", "--adapter", "plain"]);
		expect(result.code).toBe(1);
		expect(result.err).toContain("custom-plain");
		expect(result.err).toContain("exit 7");
	});

	it("receive the workspace, scope and local-only globs, with the workspace as cwd", async () => {
		const l = lab();
		write(l.ws, "src/a.txt", "a\n");
		const log = join(l.store, "calls.log");
		mkdirSync(l.store, { recursive: true });
		writeFileSync(
			join(l.adapters, "sg-adapter-spy"),
			`#!/bin/sh\necho "$1|$(pwd)|$XPI_SG_WORKSPACE|$XPI_SG_SCOPE|$XPI_SG_LOCAL_ONLY|$GIT_DIR" >> "${log}"\ncase "$1" in metadata|excludes|prepare|update|checkin|status) exit 0;; esac\n`,
		);
		chmodSync(join(l.adapters, "sg-adapter-spy"), 0o755);
		const env = { GIT_DIR: "/should/not/leak" };
		const r = await l.sg(
			["init", "demo", "--adapter", "spy", "--scope", "src/", "--local-only", "AGENTS.md", ".pi/"],
			{ env },
		);
		expect(r.err).toBe("");
		expect(r.code).toBe(0);
		const lines = readFileSync(log, "utf8").trim().split("\n");
		expect(lines.map((line) => line.split("|")[0])).toEqual(["excludes", "metadata", "prepare"]);
		for (const line of lines) {
			expect(line.split("|").slice(1)).toEqual([l.ws, l.ws, "src/", "AGENTS.md .pi/", ""]);
		}
	});
});
