# 01: `/review` built-in workflow

Status: draft, waiting for Grill 1 (`decisions.md`). No code until the owner approves.

Origin: omp's `/review` (a command that builds a prompt; the main agent spawns 1-16 read-only `reviewer` subagents by
diff size; findings carry priority, confidence and a line range) and Claude Code's code review (parallel reviewers,
then a verification pass that drops what it cannot confirm).

## Problem Statement

Reviewing local changes before a commit or PR takes a hand-written prompt each time (this repo keeps one in
`.pi/prompts/pr.md`). The model reviews in the main context, so a large diff fills it, one pass misses things, and the
answer has no fixed shape to act on ("fix 2 and 4").

## Solution

A built-in saved workflow `review.js`, shipped with xpi like the built-in `Explore` and `Plan` agents and run as
`/review [target]` on the existing workflow engine (`agent()`, `parallel()`, `schema`, the `/workflows` panel), with
no model turn in the main session. Nothing new is built for running it; the subagent extension only learns to find
built-in workflows.

1. The script works out the diff for the target, drops files nobody reviews (lockfiles, generated, minified, `dist/`,
   binaries) and lists them separately.
2. It splits the remaining files into groups (same directory together, tests with their code) and runs one `reviewer`
   agent per group in parallel; the number of groups grows with the diff size.
3. Each reviewer returns findings through a schema.
4. One verifier agent gets all findings, re-checks each against the code, merges duplicates, drops what it cannot
   confirm and ranks the rest.
5. The ranked findings arrive in the main conversation as the workflow's result. Nothing is edited.

## User Stories

1. As the owner, I want `/review` with no argument to review my uncommitted changes (staged, unstaged and new files).
2. As the owner, I want `/review main` to review my branch against `main` (from the merge base), like a PR.
3. As the owner, I want `/review <sha>` to review one commit and `/review #12` a GitHub PR.
4. As the owner, I want the review to run in subagents, so that my main context only gets the findings.
5. As the owner, I want findings with a priority, a file and line range and a concrete reason, so that I can say "fix
   1 and 3".
6. As the owner, I want unconfirmed findings dropped, so that I do not chase false alarms.
7. As the owner, I want lockfiles and generated files skipped and named, so that I know what was not read.
8. As the owner, I want style nits left out, so that the list is about bugs.
9. As the owner, I want to stop, pause and relaunch a review from `/workflows`, like any workflow.

## Implementation Decisions

- Built-in workflows live in `src/extensions/subagent/builtin/workflows/` and are found last, after the project and user
  directories, so a `.pi/workflows/review.js` or `~/.pi/agent/workflows/review.js` of the owner wins. The path is
  resolved through the `src/config.ts` asset helpers, so source checkouts, npm installs and the standalone binary all
  find it. They are runnable in untrusted projects (they ship with xpi).
- The built-in `reviewer` agent sits next to `Explore` and `Plan` in `builtin/`.
- Targets: none → working tree against `HEAD` including untracked files; a branch → `git diff <merge-base>...`;
  a commit → `git show`; `#N` → `gh pr diff N` (needs `gh`).
- Skip list taken from omp's (lockfiles, `*.min.*`, source maps, snapshots, `dist/`, `build/`, `out/`,
  `node_modules/`, `vendor/`, images, fonts, archives).
- Group count by changed lines: under 100 lines or at most 2 files → 1; under 500 → 2; under 2000 → 4; more → 8.
- `reviewer` agent: read-only tools (read, grep, find, ls, bash for read-only git), model
  `sonnet`, system prompt adapted from omp's reviewer (provable impact, introduced by the patch, actionable, no style).
- Finding schema: `title`, `body`, `priority` (P0-P3), `confidence` (0-1), `file`, `lineStart`, `lineEnd`.
- Verifier: one `reviewer`-type agent with a verify prompt and the same schema plus `verdict`; model `sonnet`.
- Result text: a numbered list ranked by priority then confidence, the skipped files, and the reviewers' count.

## Testing Decisions

- Discovery: the built-in workflow is listed, runs in an untrusted project, and a user `review.js` hides it.

- Offline: the script's pure parts (target parsing, skip list, grouping, ranking, result text) as unit tests.
- Real model, by hand, Haiku only: a fixture repo with two planted bugs and a style-only change; `/review` finds the
  bugs and does not report the style change.

## Out of Scope

- Applying fixes; posting to GitHub; a security reviewer; an interactive target menu.
