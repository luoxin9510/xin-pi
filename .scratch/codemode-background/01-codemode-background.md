# 01: Codemode scripts in the background, and a screen to watch them

Status: draft, waiting for Grill 1 (`decisions.md`). No code until the owner approves.

Origin: omp's bash auto-background with job widgets, and Claude Code's background shells (a footer count, a task list,
Enter shows the command's output, `k` kills it). xpi already has the machinery: a running codemode script can move to
the background (`codemodeScripts.background()` in `src/extensions/codemode/scripts.ts`), its result comes back to main
as a steer that starts a turn (results over 8 KB go to a file), and the subagent panel lists background scripts as
rows (`S1`) that `x` stops.

## Problem Statement

A long command blocks the turn. The model writes `await tools.bash({ command: "npm run build && npm test" })` and the
session waits minutes; the owner can only press ctrl+b to free it. A script moves to the background by itself only
when it starts an `Agent`.

Once in the background, a script is hard to follow: its panel row says `script S1 · 0 agents running · 42s · $0.0000`,
which does not say what it runs, and Enter on a script row does nothing ("a script has no screen"), so its output
cannot be watched.

## Solution

1. `codemode` gains `run_in_background: true`: the script moves to the background as it starts, the call returns at
   once, and the result arrives later as today. An optional `description` (a few words) names the script.
2. The panel's script row shows what the script is doing: its description, state, elapsed time and the tool call it
   is running (`bash npm test`).
3. Enter on a script row opens a script screen: the script's tool calls in order with status and duration, the live
   output of the running one, its `log()` lines, its code, and its result or error when it ends. `x` stops it, `Esc`
   goes back.

Example: the owner asks "build and run the tests". The model calls `codemode({ run_in_background: true, description:
"build and test", code })`, says it started, and keeps answering. The panel shows
`● running · build and test (S1) · 1m12s · bash npm test`. Enter shows the test output scrolling. When it ends, main gets
"Script S1 completed" with the result the script returned (for example only the failing tests).

## User Stories

1. As the owner, I want the model to start a long build or test run in the background, so that I can keep talking.
2. As the owner, I want the result to come back by itself when it ends, so that I do not have to ask.
3. As the owner, I want the panel row to say what the script is doing, so that I know which row is which.
4. As the owner, I want to open a background script and watch its output, so that I can see progress or an error early.
5. As the owner, I want to stop it from the panel or its screen.
6. As the owner, I want the script to return a filtered result (failures only), so that the log does not flood context.
7. As the owner, I want ctrl+b-moved scripts and agent scripts to get the same row and screen.

## Implementation Decisions

- `run_in_background` and `description` are new optional fields of the `codemode` tool. The background move reuses
  `codemodeScripts.background()`; delivery, the 8 KB file, the panel, stop and session-end cleanup are unchanged.
- Without a background controller (subagent extension off, `subagent.backgroundScripts: false`, print mode) the field
  is ignored and the call waits, as `Agent`'s `run_in_background` does.
- Tool guidance: use it for commands that take more than about 30 seconds and whose result is not needed this turn;
  never for processes that do not end (dev servers, `watch`), since the result would never come back.
- The script record gains `description` and the latest nested tool call (from `tool_execution_*` events with
  `parentToolCallId`); the row label falls back to the first bash command, then `script S1`.
- The script screen is a new screen next to the subagent screen, with fixed keys listed in `docs/subagent.md` (the
  panel and its screens use fixed keys by the AGENTS.md exception). Nested call output is kept in memory for the
  session, capped per call; nothing new is written to the session file.

## Testing Decisions

- Offline: a background `codemode` call returns at once and its result arrives as a message; fallback to waiting without
  a controller; row label with description and fallback; the screen renders calls, live output, result and stops the
  script on `x` (component tests like the existing panel tests).
- TUI (pty, by hand with Haiku, `test:subagent:tui`): open the screen of a running background script and see output.
- Real model (Haiku, by hand): asked to run a slow command in the background, the model uses `run_in_background` and the
  result arrives as a message.

## Out of Scope

- Long-lived services (dev servers, watchers) with logs and restart.
- A footer counter outside the panel.
- Keeping nested output after the session ends.
