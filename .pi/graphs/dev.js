// The development flow of this repository as a graph (docs: packages/xpi-coding-agent/docs/graph.md).
// Run it with `/graph start dev` and say what you want built.
//
// What the shape guarantees:
// - the spec node is entered only after you approved the grill, and the build node only after you approved the spec;
// - the build starts on a new branch made from main (the `branch` node makes it, and stops the graph on any other branch or a detached HEAD);
// - the merge is a command the graph runs itself, and it is reached only through a CI pass that came after the last
//   visit of build (`requires`).
//
// What it does not guarantee, only makes unlikely: that nothing is written before its node. `readOnly` stops the file
// tools, not a shell command; `deny` stops the commands that name main, not every way to push. Protect the main
// branch on GitHub as well.
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
			readOnly: [
				"packages/**",
				"scripts/**",
				"docs/**",
				".github/**",
				".pi/**",
				"package.json",
				"package-lock.json",
				"AGENTS.md",
				"README.md",
				"test.sh",
			],
		},
		// Never build on main: a plain `git push` there would skip everything after this node.
		// Only from main: on another branch, or a detached HEAD, the command fails, so no work lands on an old branch.
		branch: {
			run: 'b=$(git branch --show-current); if [ "$b" != main ]; then if [ -z "$b" ]; then echo "branch: HEAD is detached; run from main"; else echo "branch: current branch is \\"$b\\", not main; run from main"; fi; echo "then: git switch main, and /graph goto branch"; exit 1; fi; git switch -c "dev-$(date +%Y%m%d-%H%M%S)"',
		},
		build: {
			model: "anthropic/claude-haiku-5-5",
			prompt:
				"You are on a branch made for this work; stay on it and never switch to main. Build what the spec says, with tests and the docs the change touches. Run `npm run check` and the tests you changed or added. Commit, push with `git push -u origin HEAD` and open a pull request (or push to the one that is open). If you come back here from CI or from the review, fix what they report. Then move on: the graph waits for CI itself.",
			deny: [
				"gh pr merge",
				"git push origin main",
				"HEAD:main",
				"git push --force",
				"git push -f",
				"git switch main",
				"git checkout main",
				"--no-verify",
			],
		},
		// First the branch needs an open pull request: without one this fails at once. A push registers its checks a little later:
		// wait for the first one, then for all of them.
		ci: {
			run: 'pr=$(gh pr view --json number,state --jq \'select(.state=="OPEN").number\' 2>&1); st=$?; [ "$st" = 0 ] && [ -n "$pr" ] || { echo "ci: no open pull request for branch \\"$(git branch --show-current)\\""; echo "$pr"; exit 1; }; for i in $(seq 1 30); do [ -n "$(gh pr checks --json name --jq ".[].name" 2>/dev/null)" ] && break; sleep 10; done; gh pr checks --watch --fail-fast',
			timeout: "45m",
		},
		review: {
			model: "anthropic/claude-opus-5-5",
			prompt:
				"Have the pull request reviewed independently: start a subagent with the Agent tool, on an Opus model and with a fresh context, give it the PR number, the spec and AGENTS.md, not your own reasoning, and ask for findings as blocking, should-fix or nit, each with a concrete failure scenario. Do not review it yourself and do not change code. Post the review record as a PR comment. If nothing is blocking or should-fix, move on to the merge; otherwise send the findings back to build.",
			deny: ["gh pr merge", "git push"],
			readOnly: ["packages/**", "scripts/**", "docs/**", ".github/**", ".pi/**", "package.json", "package-lock.json"],
		},
		merge: { run: "gh pr merge --merge --delete-branch" },
	},
	edges: [
		{ from: "grill", to: "spec", exit: "approve", label: "the decisions are settled" },
		{ from: "spec", to: "branch", exit: "approve", label: "the spec is written" },
		{ from: "branch", to: "build", exit: "pass" },
		{ from: "build", to: "ci", exit: "model", label: "pushed, the pull request is open" },
		{ from: "ci", to: "review", exit: "pass" },
		{ from: "ci", to: "build", exit: "fail", max: 3 },
		{ from: "review", to: "merge", exit: "model", label: "nothing blocking or should-fix is left" },
		{ from: "review", to: "build", exit: "model", label: "findings to fix", max: 3 },
		{ from: "merge", to: "end", exit: "pass" },
	],
	requires: [{ before: "merge", passed: "ci", notAfter: ["build"] }],
};
