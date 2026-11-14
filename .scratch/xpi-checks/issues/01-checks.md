# Tickets: spec 01, checks after edits

Spec: `.scratch/xpi-checks/01-checks.md`. One PR (branch `checks`): independent Opus review, green CI, the docs, a real
Haiku check before merge.

- [x] C0 core: `TurnEndEvent.terminated` (the batch ended the run), set from the loop through `finishTurn`; tests;
      `docs/extensions.md`
      Done: `TurnEndEvent.terminated` and `AgentTurnContext.terminated` (agent-loop.ts, types.ts, agent-session.ts); tests in agent-loop.test.ts and suite/agent-session-boundaries.test.ts.

- [x] C1 settings: the `checks` block in the schema and defaults; the trust rule verified for project settings
      Done: schema and defaults; the trust rule pinned in test/settings-manager.test.ts.

- [x] C2 runner: shell, cwd, timeout, output cap, process-group kill; tests with a fake command
      Done: extensions/checks/runner.ts; test/checks-runner.test.ts (timeout, abort, group kill, 1 MiB cap).

- [x] C3 parsers and the new-error logic; unit tests
      Done: extensions/checks/parse.ts; test/checks-parse.test.ts.

- [x] C4 `builtin:checks`: effects noted at `tool_call` by id and counted at `tool_result`, cleared per turn, baseline at `session_start`, the first write/exec
      `tool_call` waits, `turn_end` check (not when aborted or `terminated`) and message, status line,
      `ctx.signal` and `session_shutdown` kill, subagents included; tests with a fake runner
      Done: extensions/checks/index.ts (`createChecksExtension(runner)`); test/suite/checks.test.ts with a fake runner.

- [x] C5 the message renderer (collapsed line)
      Done: extensions/checks/render.ts.

- [x] C6 a real `tsc` check in a temp project
      Done: test/suite/checks-tsc.test.ts (the repo's own `tsc` by absolute path).
- [x] C6b the real Haiku check (the lead runs it)
      Done (2026-11-14, by hand, the built bundle, an isolated agent directory, `checks.commands` = the repo's tsc):
      Haiku was told to make an edit that breaks the return type and to fix what it is told about; it got the check
      message, fixed `math.ts` and then `main.ts` (a second message after its fix), and the project type-checks. Five
      runs in a row, 14-18 s each. Four earlier runs stalled (no output until killed), including one meant to have
      checks off (`-e -builtin:checks` does not disable a built-in); they were not reproduced afterwards.
- [x] C7 docs: `checks.md`, `settings.md`, `porting.md` (diagram and Pick table), `subagent.md`, `docs/xin-pi.md`, both
      READMEs
      Done: checks.md, settings.md, porting.md, subagent.md, xin-pi.md, both READMEs, extensions.md, docs.json.
