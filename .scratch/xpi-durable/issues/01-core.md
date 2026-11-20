# Tickets: spec 01 milestone 1, core

Spec: `.scratch/xpi-durable/01-interrupted-turn.md` (sections 1–5). One PR (branch `durable-core`), after the spec
PR: `npm run check`, the tests, green CI, an independent Opus review, the docs.

- [x] C1.1 `xpi.run` start/end markers in `_startRun` (end also when `_prepareRun` throws), `outcome`
      completed/aborted/error/recovered; one pair per run
- [x] C1.2 `interruptedRun()`: the last `xpi.run` on the branch is a `start`; dangling tool calls by id (parallel
      order); sessions without markers are never cut off
- [x] C1.3 the notice at open: interactive warning line, print-mode stderr, RPC `get_state.interruptedRun`
- [x] C1.4 recovery before a run starts and at `/continue`: interrupted tool results in call order through
      `tool_result`, the `xpi.interrupted` note, the `recovered` end marker last; a complete reply gets only the marker
- [x] C1.5 `continueRun()` → `ContinueResult`; the `{ messageType: "continue" }` trigger (no starting message,
      `agent.continue()`); cut off → recover and continue; after an error → omit it and continue (D1, if approved);
      otherwise finished/stopped/none; busy during a run or compaction; recovery inside the preflight reservation
      (in `continueRun()`) or after `_isAgentRunActive` is set (at the top of `_startRun`)
- [x] C1.5b `/continue` recognised in `prompt()` first (also while streaming or compacting: refused as a notice,
      never thrown, never queued),
      print mode (stderr, exit 0 without the error-tail check) and RPC (`data`); `/continue <args>` refused; added to
      `BUILTIN_SLASH_COMMANDS` and roost's command table (`extensions/roost/commands.ts`)
- [x] C1.6 subagent: meta `callId` (the model-issued call, via `parentToolCallId` for scripts); `tool_result` handler
      adds the agentId line to an interrupted result and marks the record stopped; a test that a child exits when
      its parent dies
- [x] C1.7 docs: session-format, rpc, built-in command lists and README, extensions, sdk, subagent, porting
- [x] C1.8 by hand (in `decisions.md`), Haiku 5.5, sandbox: `kill -9` during a tool call → `/continue`; during a
      streaming reply → a message; during an Agent call
