# Decisions

First package from the omp study: `/review` and `/commit`.

- `01-package-resources.md`: packages can ship workflows and agent definitions (core change, needed by `/review`).
- `02-review.md`: `/review` as a saved workflow with parallel read-only reviewers and a verification pass.
- `03-commit.md`: `/commit` as an extension command using `ctx.complete`, with the owner confirming the message.

Facts checked on main `0b75571b8` (2026-11-10): packages ship only extensions, skills, prompts and themes; saved
workflows run as `/name` with no model turn and can run agents in parallel with a schema; extension commands have
`ui.editor`/`ui.confirm` and `pi.exec`. omp facts from `~/Developer/oh-my-pi` at `f0200abf`.

## Grill 1 (2026-11-10): waiting for the owner

Each line is worded so "yes" accepts the proposal.

Packaging

1. One package `xpi-review-commit` in this monorepo (`packages/xpi-review-commit/`), shipping the `/commit` extension,
   the `review` workflow and the `reviewer` agent. Installed with `xpi install`; it needs the next xpi release (it uses
   `ctx.complete` and spec 01). Later packages each get their own directory the same way.
2. Spec 01 first: packages ship `workflows/` and `agents/`; package entries come after the project and user
   directories, so the owner's own file of the same name wins.

`/review`

3. Targets: none = uncommitted changes including new files; a branch = merge-base diff; a commit; `#N` = GitHub PR via
   `gh`. No menu.
4. omp's skip list (lockfiles, generated, minified, `dist/`, binaries); skipped files are named in the result.
5. Reviewer count by changed lines: 1 (under 100 lines or at most 2 files), 2 (under 500), 4 (under 2000), 8 (more);
   files grouped by directory, tests with their code.
6. `reviewer` agent: read-only (read, grep, find, ls, bash for git), model `sonnet`, bugs introduced by the change
   only, no style; findings `title, body, priority P0-P3, confidence, file, lineStart, lineEnd`.
7. One verifier pass (`sonnet`) re-checks every finding, merges duplicates, drops the unconfirmed, ranks the rest.
8. The result is a numbered list in the main conversation; nothing is edited; fixes happen when the owner asks.

`/commit`

9. Staged changes only; with nothing staged, offer to stage tracked changes (`git add -u`), never untracked files.
10. Message from `ctx.complete` with a schema, model `haiku` (setting `reviewCommit.commitModel`), following the commit
    rules in `AGENTS.md`/`CLAUDE.md` and the last 20 subjects.
11. The message always opens in an editor first; empty cancels. Print mode commits only with `--yes`.
12. Never `--no-verify`, `--amend` or push; a failing hook's output is shown and nothing is retried.
13. No split commits and no changelog in this version.

Process

14. Tickets after this Grill: 01 (core, xin-pi PR), 02 package skeleton + `/commit`, 03 `/review`. Sonnet implementers,
    review, `./test.sh`, CI, merge. Real-model check of `/review` on a fixture repo with Haiku only.
