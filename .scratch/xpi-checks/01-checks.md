# Spec 01: checks after edits

Status: approved by the owner on 2026-11-14 (Grill 1 in `decisions.md`, all six as recommended).

## Problem

After the model edits code it does not know whether the project still type-checks or lints until it runs the checker
itself, which costs a turn, and often it does not run it at all. Errors it introduced surface later, or never.

## Goal

When a turn changed something, xpi runs the project's own check commands once and shows the model the errors that are
new since the last check, before its next request. Off unless the project or the user names the commands.

Not in this spec: a language server, per-edit checks, fixing errors automatically, checks for read-only turns.

## Design

### 1. Settings (decision 2)

A `checks` block in settings:

```json
{
  "checks": {
    "commands": ["npx tsc --noEmit", "npx biome check --reporter=github"],
    "timeoutMs": 60000,
    "maxErrors": 20
  }
}
```

- `commands`: shell commands run in the session's working directory, in order. No commands (the default): the feature
  does nothing at all, no baseline, no process.
- `timeoutMs` (default 60000) per command; `maxErrors` (default 20) per message to the model.
- Settings are read with `pi.getSettings()` at each check (and at the baseline), never cached. An untrusted project's
  `.pi/settings.json` is not loaded at all today (the settings manager returns `{}` for it, and `settings.json` is a
  trust-gated resource), so its commands are never run; a subagent inherits the parent's trust decision. A test pins
  this; the docs say it.
- Schema next to `CommitSettingsSchema` in `core/settings-schema.ts`, defaults in `core/settings-defaults.ts`.

### 2. When (decisions 1, 4)

- Effects are not on `turn_end`'s tool results. The extension notes each call's effect at the `tool_call` event,
  which carries `effect`, keyed by `toolCallId`, and counts the call as run only when a `tool_result` with the same id
  arrives: a call another extension blocks gets no `tool_result` (and `tool_call` handlers stop at the first block, so
  the checks handler may have seen it). Codemode's nested calls emit both events too (ids `<parent>/<n>`, with
  `parentToolCallId`); they are not in `turn_end`'s `toolResults`, so "this turn" is by time: the run calls noted
  since the previous `turn_end`, cleared at each `turn_end`. A background codemode script's calls between turns count
  for the next turn. An unknown tool never reaches `tool_call` (it fails as "not found" before it) and triggers
  nothing.
- Effects as built today: `codemode`, `bash`, `powershell` (undeclared, so `exec`), `Agent` and `Workflow` are
  `exec`; `edit`, `write`, `SendMessage`, team messages and the task board's write tools are `write`. So a turn that only starts a read-only subagent still runs the checks
  (accepted: the subagent may have changed files).
- A turn's `turn_end`: if a recorded call of this turn is `write` or `exec`, run the commands once.
- The next request: a turn whose tool batch did not end the run has a next request, so the message reaches the model
  before it; no `continue` is needed. A batch can end the run (every result `terminate`s, as relay's `handback`
  does), and today an extension cannot see that at `turn_end`. **Core change:** `TurnEndEvent` gains
  `terminated: boolean`, the loop's `executedToolBatch.terminate` passed through `finishTurn`'s turn; `docs/extensions.md`
  (the turn_end section and the list of fields a host must provide) says so. When `terminated` is true no check is
  run (the message would have no request to reach). A turn without tool calls ran no tool and triggers nothing.
- Abort: `outcome` reflects the assistant message only, so Escape during tool execution still gives `completed`. A
  check is not started when `outcome` is not `completed` or `ctx.signal` is aborted, and a running check listens to
  `ctx.signal` and kills its process group when it fires (no message then).
- Cost, accepted: `turn_end` is awaited, so the next request waits for the checks (worst case the sum of the
  timeouts). While they run the extension shows `ctx.ui.setStatus("checks", "checks: running npx tsc --noEmit…")` and
  clears it after.

### 3. New errors (decision 3)

- Each command's output is parsed into errors `{file, line, col, message, command}`. The identity of an error is
  `(command, file, message)`, without the position: an edit above an old error moves it and must not make it new.
  Duplicates count: two identical messages in one file where there was one is one new error.
