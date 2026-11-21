# 03: `builtin:wait` — the tool, entries, in-process waking (spec 02, milestone 1)

Spec: `.scratch/xpi-durable/02-waits.md` sections 1–5, 7. Blocked until the owner approves the spec (D1, D2).

First, check these facts and record them in `decisions.md`:
- how an extension can run a command through the bash tool's executor and emit `tool_call` for it (section 4); if it
  cannot, stop and bring the options to the owner;
- how the subagent extension builds a child's tool list (to leave `wait` out).

- [ ] W.1 `src/extensions/wait/`: tool `wait` (parse `after`/`at`/`every`, limits, latest-assistant-message rule,
      `terminate`), `xpi.wait` / `xpi.wake` / `xpi.woke`, pending rule, `/wait` and `/wait cancel`.
- [ ] W.2 Timer and check in the process; waking (due, check, deadline, blocked, late); a user message ends the wait
      (note before the message); reopen at `session_start`; print mode's stderr line.
- [ ] W.3 Core: D2 as approved; `createBranchedSession` cancels a copied pending wait.
- [ ] W.4 Graph: a pending wait is not "ended without leaving"; subagents: `wait` not in a child's tools.
- [ ] W.5 Tests: `test/suite/wait.test.ts` (faux), graph-controls cases; docs (section 7, milestone-1 parts) and
      `porting.md` entry "waits".
- [ ] W.6 By hand, Haiku 5.5, sandbox agent dir: a 2-minute wait in an open session; a check on a file another shell
      creates; `kill -9` during a wait, reopen. Results in `decisions.md`.
