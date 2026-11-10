import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AssistantMessage, fauxAssistantMessage, type Message } from "xpi-ai";
import commitExtension from "../../src/extensions/commit/index.ts";
import type { ExtensionUIContext } from "../../src/index.ts";
import { createHarness, createTestUiContext, type Harness, type HarnessOptions } from "./harness.ts";

const RETRY = { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } };
const MODELS = { models: [{ id: "big" }, { id: "small" }] };

function answer(draft: Record<string, string>): AssistantMessage {
	return fauxAssistantMessage(JSON.stringify(draft));
}

function userText(messages: Message[]): string {
	return messages
		.filter((m) => m.role === "user")
		.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
		.join("\n");
}

describe("/commit", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	/** A harness whose cwd is a fresh git repo with one commit; the haiku alias points at a faux model. */
	async function setup(options: { ui?: Partial<ExtensionUIContext> | false; harness?: HarnessOptions } = {}) {
		const harness = await createHarness({
			...MODELS,
			...options.harness,
			settings: { ...RETRY, models: { haiku: "faux/small" }, ...options.harness?.settings },
			extensionFactories: [commitExtension],
		});
		harnesses.push(harness);
		const repo = harness.tempDir;
		const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
		git("init", "-q", "-b", "main");
		git("config", "user.name", "Test");
		git("config", "user.email", "test@example.com");
		git("config", "commit.gpgsign", "false");
		writeFileSync(join(repo, "a.txt"), "one\n");
		git("add", "a.txt");
		git("commit", "-q", "-m", "chore: initial");
		const notifications: string[] = [];
		if (options.ui !== false) {
			await harness.session.bindExtensions({
				uiContext: createTestUiContext({ notify: (m) => notifications.push(m), ...options.ui }),
			});
		}
		const run = (args = "") => harness.session.prompt(`/commit${args ? ` ${args}` : ""}`);
		const write = (name: string, text: string) => writeFileSync(join(repo, name), text);
		return { harness, repo, git, notifications, run, write };
	}

	it("proposes a message and commits it after the editor returns it unchanged", async () => {
		const { harness, git, notifications, run, write } = await setup({
			ui: { editor: async (_title, prefill) => prefill },
		});
		write("a.txt", "one\ntwo\n");
		git("add", "a.txt");
		harness.setResponses([answer({ type: "feat", scope: "core", summary: "add two", body: "Because." })]);

		await run();

		expect(git("log", "-1", "--format=%B").trim()).toBe("feat(core): add two\n\nBecause.");
		expect(git("status", "--porcelain")).toBe("");
		expect(notifications.some((n) => /committed [0-9a-f]+ feat\(core\): add two/.test(n))).toBe(true);
	});

	it("assembles type: summary without a scope, and the whole subject for type custom", async () => {
		const { harness, git, run, write } = await setup({ ui: { editor: async (_t, prefill) => prefill } });
		write("a.txt", "x\n");
		git("add", "a.txt");
		harness.setResponses([answer({ type: "fix", summary: "plain" })]);
		await run();
		expect(git("log", "-1", "--format=%s").trim()).toBe("fix: plain");

		write("a.txt", "y\n");
		git("add", "a.txt");
		harness.setResponses([answer({ type: "custom", summary: "Update a.txt (#12)" })]);
		await run();
		expect(git("log", "-1", "--format=%s").trim()).toBe("Update a.txt (#12)");
	});

	it("uses the edited message", async () => {
		const { harness, git, run, write } = await setup({ ui: { editor: async () => "docs: my own words\n" } });
		write("a.txt", "changed\n");
		git("add", "a.txt");
		harness.setResponses([answer({ type: "feat", summary: "proposal" })]);

		await run();

		expect(git("log", "-1", "--format=%s").trim()).toBe("docs: my own words");
	});

	it.each([
		["cancelled", undefined],
		["emptied", "  \n"],
	])("commits nothing when the editor is %s", async (_name, result) => {
		const { harness, git, run, write } = await setup({ ui: { editor: async () => result } });
		write("a.txt", "changed\n");
		git("add", "a.txt");
		harness.setResponses([answer({ type: "feat", summary: "proposal" })]);

		await run();

		expect(git("rev-list", "--count", "HEAD").trim()).toBe("1");
		expect(git("diff", "--cached", "--name-only").trim()).toBe("a.txt");
	});

	it("with nothing staged and the offer accepted, stages tracked changes but not untracked files", async () => {
		const confirms: string[] = [];
		const { harness, git, run, write } = await setup({
			ui: {
				confirm: async (title) => {
					confirms.push(title);
					return true;
				},
				editor: async (_t, prefill) => prefill,
			},
		});
		write("a.txt", "tracked change\n");
		write("new.txt", "untracked\n");
		harness.setResponses([answer({ type: "fix", summary: "tracked" })]);

		await run();

		expect(confirms).toHaveLength(1);
		expect(git("show", "--name-only", "--format=", "HEAD").trim()).toBe("a.txt");
		expect(git("status", "--porcelain").trim()).toBe("?? new.txt");
	});

	it("with nothing staged and the offer declined, commits nothing and does not call the model", async () => {
		const { harness, git, notifications, run, write } = await setup({ ui: { confirm: async () => false } });
		write("a.txt", "tracked change\n");
		harness.setResponses([answer({ type: "fix", summary: "never" })]);

		await run();

		expect(git("rev-list", "--count", "HEAD").trim()).toBe("1");
		expect(git("diff", "--cached", "--name-only").trim()).toBe("");
		expect(harness.faux.state.callCount).toBe(0);
		expect(notifications.some((n) => n.includes("nothing committed"))).toBe(true);
	});

	it("shows the output of a failing pre-commit hook and commits nothing", async () => {
		const { harness, repo, git, notifications, run, write } = await setup({
			ui: { editor: async (_t, prefill) => prefill },
		});
		mkdirSync(join(repo, ".git", "hooks"), { recursive: true });
		const hook = join(repo, ".git", "hooks", "pre-commit");
		writeFileSync(hook, "#!/bin/sh\necho 'HOOK SAYS NO' >&2\nexit 1\n");
		chmodSync(hook, 0o755);
		write("a.txt", "changed\n");
		git("add", "a.txt");
		harness.setResponses([answer({ type: "feat", summary: "blocked" })]);

		await run();

		expect(git("rev-list", "--count", "HEAD").trim()).toBe("1");
		expect(notifications.some((n) => n.includes("HOOK SAYS NO"))).toBe(true);
		// One model call: no retry after the hook failed.
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("caps a large diff, names the files left out, and sends lockfiles as stat only", async () => {
		const { harness, git, run, write } = await setup({ ui: { editor: async () => undefined } });
		write("big1.txt", `${"first-file-line\n".repeat(2500)}`);
		write("big2.txt", `${"second-file-line\n".repeat(2500)}`);
		write("package-lock.json", `${'{"lock-secret-entry": 1}\n'.repeat(20)}`);
		git("add", "big1.txt", "big2.txt", "package-lock.json");
		let prompt = "";
		harness.setResponses([
			(context) => {
				prompt = userText(context.messages);
				return answer({ type: "chore", summary: "big" });
			},
		]);

		await run();

		expect(prompt).toContain("first-file-line");
		expect(prompt).not.toContain("second-file-line");
		expect(prompt).toContain("omitted files, see the stat: big2.txt");
		expect(prompt.length).toBeLessThan(75_000);
		// The lockfile appears in the stat, its content never.
		expect(prompt).toContain("package-lock.json");
		expect(prompt).not.toContain("lock-secret-entry");
	});

	it("passes the hint, the repo's commit rules and the recent subjects to the model", async () => {
		const { harness, repo, git, run, write } = await setup({ ui: { editor: async () => undefined } });
		writeFileSync(
			join(repo, "AGENTS.md"),
			"# Rules\n\nBe nice.\n\n## Commit messages\n\nUse the ticket prefix PROJ-123 in every subject.\n\n## Other\n\nUnrelated text.\n",
		);
		git("add", "AGENTS.md");
		git("commit", "-q", "-m", "docs: add rules");
		write("a.txt", "changed\n");
		git("add", "a.txt");
		let prompt = "";
		let system = "";
		harness.setResponses([
			(context) => {
				prompt = userText(context.messages);
				system = JSON.stringify(context.messages.filter((m) => m.role === "system"));
				return answer({ type: "feat", summary: "x" });
			},
		]);

		await run("fixes #12");

		expect(prompt).toContain("Hint from the owner: fixes #12");
		expect(prompt).toContain("Use the ticket prefix PROJ-123");
		expect(prompt).not.toContain("Unrelated text");
		expect(prompt).toContain("docs: add rules");
		expect(prompt).toContain("chore: initial");
		expect(system).toContain("72 characters");
	});

	it("shows the error kind of a failed model call and commits nothing", async () => {
		const { harness, git, notifications, run, write } = await setup({
			ui: { editor: async (_t, prefill) => prefill },
			harness: { settings: { commit: { model: "no-such-model-anywhere" } } },
		});
		write("a.txt", "changed\n");
		git("add", "a.txt");
		harness.setResponses([answer({ type: "feat", summary: "never" })]);

		await run();

		expect(notifications.some((n) => n.includes("no_model"))).toBe(true);
		expect(git("rev-list", "--count", "HEAD").trim()).toBe("1");
	});

	it("uses the commit.model setting, resolved through the models setting", async () => {
		const { harness, git, run, write } = await setup({
			ui: { editor: async () => undefined },
			harness: { settings: { commit: { model: "cheap" }, models: { cheap: "faux/big", haiku: "faux/small" } } },
		});
		write("a.txt", "changed\n");
		git("add", "a.txt");
		harness.setResponses([answer({ type: "feat", summary: "x" })]);

		await run();

		const usage = harness.sessionManager.getEntries().flatMap((e) => (e.type === "usage" ? [e] : []));
		expect(usage.map((u) => [u.kind, u.model])).toEqual([["ext:commit", "big"]]);
	});

	it("defaults commit.model to the haiku alias", async () => {
		const { harness, git, run, write } = await setup({ ui: { editor: async () => undefined } });
		write("a.txt", "changed\n");
		git("add", "a.txt");
		harness.setResponses([answer({ type: "feat", summary: "x" })]);

		await run();

		const usage = harness.sessionManager.getEntries().flatMap((e) => (e.type === "usage" ? [e] : []));
		expect(usage.map((u) => u.model)).toEqual(["small"]);
	});

	describe("without a UI (print mode)", () => {
		it("prints the message and does not commit without --yes", async () => {
			const log = vi.spyOn(console, "log").mockImplementation(() => {});
			const { harness, git, run, write } = await setup({ ui: false });
			write("a.txt", "changed\n");
			git("add", "a.txt");
			harness.setResponses([answer({ type: "feat", summary: "print me" })]);

			await run();

			expect(log.mock.calls.flat().join("\n")).toContain("feat: print me");
			expect(git("rev-list", "--count", "HEAD").trim()).toBe("1");
		});

		it("commits with --yes and keeps the hint out of the --yes flag", async () => {
			vi.spyOn(console, "log").mockImplementation(() => {});
			const { harness, git, run, write } = await setup({ ui: false });
			write("a.txt", "changed\n");
			git("add", "a.txt");
			let prompt = "";
			harness.setResponses([
				(context) => {
					prompt = userText(context.messages);
					return answer({ type: "feat", summary: "yes" });
				},
			]);

			await run("--yes closes #3");

			expect(git("log", "-1", "--format=%s").trim()).toBe("feat: yes");
			expect(prompt).toContain("Hint from the owner: closes #3");
			expect(prompt).not.toContain("--yes closes");
		});

		it("with nothing staged, prints a message and stops", async () => {
			const log = vi.spyOn(console, "warn").mockImplementation(() => {});
			const err = vi.spyOn(console, "error").mockImplementation(() => {});
			const { harness, git, run, write } = await setup({ ui: false });
			write("a.txt", "changed\n");
			harness.setResponses([answer({ type: "feat", summary: "never" })]);

			await run("--yes");

			expect(err.mock.calls.flat().join("\n")).toContain("nothing is staged");
			expect(log).not.toHaveBeenCalled();
			expect(harness.faux.state.callCount).toBe(0);
			expect(git("rev-list", "--count", "HEAD").trim()).toBe("1");
			expect(existsSync(join(harness.tempDir, "a.txt"))).toBe(true);
			expect(readFileSync(join(harness.tempDir, "a.txt"), "utf8")).toBe("changed\n");
		});
	});
});
