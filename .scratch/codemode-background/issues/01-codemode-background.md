# 01: Codemode background run and script screen

Spec: `../01-codemode-background.md`, decisions 1-7 in `../decisions.md`.

**What to build:** `codemode` gains `run_in_background` and `description`; script rows in the subagent panel say what
the script is doing; Enter on a script row opens a script screen with its nested tool calls, live output, log, code
and result.

**Blocked by:** None (can start immediately)

**Status:** in review

- [x] `codemode` schema: optional `run_in_background: boolean`, optional `description: string`; background move through
      `codemodeScripts.background()` right after the script starts; ignored (waits) without a controller, with
      `subagent.backgroundScripts: false`, and in print mode
- [x] Tool guidance (codemode description or prompt guideline): commands over ~30 s whose result is not needed this
      turn; never dev servers or `watch`; return a filtered result
- [x] Script record: `description`, the nested tool calls (name, short args such as the bash command, status, start/end,
      output tail capped at 200 lines) from `tool_execution_start/update/end` events with `parentToolCallId`
- [x] Panel script row: description (fallback: first bash command, then `script S1`), state, elapsed, running call;
      agent count and cost only when the script has agents; workflow rows keep their workflow name and run id
- [x] Script screen (Enter on a script row): header (id, description, state, elapsed), calls with status and duration,
      live output tail of the running call, `log()` lines, code, result or error when ended; `Esc` back, `x` stop,
      `↑ ↓ PgUp PgDn` scroll; fixed keys documented with the panel's in `docs/subagent.md`
- [x] End message to main uses the description when present
- [x] Offline tests: background call returns at once and the result arrives as a message; waits without a controller
      and in print mode; row label with and without description; screen renders calls, output, result; `x` stops
- [ ] By hand with Haiku after merge: pty TUI check of the screen; real-model check that the model uses
      `run_in_background` for a slow command and the result arrives
- [x] Docs: `packages/xpi-coding-agent/docs/codemode.md`, `docs/subagent.md` (background work, panel, script screen, keys),
      `docs/xin-pi.md`

## Comments

- Flag detection: `codemodeScripts` gains `provideBackground(provider)` / `canBackground(sessionId)`. The subagent
  registry's `connect()` registers a provider (`enabled()` = `backgroundScripts !== false` and a UI), so the flag is
  ignored with the extension off, the setting off, or in print mode. The move happens in `executeCodemode` right after
  the script starts.
- Deviation: the model-facing guidance is static text in the codemode description (it says the flag is ignored where
  unavailable). The loadout is built before the subagent extension knows its config, so it cannot be conditional like
  the Agent tool's description.
- Deviation: the row keeps the existing state word (`foreground` / `background`, `paused`) instead of `running`, so the
  row still says where the script is; the existing panel tests assert it.
- Screen order is calls, log, code (first 20 lines), output of the running (else last) call, result; it follows the
  live end like the subagent screen. `scripts.nested()` records calls whose `parentToolCallId` is the script's call id.
- The real-model by-hand test is `test/subagent/parent/05-codemode-run-in-background.test.ts` (a real rpc parent), not
  under `real/`, because `real/` has no parent-pi harness and only a parent can make the model choose the flag.
- By-hand checks still open: `npm run build`, then the tui and parent tests (commands in the report).
