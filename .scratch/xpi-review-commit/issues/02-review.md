# 02: Built-in workflows and `/review`

Spec: `../01-review.md`, decisions 1-7 in `../decisions.md`.

**What to build:** the subagent extension finds built-in workflows; a built-in `reviewer` agent; a built-in `review.js`
workflow run as `/review [target]` that reviews a diff with parallel read-only reviewers, verifies the findings in one
more pass, and returns a ranked list to the main conversation.

**Blocked by:** None (lands after 01 by the agreed order)

**Status:** in review

- [x] Built-in workflows in `src/extensions/subagent/builtin/workflows/`, path through the `src/config.ts` asset helpers
      (source checkout, npm install, standalone binary); found after project and user directories; runnable in
      untrusted projects; listed in `/workflows` with source `builtin`
- [x] Build and packaging include the new files (check how `builtin/*.md` agents are copied to `dist` and the binary)
- [x] Built-in `reviewer.md` agent: read-only tools (read, grep, find, ls, bash for git), model `sonnet`, prompt adapted
      from omp's reviewer (provable impact, introduced by the change, actionable, no style)
- [x] `review.js`: targets (none = working tree incl. untracked, branch = merge-base, commit, `#N` via `gh`); skip
      list; grouping and reviewer count 1/2/4/8; reviewers in parallel with the finding schema
      (`title, body, priority P0-P3, confidence, file, lineStart, lineEnd`); one verifier pass (`sonnet`); ranked
      numbered result with skipped files and reviewer count; a failed reviewer (`null`) is reported, not fatal
- [x] Verify that scripts can run git (bash through `tools`) in a `/name` run; if not, find the supported way
- [x] Tests: offline unit tests for the script's pure parts (target parsing, skip list, grouping, ranking, result text),
      whole runs with a fake `agent()`, an e2e `xpi -p /review`, and discovery (built-in listed, untrusted project, user
      file wins)
- [x] Real-model check by hand with Haiku on a fixture repo with two planted bugs and a style-only change
      (`test/subagent/real/23-review.test.ts`: passed 2026-11-11 on 8bd5ff1e6, both bugs found, style change not
      reported, 15 s)
- [x] Docs: `packages/xpi-coding-agent/docs/subagent.md` (built-in workflows, `reviewer`, `/review`),
      `docs/slash-commands.md`, `docs/xin-pi.md`, `README.md` if it lists built-ins

## Comments

- Built-in workflows are found by `discoverWorkflows` scanning `join(BUILTIN_DIR, "workflows")` last (source `builtin`),
  regardless of trust. `BUILTIN_DIR` (discovery.ts) is what built-in agents use: `<packageDir>/src` or `/dist`, then
  `extensions/subagent/builtin`. `getPackageDir()` already handles source, npm and the standalone binary.
- Packaging: `copy-assets` got a second copy command for `builtin/workflows/*.js` (package-files `copy` flattens by
  basename, so the `*.md` command cannot take a subdirectory). Deviation: `scripts/build-binaries.sh` copied no
  built-in agents next to the standalone binary, while `BUILTIN_DIR` looks in `<exec dir>/dist/extensions/subagent/builtin`
  there; it now copies that directory (agents and workflows). Not verified by building a binary.
- Scripts run git through `tools.bash` (verified: a real `xpi -p /review` in the offline e2e test reads the diff with the
  session's bash tool inside the codemode sandbox). It returns `{ output, exit_code, truncated }`; output is cut at
  2000 lines or 50KB, so the script writes each diff to a temp file and reads it back in `sed` chunks (halved when a chunk
  is still truncated). A session without the bash tool gets a clear error result.
- Helper/test approach: a workflow file cannot import, so the pure helpers sit between `// BEGIN helpers` and
  `// END helpers` in `review.js`; the test reads the file, evaluates exactly that section with `new Function`, and also
  runs the whole body (`parseWorkflow(...).body` in an `AsyncFunction`) with a fake `agent()`, `parallel()`, `phase()`
  and a bash that runs real commands in a temp repository. One source of truth, no duplicated logic.
- Targets: `#N` pull request; otherwise a name that resolves is a branch when `refs/heads/<name>` or
  `refs/remotes/<name>` exists (merge-base diff `<name>...HEAD`), else a commit (`git show`). All-digit refs such as a
  short sha `1234567` arrive as a JSON number and are read as refs, not PR numbers.
- Grouping: units are sorted by path and cut by midpoint of cumulative changed lines, so directories stay together and
  groups are balanced to about one unit's size, not exactly.
- Verifier schema: `{ findings: [finding], dropped: [{ title, reason }] }` (kept findings, duplicates merged, plus the
  dropped ones with reasons) instead of a per-finding `verdict`. If the verifier fails, findings are shown marked as
  unverified. Diffs over 60000 changed lines are refused (reviewers could not be fed them reasonably).
- Real-model fixture (not run): `test/subagent/real/23-review.test.ts`, remaps the `sonnet` alias to haiku through
  `subagent.models` in the fixture's `.pi/settings.json`.
