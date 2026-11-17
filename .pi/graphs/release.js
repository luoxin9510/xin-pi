// The release flow of this repository up to the tag, as a graph (the steps are those of .pi/skills/release.md;
// docs: packages/xpi-coding-agent/docs/graph.md). Run it with `/graph start release` on an up-to-date main with a
// clean tree.
//
// What the shape guarantees: the version bump, the merge and the tag are commands the graph runs itself; the bump
// needs your approval of patch or minor, the merge a CI pass that came after the last fix and your approval, and
// the tag comes only after the merge. npm is not part of it: the owner publishes by hand.
//
// A graph has no variables, so "patch or minor" is two command nodes and the plan node picks one.
export default {
	name: "release",
	start: "plan",
	nodes: {
		plan: {
			model: "anthropic/claude-opus-5-5",
			prompt:
				"Prepare a release. Check that the tree is clean and main is up to date with origin/main, and stop if not. List the pull requests merged since the last tag (`git describe --tags --abbrev=0`, `gh pr list --state merged`). Say whether this is a patch release (fixes and additions) or a minor one (breaking changes), with the reason, and ask to move on to that one.",
			readOnly: ["**"],
			deny: ["npm publish", "git tag", "git push", "release:tag"],
		},
		patch: { run: "npm run release:patch", timeout: "20m" },
		minor: { run: "npm run release:minor", timeout: "20m" },
		ci: { run: "gh pr checks --watch --fail-fast", timeout: "45m" },
		fix: {
			model: "anthropic/claude-haiku-5-5",
			prompt:
				"A step of the release failed; its output is above. Find the cause. If it is in the release branch (a lockfile, a generated file), fix it there, commit and push. Do not change versions by hand and do not touch main. If it cannot be fixed on the branch, say so and end your turn.",
			deny: ["npm publish", "git tag", "gh pr merge", "git push origin main", "release:tag"],
		},
		review: {
			model: "anthropic/claude-opus-5-5",
			prompt:
				"Have the release pull request reviewed independently: start a subagent with the Agent tool, on an Opus model and with a fresh context, give it the PR number and AGENTS.md, and ask it to check the version of every package and the lockfile diff. Do not review it yourself. Post the review record as a PR comment. If nothing is blocking, ask to move on to the merge; otherwise send the findings to fix.",
			deny: ["npm publish", "git tag", "gh pr merge", "git push", "release:tag"],
			readOnly: ["**"],
		},
		merge: { run: "gh pr merge --merge --delete-branch" },
		sync: { run: "git checkout main && git pull --ff-only" },
		"main-ci": { run: "gh run watch --exit-status $(gh run list --branch main --limit 1 --json databaseId --jq '.[0].databaseId')", timeout: "45m" },
		tag: { run: "npm run release:tag" },
		done: {
			model: "anthropic/claude-haiku-5-5",
			prompt:
				"The tag is pushed. Tell the user the version, that the release workflow now builds the GitHub Release (`gh run list --workflow release.yml`), and the two commands they run themselves to publish to npm: `npm run xpi:pack` and `npm publish ./dist-pack/xpi-coding-agent-<version>.tgz --access public`. Do not run them.",
			deny: ["npm publish"],
			readOnly: ["**"],
		},
	},
	edges: [
		{ from: "plan", to: "patch", exit: "approve", label: "a patch release: fixes and additions" },
		{ from: "plan", to: "minor", exit: "approve", label: "a minor release: breaking changes" },
		{ from: "patch", to: "ci", exit: "pass" },
		{ from: "minor", to: "ci", exit: "pass" },
		{ from: "ci", to: "review", exit: "pass" },
		{ from: "ci", to: "fix", exit: "fail", max: 2 },
		{ from: "fix", to: "ci", exit: "model", label: "fixed and pushed" },
		{ from: "review", to: "merge", exit: "approve", label: "nothing blocking is left" },
		{ from: "review", to: "fix", exit: "model", label: "findings to fix", max: 2 },
		{ from: "merge", to: "sync", exit: "pass" },
		{ from: "sync", to: "main-ci", exit: "pass" },
		{ from: "main-ci", to: "tag", exit: "pass" },
		{ from: "tag", to: "done", exit: "pass" },
		{ from: "done", to: "end", exit: "model", label: "the user is told" },
	],
	requires: [
		{ before: "merge", passed: "ci", notAfter: ["fix"] },
		{ before: "tag", passed: "merge" },
		{ before: "tag", passed: "main-ci" },
	],
};
