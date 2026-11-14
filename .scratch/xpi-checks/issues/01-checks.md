# Tickets: spec 01, checks after edits

Spec: `.scratch/xpi-checks/01-checks.md`. One PR (branch `checks`): independent Opus review, green CI, the docs, a real
Haiku check before merge.

- [ ] C0 core: `TurnEndEvent.terminated` (the batch ended the run), set from the loop through `finishTurn`; tests;
      `docs/extensions.md`
- [ ] C1 settings: the `checks` block in the schema and defaults; the trust rule verified for project settings
- [ ] C2 runner: shell, cwd, timeout, output cap, process-group kill; tests with a fake command
- [ ] C3 parsers and the new-error logic; unit tests
- [ ] C4 `builtin:checks`: effects noted at `tool_call` by id and counted at `tool_result`, cleared per turn, baseline at `session_start`, the first write/exec
      `tool_call` waits, `turn_end` check (not when aborted or `terminated`) and message, status line,
      `ctx.signal` and `session_shutdown` kill, subagents included; tests with a fake runner
- [ ] C5 the message renderer (collapsed line)
- [ ] C6 a real `tsc` check in a temp project; the real Haiku check
- [ ] C7 docs: `checks.md`, `settings.md`, `porting.md` (diagram and Pick table), `subagent.md`, `docs/xin-pi.md`, both
      READMEs