- A baseline is taken before the first change of the session: started in the background at `session_start` (when
  commands are configured), and the first `tool_call` of a `write` or `exec` tool waits for it. Tool calls of one
  assistant message are prepared one by one before any runs, so waiting there guarantees nothing in that batch ran
  yet (the batch's read tools wait too). The wait is bounded by the sum of the commands' timeouts and by `ctx.signal`.
- A command with no baseline (it timed out, or the wait was cut short) reports nothing at its next check: that result
  only becomes its baseline.
- `/new`, `/resume` and a fork replace the extension runtime: a new instance takes a new baseline in the new `ctx.cwd`.
  `session_shutdown` kills a baseline or check still running.
- After every check its result becomes the baseline. An error the model does not fix is therefore reported once, not
  every turn.
- A command that cannot be parsed (no line matched a known format) but exits non-zero contributes one error with the
  last 20 lines of its output, identity `(command, "", <exit code>)`.

### 4. Parsing

Built-in line formats, tried in order on each output line (stdout and stderr):

- `path(line,col): error TSnnnn: message` (tsc)
- `::error file=path,line=n,col=n::message` and `::warning ...` (GitHub annotations: biome `--reporter=github`, others)
- `path:line:col: message` (ruff `--output-format=concise`, eslint `-f unix`, gcc-like tools)
- `path:line: error: message` (mypy)

Paths are made relative to the working directory. Warnings count as errors only for the GitHub format's `::error`.

### 5. What the model and the person see (decision 6)

- New errors: one `custom_message` draft entry (customType `checks`, `display: true`, the errors in `details`)
  returned from `turn_end` as `entries: [...event.entries, draft]` (the returned list replaces the proposal, so the
  earlier entries are kept). It reaches the model as a user-role message, e.g.
  `Checks after this turn: 2 new errors.` then one line per error `path:line:col message (command)`, at most
  `maxErrors`, then `and N more` when cut.
- A command that timed out: one line `npx tsc --noEmit: timed out after 60 s (skipped)` in the same message; nothing is
  sent when nothing is new and nothing timed out.
- The TUI renders it with a registered message renderer: one collapsed line `checks: 2 new errors` (expand for the
  list, from `details`). Only `display: true` messages render.
- Steering and queued messages are taken after `turn_end`, so they come after the check message.
- Fixed errors are not announced.

### 6. Subagents (decision 5)

The extension loads in subagents too (no `XPI_SUBAGENT_DEPTH` guard): the same settings, run in the subagent's working
directory (its worktree when isolated). A subagent's baseline is its own. Accepted overlaps:
- a subagent that is not isolated changes the parent's tree; the parent checks again after its `Agent` turn and may
  report errors the subagent already saw (they are new to the parent);
- an isolated worktree without dependencies (`node_modules`) makes a command fail unparsed; that is in its baseline,
  so it is reported only if its output changes.

### 7. Where it lives

A built-in extension `builtin:checks` (`packages/xpi-coding-agent/src/extensions/checks/`), disabled like the others
with `-builtin:checks`. The runner and the parsers are plain modules that the extension calls, testable without a
session. Commands run through the shell with the session's environment; output is capped (1 MiB per command) and the
process group is killed on timeout or when the session ends.

## Tests

- Parsers: each format, paths made relative, junk lines ignored, the unparsable non-zero fallback.
- New-error logic: identity without position, duplicates, baseline replaced after each check.
- Extension with a fake runner: no commands → nothing; a read-only turn → nothing; a write turn → one message with the
  new errors (earlier proposed entries kept); an aborted turn and an aborted signal → nothing; a turn whose results
  all terminate → nothing; a blocked call → nothing; the first write `tool_call` waits for the baseline; a command
  without a baseline reports nothing once; timeout line; `maxErrors`; an untrusted project's commands are not run.
- A real check in a temp TypeScript project with `tsc`: an edit that adds a type error produces the message.
- A real Haiku check: the model edits a file with a type error introduced on purpose by the task, sees the check
  message, and fixes it in its next turn.
- No test runs `npm test`, vitest or `node --test`; spawned checker processes are gone after each test.

## Docs

A new `docs/checks.md`; `docs/settings.md` (the block, the trust rule, `builtin:checks` in the built-in list at line
~180); `docs/porting.md` (a row in the units diagram and in the Pick table); `docs/subagent.md` (applies to subagents);
`docs/xin-pi.md` (its built-in list); the root `README.md` and `packages/xpi-coding-agent/README.md` feature lists; the
settings schema and defaults.
