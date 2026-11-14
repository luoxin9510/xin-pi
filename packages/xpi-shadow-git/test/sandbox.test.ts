import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createContext, loadSandbox, namespaceScript, resolveRepo, sandboxPolicy } from "../src/index.ts";
import { cleanup, initialised, type Lab, read, write } from "./helpers.ts";

afterEach(cleanup);

// A program that does not exist: the namespace probe fails, as on a system without unshare.
const NO_UNSHARE = { XPI_SG_UNSHARE: "/nonexistent/unshare" };

const FILES = { "a.txt": "a\n", "src/b.txt": "b\n", "src/c.txt": "c\n" };

/** A lab with untracked files in the workspace and the policy backend. */
async function sandboxLab(rules: string[] = []): Promise<Lab> {
	const l = await initialised(FILES);
	write(l.ws, "vendor/lib/x.txt", "x\n");
	write(l.ws, "vendor/y.txt", "y\n");
	write(l.ws, "src/untracked.txt", "u\n");
	write(l.ws, "docs/guide.txt", "g\n");
	expect((await l.sg(["config", "sandbox.backend", "policy"])).code).toBe(0);
	for (const rule of rules) expect((await l.sg(["config", "--add", "sandbox.rule", rule])).code).toBe(0);
	return l;
}

const sbxDir = (l: Lab, id: string): string => join(realpathSync(l.store), "demo.sbx", id);

async function create(l: Lab, id = "a", extra: string[] = []) {
	const result = await l.sg(["sbx", "create", id, ...extra]);
	expect(result.err).toBe("");
	expect(result.code).toBe(0);
	return result;
}

function sandboxOf(l: Lab, id = "a") {
	const ctx = createContext({ cwd: l.ws, env: l.env });
	return loadSandbox(resolveRepo(ctx, undefined), id);
}

const treeGit = (l: Lab, id: string, ...args: string[]): string => {
	const sbx = sandboxOf(l, id);
	const result = spawnSync("git", args, {
		cwd: sbx.tree,
		encoding: "utf8",
		env: { ...l.env, GIT_DIR: sbx.gitDir, GIT_WORK_TREE: sbx.tree },
	});
	if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
	return result.stdout;
};

describe("create, ls and rm", () => {
	it("creates the worktree on sbx/<id>, scratch and primary, and lists it", async () => {
		const l = await sandboxLab();
		const made = await create(l);
		expect(made.out).toContain("created sandbox demo/a on sbx/a");
		const root = sbxDir(l, "a");
		expect(read(root, "tree/src/b.txt")).toBe("b\n");
		expect(existsSync(join(root, "scratch"))).toBe(true);
		expect(readlinkSync(join(root, "primary"))).toBe(l.ws);
		expect(l.git("rev-parse", "--verify", "sbx/a").trim()).toBe(l.git("rev-parse", "main").trim());
		// the worktree's git dir is named after the id
		expect(existsSync(join(l.store, "demo.git", "worktrees", "a"))).toBe(true);

		const listed = await l.sg(["sbx", "ls"]);
		expect(listed.code).toBe(0);
		expect(listed.out).toBe("a  sbx/a  0 commit(s) ahead of main  0 changed file(s)  backend policy\n");
		const status = await l.sg(["status"]);
		expect(status.out).toContain("sandboxes:\n  demo/a  sbx/a");
	});

	it("keeps the branch when the sandbox is removed, and refuses unsaved work without --force", async () => {
		const l = await sandboxLab();
		await create(l);
		writeFileSync(join(sbxDir(l, "a"), "tree", "a.txt"), "edited\n");
		const refused = await l.sg(["sbx", "rm", "a"]);
		expect(refused.code).toBe(2);
		expect(refused.err).toContain("uncommitted");
		expect(existsSync(sbxDir(l, "a"))).toBe(true);

		const removed = await l.sg(["sbx", "rm", "a", "--force"]);
		expect(removed.code).toBe(0);
		expect(existsSync(sbxDir(l, "a"))).toBe(false);
		expect(l.git("branch", "--list", "sbx/a")).toContain("sbx/a");
		expect(l.git("worktree", "list")).not.toContain("sbx");
		// the primary workspace was not touched, links or not
		expect(read(l.ws, "a.txt")).toBe("a\n");
		expect(existsSync(join(l.ws, "vendor/lib/x.txt"))).toBe(true);
		expect((await l.sg(["sbx", "ls"])).out).toBe("");
		// the id is not reusable while the branch exists
		expect((await l.sg(["sbx", "create", "a"])).code).toBe(2);
	});

	it("takes --from, and refuses a bad id, a duplicate and an unknown branch", async () => {
		const l = await sandboxLab();
		l.git("branch", "feature");
		await create(l, "b", ["--from", "feature"]);
		for (const bad of ["tree", "a/b", "-x", ".lock"]) expect((await l.sg(["sbx", "create", bad])).code).toBe(2);
		expect((await l.sg(["sbx", "create", "b"])).code).toBe(2);
		const missing = await l.sg(["sbx", "create", "c", "--from", "nope"]);
		expect(missing.code).toBe(2);
		expect(existsSync(sbxDir(l, "c"))).toBe(false);
	});

	it("is refused while an import is stopped (SG_IMPORT)", async () => {
		const l = await sandboxLab();
		writeFileSync(join(l.store, "demo.git", "SG_IMPORT"), `old ${l.git("rev-parse", "host").trim()}\n`);
		const result = await l.sg(["sbx", "create", "a"]);
		expect(result.code).toBe(2);
		expect(result.err).toContain("SG_IMPORT");
		expect(existsSync(sbxDir(l, "a"))).toBe(false);
	});
});

