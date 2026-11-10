# 02: Built-in workflows and `/review`

Spec: `../01-review.md`, decisions 1-7 in `../decisions.md`.

**What to build:** the subagent extension finds built-in workflows; a built-in `reviewer` agent; a built-in `review.js`
workflow run as `/review [target]` that reviews a diff with parallel read-only reviewers, verifies the findings in one
more pass, and returns a ranked list to the main conversation.

**Blocked by:** None (lands after 01 by the agreed order)

**Status:** ready-for-agent

- [ ] Built-in workflows in `src/extensions/subagent/builtin/workflows/`, path through the `src/config.ts` asset helpers
      (source checkout, npm install, standalone binary); found after project and user directories; runnable in
      untrusted projects; listed in `/workflows` with source `builtin`
- [ ] Build and packaging include the new files (check how `builtin/*.md` agents are copied to `dist` and the binary)
- [ ] Built-in `reviewer.md` agent: read-only tools (read, grep, find, ls, bash for git), model `sonnet`, prompt adapted
      from omp's reviewer (provable impact, introduced by the change, actionable, no style)
- [ ] `review.js`: targets (none = working tree incl. untracked, branch = merge-base, commit, `#N` via `gh`); skip
      list; grouping and reviewer count 1/2/4/8; reviewers in parallel with the finding schema
      (`title, body, priority P0-P3, confidence, file, lineStart, lineEnd`); one verifier pass (`sonnet`); ranked
      numbered result with skipped files and reviewer count; a failed reviewer (`null`) is reported, not fatal
- [ ] Verify that scripts can run git (bash through `tools`) in a `/name` run; if not, find the supported way
- [ ] Tests: offline unit tests for the script's pure parts (target parsing, skip list, grouping, ranking, result text)
      and discovery (built-in listed, untrusted project, user file wins); a real-model check by hand with Haiku on a
      fixture repo with two planted bugs and a style-only change
- [ ] Docs: `packages/xpi-coding-agent/docs/subagent.md` (built-in workflows, `reviewer`, `/review`),
      `docs/slash-commands.md`, `docs/xin-pi.md`, `README.md` if it lists built-ins

## Comments
