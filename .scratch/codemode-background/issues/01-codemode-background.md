# 01: Codemode background run and script screen

Spec: `../01-codemode-background.md`, decisions 1-7 in `../decisions.md`.

**What to build:** `codemode` gains `run_in_background` and `description`; script rows in the subagent panel say what
the script is doing; Enter on a script row opens a script screen with its nested tool calls, live output, log, code
and result.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] `codemode` schema: optional `run_in_background: boolean`, optional `description: string`; background move through
      `codemodeScripts.background()` right after the script starts; ignored (waits) without a controller, with
      `subagent.backgroundScripts: false`, and in print mode
- [ ] Tool guidance (codemode description or prompt guideline): commands over ~30 s whose result is not needed this
      turn; never dev servers or `watch`; return a filtered result
- [ ] Script record: `description`, the nested tool calls (name, short args such as the bash command, status, start/end,
      output tail capped at 200 lines) from `tool_execution_start/update/end` events with `parentToolCallId`
- [ ] Panel script row: description (fallback: first bash command, then `script S1`), state, elapsed, running call;
      agent count and cost only when the script has agents; workflow rows keep their workflow name and run id
- [ ] Script screen (Enter on a script row): header (id, description, state, elapsed), calls with status and duration,
      live output tail of the running call, `log()` lines, code, result or error when ended; `Esc` back, `x` stop,
      `↑ ↓ PgUp PgDn` scroll; fixed keys documented with the panel's in `docs/subagent.md`
- [ ] End message to main uses the description when present
- [ ] Offline tests: background call returns at once and the result arrives as a message; waits without a controller
      and in print mode; row label with and without description; screen renders calls, output, result; `x` stops
- [ ] By hand with Haiku after merge: pty TUI check of the screen; real-model check that the model uses
      `run_in_background` for a slow command and the result arrives
- [ ] Docs: `packages/xpi-coding-agent/docs/codemode.md`, `docs/subagent.md` (background work, panel, script screen, keys),
      `docs/xin-pi.md`

## Comments
