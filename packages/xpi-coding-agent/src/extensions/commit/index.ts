// commit extension entry: the `/commit [hint] [--yes]` command. It asks a small model for a commit message about the
// staged diff, lets the owner edit it, and runs `git commit`. Hooks are never skipped; nothing is amended or pushed.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Static, Type } from "typebox";
import type { ExtensionAPI, ExtensionCommandContext } from "../../core/extensions/types.ts";
import { SETTINGS_DEFAULTS } from "../../core/settings-defaults.ts";
import { CompleteError } from "../../core/side-call.ts";
import { assembleMessage, capDiff, extractCommitRules, LOCKFILE_EXCLUDES } from "./context.ts";

const CommitSchema = Type.Object({
	type: Type.String({
		description: 'Conventional commit type such as feat or fix; "custom" when the repo rules differ.',
	}),
	scope: Type.Optional(Type.String({ description: "Optional scope." })),
	summary: Type.String({ description: 'Subject text after the type; with type "custom" the whole subject line.' }),
	body: Type.Optional(Type.String({ description: "Optional body: why, not what." })),
});

const SYSTEM_PROMPT = [
	"You write one git commit message for the staged changes you are given.",
	"Use conventional commit style (type, optional scope, summary) unless the repository rules below say otherwise;",
	'then follow the rules, put the whole subject line in "summary" and use the type "custom".',
	"The subject is at most 72 characters, in the imperative mood or the convention of the recent commits.",
	"Add a body only when the why is not obvious from the subject; keep it short.",
	"Where the repository rules and these defaults differ, the repository rules win.",
	"No filler, no markdown, no mention that you are an assistant.",
].join("\n");

export interface ParsedArgs {
	hint: string;
	yes: boolean;
}

export function parseArgs(args: string): ParsedArgs {
	const words = args.split(/\s+/).filter((word) => word !== "");
	return { yes: words.includes("--yes"), hint: words.filter((word) => word !== "--yes").join(" ") };
}

export default function commit(pi: ExtensionAPI) {
	// Subagent children are workers: they never get the command.
	if (process.env.XPI_SUBAGENT_DEPTH) return;
	pi.registerCommand("commit", {
		description: "Draft a commit message for the staged changes and commit after you confirm it [hint] [--yes]",
		handler: async (args, ctx) => {
			await runCommit(pi, ctx, parseArgs(args));
		},
	});
}

async function runCommit(pi: ExtensionAPI, ctx: ExtensionCommandContext, { hint, yes }: ParsedArgs): Promise<void> {
	const say = (message: string, level: "info" | "warning" | "error" = "info") => {
		const text = `commit: ${message}`;
		if (ctx.hasUI) ctx.ui.notify(text, level);
		else if (level === "info") console.log(text);
		else console.error(text);
	};
	const git = (args: string[]) => pi.exec("git", args, { cwd: ctx.cwd });

	const top = await git(["rev-parse", "--show-toplevel"]);
	if (top.code !== 0) return say("not inside a git repository", "error");
	const root = top.stdout.trim();

	let staged = (await git(["diff", "--cached", "--name-only"])).stdout.trim();
	if (staged === "") {
		const tracked = (await git(["diff", "--name-only"])).stdout.trim();
		if (tracked === "") return say("nothing to commit", "warning");
		if (!ctx.hasUI) return say("nothing is staged; stage changes with git add, then run /commit again", "warning");
		const ok = await ctx.ui.confirm(
			"Nothing staged",
			"Stage all tracked changes (git add -u)? Untracked files are not added.",
		);
		if (!ok) return say("nothing staged, nothing committed", "warning");
		const add = await git(["add", "-u"]);
		if (add.code !== 0) return say(`git add -u failed: ${(add.stderr || add.stdout).trim()}`, "error");
		staged = (await git(["diff", "--cached", "--name-only"])).stdout.trim();
		if (staged === "") return say("nothing to commit", "warning");
	}

	const stat = (await git(["diff", "--cached", "--stat"])).stdout.trimEnd();
	const diff = (await git(["diff", "--cached", "--no-color", "--no-ext-diff", "--", ".", ...LOCKFILE_EXCLUDES]))
		.stdout;
	const capped = capDiff(diff);
	const recent = (await git(["log", "-20", "--format=%s"])).stdout.trim();
	const rules = await readRules(root);

	const sections = [
		hint ? `Hint from the owner: ${hint}` : undefined,
		rules ? `Commit rules of this repository:\n${rules}` : undefined,
		recent ? `Last 20 commit subjects:\n${recent}` : undefined,
		`Staged files (git diff --cached --stat; lockfile diffs are shown here only):\n${stat}`,
		capped.omitted.length > 0
			? `Diff text (cut at the size cap; omitted files, see the stat: ${capped.omitted.join(", ")}):\n${capped.text}`
			: `Diff text:\n${capped.text}`,
	];
	const prompt = sections.filter((section) => section !== undefined).join("\n\n");

	let message: string;
	try {
		const result = await ctx.complete<Static<typeof CommitSchema>>({
			model: pi.getSettings().commit?.model ?? SETTINGS_DEFAULTS.commit.model,
			prompt,
			systemPrompt: SYSTEM_PROMPT,
			schema: CommitSchema,
			purpose: "commit",
		});
		if (!result.value) return say("the model gave no message", "error");
		message = assembleMessage(result.value);
	} catch (error) {
		if (error instanceof CompleteError) return say(`${error.kind}: ${error.message}`, "error");
		throw error;
	}

	if (ctx.hasUI) {
		const edited = await ctx.ui.editor("Commit message", message);
		if (edited === undefined || edited.trim() === "") return say("cancelled, nothing committed", "warning");
		message = edited.trim();
	} else if (!yes) {
		console.log(message);
		return say("not committed; run /commit --yes to commit with this message");
	}

	const dir = await mkdtemp(join(tmpdir(), "xpi-commit-"));
	try {
		const file = join(dir, "COMMIT_MSG");
		await writeFile(file, `${message}\n`);
		const done = await git(["commit", "-F", file]);
		if (done.code !== 0) {
			const output = [done.stderr, done.stdout]
				.filter((part) => part.trim() !== "")
				.join("\n")
				.trim();
			return say(`git commit failed (exit ${done.code}):\n${output}`, "error");
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
	const hash = (await git(["rev-parse", "--short", "HEAD"])).stdout.trim();
	say(`committed ${hash} ${message.split("\n")[0]}`);
}

async function readRules(root: string): Promise<string | undefined> {
	for (const name of ["AGENTS.md", "CLAUDE.md"]) {
		try {
			const rules = extractCommitRules(await readFile(join(root, name), "utf8"));
			if (rules) return rules;
		} catch {
			// The file is absent: try the next one.
		}
	}
	return undefined;
}
