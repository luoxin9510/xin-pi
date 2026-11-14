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
- Settings come from `pi.getSettings()`, so a project's `.pi/settings.json` counts only as far as project settings count
  today (a trusted project). The spec relies on that: an untrusted project must not get its commands run. The
  implementation checks it and the docs say it.

### 2. When (decisions 1, 4)

- A turn's `turn_end`: if any tool result of the turn came from a tool whose effect is `write` or `exec` (the tool
  effects of ext-api spec 01; an unknown tool counts as `exec`), run the commands once.
- A turn with tool calls always has a next request (the tool results go back to the model), so the new errors reach
  the model there; no `continue` is needed. A turn without tool calls ran no tool and triggers nothing.
- An aborted or error turn (`outcome` other than completed) triggers nothing.

### 3. New errors (decision 3)

- Each command's output is parsed into errors `{file, line, col, message, command}`. The identity of an error is
  `(command, file, message)`, without the position: an edit above an old error moves it and must not make it new.
  Duplicates count: two identical messages in one file where there was one is one new error.
- A baseline is taken before the first change of the session: started in the background at `session_start` (when
  commands are configured), and the first `tool_call` of a `write` or `exec` tool waits for it (with the timeout).
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

- New errors: one `custom_message` (customType `checks`) appended at `turn_end`, user role for the model, e.g.
  `Checks after this turn: 2 new errors.` then one line per error `path:line:col message (command)`, at most
  `maxErrors`, then `and N more` when cut.
- A command that timed out: one line `npx tsc --noEmit: timed out after 60 s (skipped)` in the same message; nothing is
  sent when nothing is new and nothing timed out.
- The TUI renders it with a registered message renderer: one collapsed line `checks: 2 new errors` (expand for the
  list).
- Fixed errors are not announced.

### 6. Subagents (decision 5)

The extension loads in subagents too (no `XPI_SUBAGENT_DEPTH` guard): the same settings, run in the subagent's working
directory (its worktree when isolated). A subagent's baseline is its own.

### 7. Where it lives

A built-in extension `builtin:checks` (`packages/xpi-coding-agent/src/extensions/checks/`), disabled like the others
with `-builtin:checks`. The runner and the parsers are plain modules that the extension calls, testable without a
session. Commands run through the shell with the session's environment; output is capped (1 MiB per command) and the
process group is killed on timeout or when the session ends.

## Tests

- Parsers: each format, paths made relative, junk lines ignored, the unparsable non-zero fallback.
- New-error logic: identity without position, duplicates, baseline replaced after each check.
- Extension with a fake runner: no commands → nothing; a read-only turn → nothing; a write turn → one message with the
  new errors; an aborted turn → nothing; the first write `tool_call` waits for the baseline; timeout line; `maxErrors`.
- A real check in a temp TypeScript project with `tsc`: an edit that adds a type error produces the message.
- A real Haiku check: the model edits a file with a type error introduced on purpose by the task, sees the check
  message, and fixes it in its next turn.
- No test runs `npm test`, vitest or `node --test`; spawned checker processes are gone after each test.

## Docs

A new `docs/checks.md`; `docs/settings.md` (the block, the trust rule, `builtin:checks` in the built-in list);
`docs/extensions.md` only if the extension list is there; `docs/porting.md` (the component); `docs/subagent.md` (applies
to subagents); the README's feature list if it lists built-ins; the settings schema and defaults.
