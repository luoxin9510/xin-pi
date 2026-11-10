// Prompt pieces of /commit: the capped diff, the repo's commit rules, the message assembled from the model's answer.

/** Files whose diff is never sent: only their line in `git diff --cached --stat` is. */
const LOCKFILES = [
	"package-lock.json",
	"npm-shrinkwrap.json",
	"pnpm-lock.yaml",
	"yarn.lock",
	"bun.lock",
	"bun.lockb",
	"Cargo.lock",
	"Gemfile.lock",
	"poetry.lock",
	"uv.lock",
	"Pipfile.lock",
	"composer.lock",
	"go.sum",
	"flake.lock",
	"gradle.lockfile",
	"Podfile.lock",
	"pubspec.lock",
	"packages.lock.json",
];

/** Git pathspecs that leave the lockfiles out of a diff. */
export const LOCKFILE_EXCLUDES = LOCKFILES.map((name) => `:(exclude,glob)**/${name}`);

/** The most diff text sent to the model, in characters. */
export const DIFF_CHAR_CAP = 60_000;

/** The most repo-rules text sent to the model, in characters. */
export const RULES_CHAR_CAP = 4_000;

export interface CappedDiff {
	text: string;
	/** Files whose diff was left out because of the cap. */
	omitted: string[];
}

/**
 * Keep whole per-file diffs until the cap is reached. The first file is cut instead of dropped, so the model always
 * sees some diff. Dropped files are named; their stat is in the prompt anyway.
 */
export function capDiff(diff: string, cap: number = DIFF_CHAR_CAP): CappedDiff {
	const chunks = diff.split(/^(?=diff --git )/m).filter((chunk) => chunk.length > 0);
	let text = "";
	const omitted: string[] = [];
	for (const chunk of chunks) {
		if (omitted.length === 0 && text.length + chunk.length <= cap) {
			text += chunk;
			continue;
		}
		if (text === "" && omitted.length === 0) {
			text = `${chunk.slice(0, cap)}\n[diff of this file cut at ${cap} characters]\n`;
			continue;
		}
		const header = /^diff --git a\/(.*) b\/(.*)$/m.exec(chunk);
		omitted.push(header?.[2] ?? "(unknown file)");
	}
	return { text, omitted };
}

/**
 * The commit rules of a repo: the sections of AGENTS.md or CLAUDE.md whose heading mentions "commit". When no heading
 * does, the paragraphs that mention "commit". Undefined when nothing does. Capped at {@link RULES_CHAR_CAP}.
 */
export function extractCommitRules(markdown: string): string | undefined {
	const lines = markdown.split("\n");
	const sections: string[] = [];
	let i = 0;
	while (i < lines.length) {
		const heading = /^(#{1,6})\s+(.*)$/.exec(lines[i]);
		if (heading && /commit/i.test(heading[2])) {
			const level = heading[1].length;
			let end = i + 1;
			while (end < lines.length) {
				const next = /^(#{1,6})\s/.exec(lines[end]);
				if (next && next[1].length <= level) break;
				end++;
			}
			sections.push(lines.slice(i, end).join("\n").trim());
			i = end;
		} else {
			i++;
		}
	}
	let rules = sections.join("\n\n");
	if (rules === "") {
		rules = markdown
			.split(/\n\s*\n/)
			.filter((paragraph) => /commit/i.test(paragraph))
			.map((paragraph) => paragraph.trim())
			.join("\n\n");
	}
	if (rules === "") return undefined;
	return rules.length > RULES_CHAR_CAP ? `${rules.slice(0, RULES_CHAR_CAP)}\n[rules cut]` : rules;
}

export interface CommitDraft {
	type: string;
	scope?: string;
	summary: string;
	body?: string;
}

/** `type(scope): summary`, `type: summary`, or just `summary` for type "custom"; the body after a blank line. */
export function assembleMessage(draft: CommitDraft): string {
	const summary = draft.summary.trim();
	const type = draft.type.trim();
	const scope = draft.scope?.trim();
	const subject = type === "custom" ? summary : scope ? `${type}(${scope}): ${summary}` : `${type}: ${summary}`;
	const body = draft.body?.trim();
	return body ? `${subject}\n\n${body}` : subject;
}