describe("the tree", () => {
	it("links untracked entries, one link for a directory with no tracked files, and keeps them out of status", async () => {
		const l = await sandboxLab();
		await create(l);
		const tree = join(sbxDir(l, "a"), "tree");
		const primary = join(sbxDir(l, "a"), "primary");
		// no tracked file below vendor/ or docs/: one link each
		expect(readlinkSync(join(tree, "vendor"))).toBe(join(primary, "vendor"));
		expect(readlinkSync(join(tree, "docs"))).toBe(join(primary, "docs"));
		// src/ has tracked files: a real directory, with a link for the untracked file in it
		expect(lstatSync(join(tree, "src")).isDirectory()).toBe(true);
		expect(readlinkSync(join(tree, "src/untracked.txt"))).toBe(join(primary, "src/untracked.txt"));
		// the tracked files are the sandbox's own copies, not links
		expect(lstatSync(join(tree, "a.txt")).isSymbolicLink()).toBe(false);
		// the host VCS's metadata is hidden by default: no link
		expect(existsSync(join(tree, ".plainvcs"))).toBe(false);
		// the links are not in the sandbox's status
		expect(treeGit(l, "a", "status", "--porcelain")).toBe("");
		expect(read(tree, "vendor/lib/x.txt")).toBe("x\n");
	});

	it("has the tree, not the workspace, as its work tree", async () => {
		const l = await sandboxLab();
		await create(l);
		const tree = join(sbxDir(l, "a"), "tree");
		const result = spawnSync("git", ["-C", tree, "rev-parse", "--show-toplevel"], { encoding: "utf8", env: l.env });
		expect(result.stdout.trim()).toBe(tree);
		expect(treeGit(l, "a", "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("sbx/a");
	});

	it("refreshes the links at run: a new primary file, a removed one", async () => {
		const l = await sandboxLab();
		await create(l);
		const tree = join(sbxDir(l, "a"), "tree");
		write(l.ws, "later.txt", "l\n");
		write(l.ws, "src/later2.txt", "l\n");
		expect(existsSync(join(tree, "later.txt"))).toBe(false);
		await l.sg(["sbx", "run", "a", "--", "true"]);
		expect(readFileSync(join(tree, "later.txt"), "utf8")).toBe("l\n");
		expect(readFileSync(join(tree, "src/later2.txt"), "utf8")).toBe("l\n");
		await import("node:fs").then((fs) => fs.rmSync(join(l.ws, "later.txt")));
		await l.sg(["sbx", "run", "a", "--", "true"]);
		expect(existsSync(join(tree, "later.txt"))).toBe(false);
		expect(treeGit(l, "a", "status", "--porcelain")).toBe("");
	});

	it("keeps an untracked file the agent made, and never turns its directory into a link", async () => {
		const l = await sandboxLab();
		await create(l);
		const tree = join(sbxDir(l, "a"), "tree");
		await import("node:fs").then((fs) => fs.rmSync(join(tree, "docs"))); // the agent replaces the link
		write(tree, "docs/mine.txt", "mine\n");
		await l.sg(["sbx", "run", "a", "--", "true"]);
		expect(lstatSync(join(tree, "docs")).isDirectory()).toBe(true);
		expect(read(tree, "docs/mine.txt")).toBe("mine\n");
		expect(readlinkSync(join(tree, "docs/guide.txt"))).toBe(join(sbxDir(l, "a"), "primary", "docs/guide.txt"));
		expect(treeGit(l, "a", "status", "--porcelain", "--untracked-files=all")).toBe("?? docs/mine.txt\n");
	});

	it("makes scratch links, hidden gaps and shared-rw links from the rules", async () => {
		const l = await sandboxLab([
			"scratch @ws/build",
			"scratch @ws/out/obj",
			"hidden @ws/docs",
			"shared-rw @ws/vendor/lib",
		]);
		write(l.ws, "out/keep.txt", "k\n");
		write(l.ws, "vendor/lib/z.txt", "z\n");
		await create(l);
		const root = sbxDir(l, "a");
		const tree = join(root, "tree");
		expect(readlinkSync(join(tree, "build"))).toBe(join(root, "scratch", "build"));
		expect(existsSync(join(root, "scratch", "build"))).toBe(true);
		// out/ has a rule below it: a real directory, its other entries linked
		expect(lstatSync(join(tree, "out")).isDirectory()).toBe(true);
		expect(readlinkSync(join(tree, "out/obj"))).toBe(join(root, "scratch", "out/obj"));
		expect(readlinkSync(join(tree, "out/keep.txt"))).toBe(join(root, "primary", "out/keep.txt"));
		expect(existsSync(join(tree, "docs"))).toBe(false);
		// vendor/ has a shared-rw path below it: real directory; the shared-rw path links to the workspace itself
		expect(lstatSync(join(tree, "vendor")).isDirectory()).toBe(true);
		expect(readlinkSync(join(tree, "vendor/lib"))).toBe(join(l.ws, "vendor/lib"));
		expect(readlinkSync(join(tree, "vendor/y.txt"))).toBe(join(root, "primary", "vendor/y.txt"));
		expect(treeGit(l, "a", "status", "--porcelain")).toBe("");
		expect(read(root, "policy")).toContain("rule = scratch @ws/build");
	});

	it("refuses a scratch, hidden or shared-rw rule over tracked files, and leaves nothing behind", async () => {
		for (const rule of ["scratch @ws/src", "hidden @ws/a.txt", "shared-rw @ws/src/b.txt", "scratch @ws/src/b.txt"]) {
			const l = await sandboxLab([rule]);
			const result = await l.sg(["sbx", "create", "a"]);
			expect(result.code, rule).toBe(2);
			expect(result.err).toContain("the shadow repo tracks");
			expect(existsSync(sbxDir(l, "a"))).toBe(false);
			expect(l.git("branch", "--list", "sbx/a")).toBe("");
		}
		// a read-only rule over tracked files is fine: the policy protects them
		const l = await sandboxLab(["shared-ro @ws/src"]);
		await create(l);
		expect(sandboxPolicy(sandboxOf(l), join(sbxDir(l, "a"), "tree/src/b.txt")).write).toBe(false);
	});

	it("reads the rules from --profile instead of the repo's", async () => {
		const l = await sandboxLab(["hidden @ws/docs"]);
		const profile = join(l.ws, "..", "profile.cfg");
		writeFileSync(profile, "[sandbox]\n\trule = scratch @ws/tmp\n");
		await create(l, "a", ["--profile", profile]);
		const tree = join(sbxDir(l, "a"), "tree");
		expect(readlinkSync(join(tree, "tmp"))).toBe(join(sbxDir(l, "a"), "scratch", "tmp"));
		expect(readlinkSync(join(tree, "docs"))).toBe(join(sbxDir(l, "a"), "primary", "docs")); // the repo's hidden rule is not used
		expect((await l.sg(["sbx", "create", "b", "--profile", "/nonexistent"])).code).toBe(2);
		expect(sandboxOf(l).rules).toEqual([{ mode: "scratch", ws: true, path: "tmp" }]);
	});

	it("rejects a bad rule", async () => {
		for (const rule of [
			"secret @ws/x",
			"hidden relative/path",
			"scratch /elsewhere/x",
			"hidden @ws/../x",
			"scratch @ws",
		]) {
			const l = await sandboxLab([rule]);
			expect((await l.sg(["sbx", "create", "a"])).code, rule).toBe(2);
		}
	});
});

describe("the path policy", () => {
	it("allows the sandbox's own copies and scratch, and denies the primary through links", async () => {
		const l = await sandboxLab([
			"scratch @ws/build",
			"hidden @ws/docs",
			"shared-rw @ws/vendor/lib",
			"shared-rw /elsewhere/cache",
			"shared-ro /elsewhere",
		]);
		await create(l);
		const sbx = sandboxOf(l);
		const at = (path: string) => sandboxPolicy(sbx, join(sbx.tree, path));

		expect(at("a.txt")).toMatchObject({ mode: "private", read: true, write: true });
		expect(at("src/new-file.txt")).toMatchObject({ mode: "private", write: true }); // new file in a real directory
		expect(at("brand-new/dir/file.txt")).toMatchObject({ mode: "private", write: true });
		expect(at("build/out.o")).toMatchObject({ mode: "scratch", write: true });

		// a write through a link into primary is a write to the primary file
		expect(at("vendor/y.txt")).toMatchObject({ mode: "shared-ro", read: true, write: false });
		expect(at("src/untracked.txt")).toMatchObject({ mode: "shared-ro", write: false });
		expect(at("vendor/new.txt")).toMatchObject({ mode: "private", write: true }); // vendor/ is a real directory of the sandbox
		expect(at("vendor/lib/x.txt")).toMatchObject({ mode: "shared-rw", write: true });
		expect(at("vendor/lib/new.txt")).toMatchObject({ mode: "shared-rw", write: true });

		// the primary itself, by its workspace path (the policy backend) and through the primary link
		expect(sandboxPolicy(sbx, join(l.ws, "a.txt"))).toMatchObject({ mode: "shared-ro", write: false });
		expect(sandboxPolicy(sbx, join(sbx.primary, "a.txt"))).toMatchObject({ mode: "shared-ro", write: false });
		expect(sandboxPolicy(sbx, join(l.ws, "docs/guide.txt"))).toMatchObject({
			mode: "hidden",
			read: false,
			write: false,
		});
		expect(sandboxPolicy(sbx, join(l.ws, ".plainvcs/version"))).toMatchObject({ mode: "hidden", read: false });
		// a rule for a scratch path does not make the primary's directory writable
		expect(sandboxPolicy(sbx, join(l.ws, "build/x"))).toMatchObject({ write: false });

		// paths outside the workspace: read-only unless a rule says so
		expect(sandboxPolicy(sbx, "/usr/bin/env")).toMatchObject({ mode: "shared-ro", write: false });
		expect(sandboxPolicy(sbx, "/elsewhere/cache/x")).toMatchObject({ mode: "shared-rw", write: true });
		expect(sandboxPolicy(sbx, "/elsewhere/other")).toMatchObject({ mode: "shared-ro", write: false });
	});

	it("follows a link whose target does not exist yet, and a new file under a linked directory", async () => {
		const l = await sandboxLab();
		await create(l);
		const sbx = sandboxOf(l);
		// docs/ is one link into primary: a new file in it is a new file in the primary
		expect(sandboxPolicy(sbx, join(sbx.tree, "docs/new.txt"))).toMatchObject({ mode: "shared-ro", write: false });
		// a dangling link is followed to where a write would land
		mkdirSync(join(sbx.tree, "src"), { recursive: true });
		await import("node:fs").then((fs) => fs.symlinkSync(join(l.ws, "not-yet.txt"), join(sbx.tree, "src/dangling")));
		expect(sandboxPolicy(sbx, join(sbx.tree, "src/dangling"))).toMatchObject({ write: false });
	});

	it("reads the namespace view: the workspace's own path is the tree", async () => {
		const l = await sandboxLab(["shared-rw @ws/vendor/lib"]);
		await create(l);
		const sbx = sandboxOf(l);
		expect(sandboxPolicy(sbx, join(l.ws, "a.txt"), "namespace")).toMatchObject({ mode: "private", write: true });
		expect(sandboxPolicy(sbx, join(l.ws, "vendor/lib/x.txt"), "namespace")).toMatchObject({
			mode: "shared-rw",
			write: true,
		});
		// (the namespace view of `primary` itself, a mount point, is covered by the namespace tests)
	});
});

describe("backends", () => {
	it("auto falls back to policy with a message when namespaces are not available", async () => {
		const l = await initialised(FILES);
		await l.sg(["config", "sandbox.backend", "auto"]);
		const made = await l.sg(["sbx", "create", "a"], { env: NO_UNSHARE });
		expect(made.code).toBe(0);
		expect(made.err).toContain("sandbox backend: policy (auto; namespace is not available:");
		const ran = await l.sg(["sbx", "run", "a", "--", "sh", "-c", "echo $XPI_SG_BACKEND"], { env: NO_UNSHARE });
		expect(ran.out).toBe("policy\n");
		expect(ran.err).toContain("sandbox backend: policy (auto;");
	});

	it("sandbox.require = namespace fails with exit 2 instead of falling back", async () => {
		const l = await initialised(FILES);
		await l.sg(["config", "sandbox.require", "namespace"]);
		const result = await l.sg(["sbx", "create", "a"], { env: NO_UNSHARE });
		expect(result.code).toBe(2);
		expect(result.err).toContain("the namespace sandbox backend is not available");
		expect(existsSync(sbxDir(l, "a"))).toBe(false);
		expect(l.git("branch", "--list", "sbx/a")).toBe("");
		// a policy backend and a require conflict
		await l.sg(["config", "sandbox.backend", "policy"]);
		expect((await l.sg(["sbx", "create", "a"], { env: NO_UNSHARE })).err).toContain("sandbox.backend = policy");
	});

	it("sandbox.backend = namespace fails the same way, and a bad value is exit 2", async () => {
		const l = await initialised(FILES);
		await l.sg(["config", "sandbox.backend", "namespace"]);
		expect((await l.sg(["sbx", "create", "a"], { env: NO_UNSHARE })).code).toBe(2);
		await l.sg(["config", "sandbox.backend", "bogus"]);
		expect((await l.sg(["sbx", "create", "a"])).err).toContain("sandbox.backend");
	});

	it("builds the namespace script in the spec's mount order", async () => {
		const l = await sandboxLab([
			"hidden @ws/docs",
			"shared-rw @ws/vendor/lib",
			"shared-ro /elsewhere",
			"hidden /elsewhere/secret",
		]);
		write(l.ws, "key.txt", "k\n");
		await l.sg(["config", "--add", "sandbox.rule", "hidden @ws/key.txt"]);
		await create(l);
		const sbx = sandboxOf(l);
		const script = namespaceScript(sbx);
		const at = (needle: string): number => {
			const found = script.indexOf(needle);
			expect(found, needle).toBeGreaterThan(-1);
			return found;
		};
		const order = [
			`mount --rbind '${l.ws}' '${sbx.primary}'`,
			`ro_remount '${sbx.primary}'`,
			`mount -t tmpfs -o ro,mode=0555 tmpfs '${sbx.primary}/docs'`,
			`mount --bind /dev/null '${join(sbxDir(l, "a"), "primary")}/key.txt'`,
		];
		expect(at(order[0])).toBeLessThan(at(order[1]));
		expect(at(order[1])).toBeLessThan(at(order[2]));
		expect(at(order[2])).toBeLessThan(at(order[3]));
		// hidden metadata inside primary, then shared-rw, then the tree over the workspace
		expect(at(`'${sbx.primary}/.plainvcs'`)).toBeLessThan(
			at(`mount --rbind '${l.ws}/vendor/lib' '${sbx.tree}/vendor/lib'`),
		);
		expect(at(`mount --rbind '${l.ws}/vendor/lib'`)).toBeLessThan(at(`mount --rbind '${sbx.tree}' '${l.ws}'`));
		expect(script).not.toContain("/elsewhere"); // the paths do not exist here: no mount for them
		expect(script).toContain("findmnt -no OPTIONS");
		expect(script.endsWith(`cd '${l.ws}'\nexec "$@"\n`)).toBe(true);
	});
});

describe("sbx run", () => {
	it("sets the sandbox environment, replacing what the parent passed down", async () => {
		const l = await sandboxLab();
		await create(l);
		const ran = await l.sg(
			[
				"sbx",
				"run",
				"a",
				"--",
				"sh",
				"-c",
				'echo "$XPI_SG_SANDBOX|$GIT_DIR|$GIT_WORK_TREE|$GIT_INDEX_FILE|$(pwd -P)"',
			],
			{
				env: { GIT_DIR: "/bogus/git", GIT_WORK_TREE: "/bogus/tree", GIT_INDEX_FILE: "/bogus/index", ...NO_UNSHARE },
			},
		);
		expect(ran.code).toBe(0);
		const tree = join(sbxDir(l, "a"), "tree");
		expect(ran.out).toBe(`demo/a|${join(realpathSync(l.store), "demo.git", "worktrees", "a")}|${tree}||${tree}\n`);
	});

	it("commits on sbx/<id> without touching main or the primary workspace", async () => {
		const l = await sandboxLab();
		await create(l);
		const ran = await l.sg([
			"sbx",
			"run",
			"a",
			"--",
			"sh",
			"-c",
			"echo new > added.txt && git add added.txt && git commit -qm 'add' && git status --porcelain && git rev-parse --abbrev-ref HEAD",
		]);
		expect(ran.err).toBe("");
		expect(ran.out).toBe("sbx/a\n");
		expect(l.git("log", "--format=%s", "main..sbx/a").trim()).toBe("add");
		expect(l.git("rev-parse", "main").trim()).toBe(l.git("rev-parse", "host").trim());
		expect(existsSync(join(l.ws, "added.txt"))).toBe(false);
		expect(l.git("status", "--porcelain")).toContain("vendor"); // primary: untracked vendor/ (not ignored), as before
		expect((await l.sg(["sbx", "ls"])).out).toContain("1 commit(s) ahead of main  0 changed file(s)");
	});

	it("returns the command's exit code, and refuses without a command or an unknown sandbox", async () => {
		const l = await sandboxLab();
		await create(l);
		expect((await l.sg(["sbx", "run", "a", "--", "sh", "-c", "exit 7"])).code).toBe(7);
		expect((await l.sg(["sbx", "run", "a"])).code).toBe(2);
		expect((await l.sg(["sbx", "run", "a", "--"])).code).toBe(2);
		expect((await l.sg(["sbx", "run", "nope", "--", "true"])).code).toBe(2);
		expect((await l.sg(["sbx", "run", "a", "--", "/nonexistent/prog"])).code).toBe(1);
	});

	it("inside a sandbox, git is the sandbox's, the primary-writing commands are refused and sandboxes do not nest", async () => {
		const l = await sandboxLab();
		await create(l);
		const tree = join(sbxDir(l, "a"), "tree");
		const inside = { cwd: tree, env: { XPI_SG_SANDBOX: "demo/a", XPI_SG_BACKEND: "policy" } };
		const top = await l.sg(["rev-parse", "--show-toplevel"], inside);
		expect(top.out.trim()).toBe(tree);
		expect((await l.sg(["rev-parse", "--abbrev-ref", "HEAD"], inside)).out.trim()).toBe("sbx/a");
		for (const args of [
			["import"],
			["merge", "main"],
			["export", "--apply"],
			["sbx", "create", "b"],
			["sbx", "rm", "a"],
			["sbx", "run", "a", "--", "true"],
		]) {
			const result = await l.sg(args, inside);
			expect(result.code, args.join(" ")).toBe(2);
			expect(result.err).toMatch(/inside a sandbox|do not nest/);
		}
		expect((await l.sg(["status"], inside)).code).toBe(0);
		expect((await l.sg(["sbx", "ls"], inside)).code).toBe(0);
	});
});
