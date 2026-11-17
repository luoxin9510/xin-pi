// The literal of a graph file, as the tests share it: the dev flow of the spec (.scratch/xpi-graph/01-graph.md).

export interface RawGraph {
	name: string;
	start: string;
	nodes: Record<string, Record<string, unknown>>;
	edges: Record<string, unknown>[];
	requires?: Record<string, unknown>[];
}

/** A fresh copy each time, so a test can change it. */
export function devGraph(): RawGraph {
	return {
		name: "dev",
		start: "grill",
		nodes: {
			grill: { model: "anthropic/claude-opus-5-5", prompt: "Grill the request.", readOnly: ["**"] },
			build: {
				model: "anthropic/claude-haiku-5-5",
				prompt: "Build what the spec says.",
				deny: ["gh pr merge", "git push origin main"],
			},
			ci: { run: "gh pr checks --watch", timeout: "30m" },
			review: { prompt: "Have a fresh subagent review the change.", deny: ["gh pr merge"] },
			merge: { run: "gh pr merge --merge --delete-branch" },
		},
		edges: [
			{ from: "grill", to: "build", exit: "approve" },
			{ from: "build", to: "ci", exit: "model" },
			{ from: "ci", to: "review", exit: "pass" },
			{ from: "ci", to: "build", exit: "fail" },
			{ from: "review", to: "merge", exit: "model", label: "no findings" },
			{ from: "review", to: "build", exit: "model", label: "findings to fix", max: 2 },
			{ from: "merge", to: "end", exit: "pass" },
		],
		requires: [{ before: "merge", passed: "ci", notAfter: ["build"] }],
	};
}

/** The indexes of the dev graph's edges, by what they do. */
export const EDGE = { approve: 0, built: 1, ciPass: 2, ciFail: 3, reviewOk: 4, reviewFix: 5, merged: 6 };
