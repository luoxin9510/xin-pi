# Decisions

`/review` and `/commit`, from the omp study, as built-ins of xpi (owner, 2026-11-10: built-in, not a package; no new
workflow machinery).

- `01-review.md`: `/review` as a built-in saved workflow on the existing engine, with a built-in `reviewer` agent.
- `02-commit.md`: `/commit` as a built-in extension using `ctx.complete`, with the owner confirming the message.

Facts checked on main `0b75571b8` (2026-11-10): saved workflows run as `/name` with no model turn and can run agents in
parallel with a schema; built-in agents live in `src/extensions/subagent/builtin/`; there are no built-in workflows
yet; extension commands have `ui.editor`/`ui.confirm` and `pi.exec`. A workflow script runs in the background with no
UI, so `/commit` (which needs the owner's confirmation) is an extension command, not a workflow. omp facts from
`~/Developer/oh-my-pi` at `f0200abf`.

Dropped: a package format for workflows and agents (not needed for built-ins).

## Grill 1 (2026-11-10): waiting for the owner

Each line is worded so "yes" accepts the proposal.

Built-ins

1. Built-in workflows in `src/extensions/subagent/builtin/workflows/`, found after the project and user directories (the
   owner's own `review.js` wins), runnable in untrusted projects. `reviewer` joins `Explore` and `Plan` as a built-in
   agent. `/commit` is a new built-in extension `builtin:commit` that can be turned off like the others.

`/review`

2. Targets: none = uncommitted changes including new files; a branch = merge-base diff; a commit; `#N` = GitHub PR via
   `gh`. No menu.
3. omp's skip list (lockfiles, generated, minified, `dist/`, binaries); skipped files are named in the result.
4. Reviewer count by changed lines: 1 (under 100 lines or at most 2 files), 2 (under 500), 4 (under 2000), 8 (more);
   files grouped by directory, tests with their code.
5. `reviewer` agent: read-only (read, grep, find, ls, bash for git), model `sonnet`, bugs introduced by the change
   only, no style; findings `title, body, priority P0-P3, confidence, file, lineStart, lineEnd`.
6. One verifier pass (`sonnet`) re-checks every finding, merges duplicates, drops the unconfirmed, ranks the rest.
7. The result is a numbered list in the main conversation; nothing is edited; fixes happen when the owner asks.

`/commit`

8. Staged changes only; with nothing staged, offer to stage tracked changes (`git add -u`), never untracked files.
9. Message from `ctx.complete` with a schema, model `haiku` (setting `commit.model`), following the commit rules in
   `AGENTS.md`/`CLAUDE.md` and the last 20 subjects.
10. The message always opens in an editor first; empty cancels. Print mode commits only with `--yes`.
11. Never `--no-verify`, `--amend` or push; a failing hook's output is shown and nothing is retried.
12. No split commits and no changelog in this version.

Process

13. Tickets after this Grill: 01 `/commit` (smaller, first), 02 built-in workflows + `reviewer` + `/review`. Sonnet
    implementers, review, `./test.sh`, CI, merge. Real-model check of `/review` on a fixture repo with Haiku only.
