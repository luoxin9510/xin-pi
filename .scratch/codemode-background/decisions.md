# Decisions

Codemode scripts in the background, with a Claude Code-like way to watch them (owner, 2026-11-11: "do the background
run first, like Claude: the TUI shows it like a bash or shell, and you can select it and go in to see the details").

Facts checked on main `b73da1cd4`: `codemodeScripts.background()` moves a running script to the background; the
subagent extension delivers its result as a steer and lists background scripts in the panel; Enter on a script row does
nothing today; nested tool calls emit `tool_execution_start/update/end` with `parentToolCallId`; bash has no background
option of its own.

## Grill 1 (2026-11-11): accepted (owner answered "all yes")

Each line is worded so "yes" accepts the proposal.

1. `codemode` gains `run_in_background: true` (reusing the existing background move and result delivery) and an
   optional `description` of a few words. Without a background controller (subagent extension off,
   `backgroundScripts: false`, print mode) it waits as today.
2. Tool guidance: use it for commands over about 30 seconds whose result is not needed this turn; never for dev servers
   or `watch` (they never end). The script should return a filtered result (failures, a summary), not the whole log.
3. Script rows read `● running · build and test (S1) · 1m12s · bash npm test`: description (else the first bash
   command, else `script S1`), state, elapsed, the running tool call; agent count and cost only when it has agents.
4. Enter on a script row opens a script screen: header (id, description, state, elapsed), the nested tool calls in
   order with status and duration, the live output tail of the running call, `log()` lines, the code, and the result or
   error at the end. Keys: `Esc` back, `x` stop, `↑ ↓ PgUp PgDn` scroll. Same for workflow and agent scripts.
5. Nested output is kept in memory for the session only, the last 200 lines per call; the session file is unchanged.
6. Out of scope now: long-lived services (dev servers, watchers), a footer counter, output kept after the session.
7. One ticket; Sonnet implementer; review; `./test.sh`; wait for green CI before merging; then by hand with Haiku: one
   pty TUI check of the screen and one real-model check that the model uses `run_in_background` for a slow command.
