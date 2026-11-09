// The prompt /upstream injects into the main agent. Facts live in the data file; this only says what to do with them.

import type { GatherResult } from "./data.ts";

export const REPORT_SECTIONS = [
	"Upstream changes",
	"Conflicts with our changes",
	"Overlap with xin-pi built-ins",
	"Recommendations",
] as const;

export function buildPrompt(r: GatherResult): string {
	return `Compare upstream pi with xin-pi and write a report. xin-pi is an independent fork that no longer merges upstream; the question is what to port.

Data (${r.mode} mode${r.partial ? ", PARTIAL: say so in the report and keep confidence low" : ""}): ${r.dataPath}
Read it first. It holds the fork point, upstream commits since then, our diff stat, files changed on both sides, overlap candidates, and new upstream CHANGELOG entries. If it is large you may delegate parts of the reading with the Agent tool.

Write the report to ${r.reportPath} with exactly these four sections as "## " headings, in this order:
1. ## ${REPORT_SECTIONS[0]}: group them as Features, Fixes and Breaking.
2. ## ${REPORT_SECTIONS[1]}: upstream changes that touch files or behaviour xin-pi changed (the data file lists files changed on both sides).
3. ## ${REPORT_SECTIONS[2]}: compare upstream changes with xin-pi's built-ins (subagent, codemode background scripts, upstream) and say whether to take upstream's or keep ours.
4. ## ${REPORT_SECTIONS[3]}: one line per item: PORT (cherry-pick, then \`node scripts/xpi-rename.mjs <paths>\`, or rewrite), ADAPT, or SKIP, with a reason and a risk. Upstream paths \`packages/<x>\` are \`packages/xpi-<x>\` here; chord, durable, env and apps are removed.
End the report with a suggested next step, for example "port commits X and Y on a branch".

Read-only: do not edit any file except that report, do not merge, cherry-pick, fetch, or run git commands that change the checkout. When done, reply with a short summary and the report path.`;
}
