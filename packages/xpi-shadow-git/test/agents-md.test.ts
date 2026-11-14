import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AGENTS_MD_TEMPLATE } from "../src/agents-md.ts";
import { cleanup, initialised, lab, read, write } from "./helpers.ts";

afterEach(cleanup);

describe("AGENTS.md template", () => {
	it("init --agents-md writes the template, makes it local-only and commits it on main only", async () => {
		const l = await initialised(undefined, ["--agents-md"]);
		expect(read(l.ws, "AGENTS.md")).toBe(AGENTS_MD_TEMPLATE);
		expect(l.git("config", "--get-all", "shadow.localOnly").split("\n")).toContain("AGENTS.md");
		expect(l.git("ls-tree", "--name-only", "main").split("\n")).toContain("AGENTS.md");
		// host stays the host's state
		expect(l.git("ls-tree", "--name-only", "host").split("\n")).not.toContain("AGENTS.md");
		expect(l.git("log", "-1", "--format=%s", "main").trim()).toBe("sg: add AGENTS.md (local-only)");
		// clean, and nothing to export: the file is local-only
		expect(l.git("status", "--porcelain")).toBe("");
		const plan = await l.sg(["export"]);
		expect(plan.code).toBe(0);
		expect(plan.out).not.toContain("AGENTS.md");
		expect(plan.out).toContain("0 path(s) from 0 commit(s)");
		const applied = await l.sg(["export", "--apply"]);
		expect(applied.code).toBe(0);
		expect(existsSync(join(l.upstream, "AGENTS.md"))).toBe(false);
	});

	it("a commit that only touches local-only paths stays out of the check-in message", async () => {
		const l = await initialised(undefined, ["--local-only", "notes/"]);
		write(l.ws, "notes/todo.md", "x\n");
		await l.sg(["add", "-A"]);
		await l.sg(["commit", "-q", "-m", "my notes"]);
		write(l.ws, "a.txt", "changed\n");
		await l.sg(["commit", "-qam", "Fix the greeting"]);
		const plan = await l.sg(["export"]);
		expect(plan.out).toContain("1 path(s) from 1 commit(s)");
		expect(plan.out).toContain("Fix the greeting");
		expect(plan.out).not.toContain("my notes");
	});

	it("init --agents-md works when AGENTS.md is ignored, and a failed init leaves no AGENTS.md behind", async () => {
		const l = lab();
		write(l.ws, ".gitignore", "AGENTS.md\n");
		write(l.ws, ".plainvcs/version", "1\n");
		const base = ["init", "demo", "--adapter", "plain", "--config", `shadow.plain.upstream=${l.upstream}`];
		// ignored: still committed (git add -f)
		const ok = await l.sg([...base, "--agents-md"]);
		expect(ok.err).toBe("");
		expect(ok.code).toBe(0);
		expect(l.git("ls-tree", "--name-only", "main").split("\n")).toContain("AGENTS.md");

		// a failure after the file is written (the registry cannot be appended to) rolls it back
		const m = lab("other");
		write(m.ws, ".plainvcs/version", "1\n");
		write(m.store, "registry", "");
		chmodSync(join(m.store, "registry"), 0o444);
		const args = [
			"init",
			"other",
			"--adapter",
			"plain",
			"--config",
			`shadow.plain.upstream=${m.upstream}`,
			"--agents-md",
		];
		// the store's own I/O error surfaces as a thrown error, not an exit code
		await expect(m.sg(args)).rejects.toThrow(/EACCES/);
		expect(existsSync(join(m.ws, "AGENTS.md"))).toBe(false);
		expect(existsSync(join(m.store, "other.git"))).toBe(false);
		// and a second try is not refused for an AGENTS.md left over
		chmodSync(join(m.store, "registry"), 0o644);
		expect((await m.sg(args)).code).toBe(0);
	});

	it("a merged branch that only changed local-only paths adds no subject to the check-in message", async () => {
		const l = await initialised(undefined, ["--local-only", "notes/"]);
		await l.sg(["checkout", "-q", "-b", "side"]);
		write(l.ws, "notes/side.md", "n\n");
		await l.sg(["add", "-A"]);
		await l.sg(["commit", "-q", "-m", "Side notes"]);
		await l.sg(["checkout", "-q", "main"]);
		write(l.ws, "a.txt", "changed\n");
		await l.sg(["commit", "-qam", "Fix the greeting"]);
		l.git("merge", "-q", "--no-ff", "-m", "Merge side", "side");
		const plan = await l.sg(["export"]);
		expect(plan.code).toBe(0);
		expect(plan.out).toContain("Fix the greeting");
		expect(plan.out).not.toContain("Side notes");
		expect(plan.out).not.toContain("Merge side");
	});

	it("does not add AGENTS.md to local-only twice", async () => {
		const l = await initialised(undefined, ["--local-only", "AGENTS.md", "notes/", "--agents-md"]);
		const globs = l.git("config", "--get-all", "shadow.localOnly").trim().split("\n");
		expect(globs.filter((g) => g === "AGENTS.md")).toHaveLength(1);
		expect(globs).toContain("notes/");
	});

	it("init --agents-md refuses an existing AGENTS.md and registers nothing", async () => {
		const l = lab();
		write(l.ws, "AGENTS.md", "mine\n");
		write(l.ws, ".plainvcs/version", "1\n");
		const result = await l.sg([
			"init",
			"demo",
			"--adapter",
			"plain",
			"--config",
			`shadow.plain.upstream=${l.upstream}`,
			"--agents-md",
		]);
		expect(result.code).toBe(2);
		expect(result.err).toContain("xpi sg agents-md");
		expect(read(l.ws, "AGENTS.md")).toBe("mine\n");
		expect(existsSync(join(l.store, "demo.git"))).toBe(false);
	});

	it("without --agents-md nothing is written", async () => {
		const l = await initialised();
		expect(existsSync(join(l.ws, "AGENTS.md"))).toBe(false);
	});

	it("agents-md prints the template and needs no registered workspace", async () => {
		const l = lab();
		const result = await l.sg(["agents-md"]);
		expect(result.code).toBe(0);
		expect(result.out).toBe(AGENTS_MD_TEMPLATE);
	});

	it("the template says what the prompt does not: commit subjects, scratch output, sandbox branch", () => {
		expect(AGENTS_MD_TEMPLATE).toContain("check-in message");
		expect(AGENTS_MD_TEMPLATE).toContain("scratch");
		expect(AGENTS_MD_TEMPLATE).toContain("sbx/<id>");
		expect(AGENTS_MD_TEMPLATE).toContain("shadow.blockCommand");
		// always `xpi sg`, never a bare `sg <command>`
		expect(AGENTS_MD_TEMPLATE).not.toMatch(/(?<!xpi )\bsg (import|merge|export|env)/);
	});
});
