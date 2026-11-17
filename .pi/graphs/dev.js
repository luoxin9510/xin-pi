// The development flow of this repository as a graph (docs: packages/xpi-coding-agent/docs/graph.md).
// Run it with `/graph start dev` and say what you want built.
//
// What the shape guarantees: a spec is written only after you approved the grill, code is written only after you
// approved the spec, and the merge is a command the graph runs itself, reachable only through a CI pass that came
// after the last change (`requires`). The model nodes may not run the merge or push to main.
export default {
	name: "dev",
	start: "grill",
	nodes: {
		grill: {
			model: "anthropic/claude-opus-5-5",
			prompt:
				"Grill the user's request until you both understand it: ask about every decision that is open, in rounds, each question with your recommended answer. Look facts up in the code yourself; put only decisions to the user. Do not write code or a spec. When nothing is open any more, sum up the decisions and ask to move on.",
			readOnly: ["**"],
		},
		spec: {
			model: "anthropic/claude-opus-5-5",
			prompt:
				"Write the spec and its tickets under .scratch/<topic>/ from the decisions of the grill, as AGENTS.md and the specs already in .scratch/ show. Change nothing outside .scratch/. When the spec is written, sum it up for the user and ask to move on.",
			readOnly: ["packages/**", "scripts/**", "docs/**", ".github/**"],
		},
		build: {
			model: "anthropic/claude-haiku-5-5",
			prompt:
				"Build what the spec says, on a branch of your own, with tests and the docs the change touches. Run `npm run check` and the tests you changed or added. Commit, push the branch and open a pull request (or push to the one that is open). If you come back here from CI or from the review, fix what they report. Then move on: the graph waits for CI itself.",
			deny: ["gh pr merge", "git push origin main", "git push origin HEAD:main", "--no-verify"],
		},
		ci: { run: "gh pr checks --watch --fail-fast", timeout: "45m" },
		review: {
			model: "anthropic/claude-opus-5-5",
			prompt:
				"Have the pull request reviewed independently: start a subagent with the Agent tool, on an Opus model and with a fresh context, give it the PR number, the spec and AGENTS.md, not your own reasoning, and ask for findings as blocking, should-fix or nit, each with a concrete failure scenario. Do not review it yourself and do not change code. Post the review record as a PR comment. If nothing is blocking or should-fix, move on to the merge; otherwise send the findings back to build.",
			deny: ["gh pr merge", "git push"],
			readOnly: ["packages/**", "scripts/**", "docs/**", ".github/**"],
		},
		merge: { run: "gh pr merge --merge --delete-branch" },
	},
	edges: [
		{ from: "grill", to: "spec", exit: "approve", label: "the decisions are settled" },
		{ from: "spec", to: "build", exit: "approve", label: "the spec is written" },
		{ from: "build", to: "ci", exit: "model", label: "pushed, the pull request is open" },
		{ from: "ci", to: "review", exit: "pass" },
		{ from: "ci", to: "build", exit: "fail", max: 3 },
		{ from: "review", to: "merge", exit: "model", label: "nothing blocking or should-fix is left" },
		{ from: "review", to: "build", exit: "model", label: "findings to fix", max: 3 },
		{ from: "merge", to: "end", exit: "pass" },
	],
	requires: [{ before: "merge", passed: "ci", notAfter: ["build"] }],
};
