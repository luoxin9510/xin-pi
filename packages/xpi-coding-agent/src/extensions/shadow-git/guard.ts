/**
 * What a bash command may not do in a shadow-git workspace. A guard rail for agents that are not trying to get around
 * it: the shell is not parsed, the command text is searched. It cannot stop a command that builds its text at run time.
 */

const ADAPTER = /sg-adapter-[\w.-]*/;
// `sg` as a word of its own (`xpi sg import`, a bare `sg import` through an alias), with what follows it up to the
// next separator.
const SG_SOURCE = /(?<![\w./-])sg\s+([^;&|\n()`]*)/.source;

const stripQuotes = (token: string): string => token.replace(/^["'$]+|["']+$/g, "");

function sgReason(args: string): string | undefined {
	const tokens = args.split(/\s+/).map(stripQuotes).filter(Boolean);
	if (tokens[0] === "--repo") tokens.splice(0, 2);
	else if (tokens[0]?.startsWith("--repo=")) tokens.shift();
	const [sub, ...rest] = tokens;
	if (sub === "import" || sub === "merge") return `xpi sg ${sub}`;
	if (sub === "export" && rest.includes("--apply")) return "xpi sg export --apply";
	if (sub === "sbx" && (rest[0] === "create" || rest[0] === "rm")) return `xpi sg sbx ${rest[0]}`;
	return undefined;
}

/** A one-line reason when `command` is blocked, else undefined. `patterns` are the repo's `shadow.blockCommand` regexes. */
export function blockReason(command: string, patterns: RegExp[]): string | undefined {
	// Matches overlap on purpose: in `xpi sg sbx run s -- xpi sg merge x` the inner `sg merge` is a command of its own.
	const sg = new RegExp(SG_SOURCE, "g");
	for (let match = sg.exec(command); match; match = sg.exec(command)) {
		sg.lastIndex = match.index + 1;
		const what = sgReason(match[1] ?? "");
		if (what) {
			return `shadow-git: agents do not run "${what}"; it changes the workspace or the host, so ask the user to run it`;
		}
	}
	const adapter = ADAPTER.exec(command);
	if (adapter) {
		return `shadow-git: agents do not run ${adapter[0]}; adapters talk to the host VCS, which is the user's to change`;
	}
	for (const pattern of patterns) {
		if (pattern.test(command)) {
			return `shadow-git: this command matches shadow.blockCommand ${pattern}; host VCS write commands are the user's`;
		}
	}
	return undefined;
}

/** The `shadow.blockCommand` values as regexes; an invalid one is returned in `invalid` instead. */
export function compilePatterns(values: string[]): { patterns: RegExp[]; invalid: string[] } {
	const patterns: RegExp[] = [];
	const invalid: string[] = [];
	for (const value of values) {
		try {
			patterns.push(new RegExp(value));
		} catch {
			invalid.push(value);
		}
	}
	return { patterns, invalid };
}
