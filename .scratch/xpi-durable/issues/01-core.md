# Tickets: spec 01 milestone 1, core

Spec: `.scratch/xpi-durable/01-interrupted-turn.md` (sections 1–5). One PR (branch `durable-core`), after the spec
PR: `npm run check`, the tests, green CI, an independent Opus review, the docs.

- [ ] C1.1 `xpi.run` start/end markers in `_startRun` (end also when `_prepareRun` throws), `outcome`
      completed/aborted/error/recovered; one pair per run
- [ ] C1.2 `interruptedRun()`: the last `xpi.run` on the branch is a `start`; dangling tool calls by id (parallel
      order); sessions without markers are never cut off
- [ ] C1.3 the notice at open: interactive warning line, print-mode stderr, RPC `get_state.interruptedRun`
- [ ] C1.4 recovery before a run starts and at `/continue`: interrupted tool results in call order through
      `tool_result`, the `xpi.interrupted` note, the `recovered` end marker last; a complete reply gets only the marker
- [ ] C1.5 `/continue` in `prompt()` before extension commands; in `BUILTIN_SLASH_COMMANDS`; cut off → recover and
      continue; after an error → continue (D1, if approved); otherwise "nothing to continue"; refused during a run and
      with arguments; print mode and RPC
- [ ] C1.6 subagent: meta `callId` (the model-issued call, via `parentToolCallId` for scripts); `tool_result` handler
      adds the agentId line to an interrupted result and marks the record stopped; a test that a child exits when
      its parent dies
- [ ] C1.7 docs: session-format, rpc, built-in command lists and README, extensions, sdk, subagent, porting
- [ ] C1.8 by hand (in `decisions.md`), Haiku 5.5, sandbox: `kill -9` during a tool call → `/continue`; during a
      streaming reply → a message; during an Agent call
