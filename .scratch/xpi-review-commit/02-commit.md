# 02: `/commit` built-in extension

Status: accepted (Grill 1, `decisions.md`). Ticket in `issues/`.

Origin: `omp commit` (agentic pipeline: staged diff, lockfiles hidden, conventional type and scope, past-tense summary
of at most 72 characters, split plans, changelog; single commits are made without confirmation; hooks are never
bypassed).

## Problem Statement

Writing a commit message means asking the main model ("commit this"), which reads the diff into the main context and
spends main-model tokens, or writing it by hand. The repo's message convention lives in `AGENTS.md`, and nothing
applies it consistently.

## Solution

A new built-in extension `builtin:commit` (`src/extensions/commit/`, next to `relay` and `subagent`) with one command
`/commit`. It can be turned off like the other built-in extensions. It reads the staged diff, asks a small model for a message through
`ctx.complete` with a schema, shows the message in an editor for the owner to accept or change, and runs
`git commit`. No subagent and no main-model turn.

## User Stories

1. As the owner, I want `/commit` to propose a message for what I staged and commit after I accept it.
2. As the owner, I want to edit the proposed message before it is used, and cancel by clearing it.
3. As the owner, I want the message to follow my repo's convention (the commit rules in `AGENTS.md`/`CLAUDE.md` and
   the style of recent commits).
4. As the owner, I want `/commit` with nothing staged to offer staging my tracked changes, never untracked files.
5. As the owner, I want hooks to run and a failing hook to show its output, so that `/commit` never skips checks.
6. As the owner, I want a large diff handled (per-file stat plus a capped diff) without failing.
7. As the owner, I want `/commit <hint>` to pass a hint to the model ("fixes #12").

## Implementation Decisions

- Diff: `git diff --cached`; lockfiles as stat only; the diff capped at about 60k characters with a per-file stat for
  the rest.
- Context: the commit section of `AGENTS.md` or `CLAUDE.md` when present, and the last 20 commit subjects.
- `ctx.complete({ model, schema, purpose: "commit" })`, schema `{ type, scope?, summary, body? }`; the message is
  assembled as `type(scope): summary` plus body. When the repo convention says otherwise the model follows it and puts
  the whole subject in `summary` with `type` "custom".
- Model: setting `commit.model`, default `haiku` (in the settings schema).
- Confirmation: `ctx.ui.editor` with the message; empty or cancel aborts. Without a UI (print mode) `/commit` prints the
  message and commits only with `--yes`.
- Commit: `pi.exec("git", ["commit", "-F", <temp file>])`; never `--no-verify`, `--amend` or push. A failing hook's
  output is shown and nothing is retried.

## Testing Decisions

- Offline with the faux provider and a temp git repo: message proposed and committed; edit used; cancel commits
  nothing; nothing staged and stage offer; failing hook shown; large diff capped; hint passed.
- Prior art: `test/suite/ctx-complete.test.ts`, extension command tests.

## Out of Scope

- Split commits, changelog updates, push, amend, PR creation.
