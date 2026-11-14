# Tickets: spec 01, relay roles

Spec: `.scratch/xpi-relay-roles/01-relay-roles.md`. One PR (branch `relay-roles`): independent Opus review, green CI,
the docs, the real Haiku runs before merge.

- [x] R1 `machine.ts`: the transition table and `Effect`s; a test for every (state, event) pair
      Done: extensions/relay/machine.ts (`transition`, `Effect`s, `RelayView`); test/relay-machine.test.ts covers every view with every event (13 views x 14 events) and each row.
- [x] R2 codemode seam B: a nested `terminate` ends the script and the codemode call; tests
      Done: extensions/codemode/execute.ts (the sandbox is stopped through an abort signal of its own; the result is treated as a normal end and ends with the call's text, outside the truncation); test/suite/codemode-terminate.test.ts.
- [x] R3 codemode seam A: `listed: false` keeps a deferred tool out of `searchTools()`, `describeTool()` and `ALL_TOOLS`,
      still callable; tests
      Done: `ToolDefinition.listed`, `ToolInfo.listed`, `ToolLoadout.isListed`, the `unlisted` flag of `CodemodeTool` in xpi-codemode (also out of `ALL_TOOLS`), and `tool_search`; tests in suite/codemode-terminate.test.ts and xpi-codemode test/sandbox.test.ts.
- [x] R4 core seam C: a direct call of a codemode-only tool runs as a nested call with a note; tests in the loop and a
      suite test
      Done: `AgentLoopConfig.resolveUndeclaredTool` (agent-core), set by `AgentSession` for `codemode` and `deferred` tools; tests in agent-loop.test.ts and suite/codemode-terminate.test.ts.
- [x] R5 relay on the machine: the marker as the last line of the tool result, the pending-hand-off view, codemode exposure with the direct
      fallback, entries for mixups/stalls/pause, `agent_before_settle` through the machine, commands through the
      machine
      Done: extensions/relay/index.ts, view.ts, router.ts: the last-line marker rule, `readView` (pending hand-off), deferred unlisted tools with the direct fallback re-registered on change, the entries, `agent_before_settle`, `/handover`, `/handback`, `/relay` and the pause all through `transition()`.
- [x] R6 role prompts: the `context_with_system` handler and the `relay` section per role; neutral tool descriptions
      Done: extensions/relay/prompts.ts and the `context_with_system` handler in index.ts: one `relay` section per role from the stored router state; role-neutral tool texts; no `promptGuidelines`, no `tell()`.
- [x] R6b observability: `relay.transition` entries, a visible line per transition and repair, `/relay` history and
      spend, repairs in the record
      Done: `relay.transition` entries (written when the state changes: at the request after a handover, and where the record is made) and notifications; a line and an entry for each repair; `/relay` lists the round and the spend; the record has the round's repairs.
- [x] R7 suite tests of the spec's list
      Done: test/suite/relay.test.ts (23 tests, faux provider, both codemode on and off); test/relay-machine.test.ts; router tests in the suite file.
- [x] R8 docs: `relay.md`, `codemode.md`, `extensions.md`, `porting.md`, `xin-pi.md`, READMEs
      Done: docs/relay.md, codemode.md, extensions.md, porting.md, docs/xin-pi.md, the READMEs of the repository, coding-agent, agent-core and xpi-codemode where they describe the touched parts.
- [ ] R9 real runs (the lead runs them): `npm run test:relay:real`, and a Haiku-lead session across a handover and a
      hand back

## Deviations

- `transition()` returns `next: RelayView` (the view with the stored state plus mixups, stalls, pause, pending hand-off),
  a superset of the spec's `RelayState`; "pending worker, round+1" is `effectiveState(next)`.
- One row is added to the table: `lead | run_end with a pending handover` continues, so the worker answers. The spec makes
  `handover` terminate the turn, so the run ends and only the settle can start the worker. Without it nothing would.
- `acceptance.attempt` is the number of failures before this run (0 on the first), so `attempt < maxRounds` keeps the
  old behaviour (`maxRounds: 1` sends one failure back to the worker).
- Added effects and entries: `continue_with` kind `worker_starts`, an effect `steer` for `/handback`, `notify` lines,
  and a `relay.direct` entry for a repaired direct call (the record and `/relay` need to list it). The `/handback` flag
  stays in memory, as before.
- Seam B: a tool's `execute` returns `CodemodeExit` (xpi-codemode) and the VM ends the script like `exit()` right after
  the call, so output and `store()` writes are kept (review round 1). Calls the script started and did not await are
  cancelled, unless an add-on lets them outlive the script, as at `exit()`.
- `relay.transition` for lead -> worker is written in `route()` at the request where the stored state changes, not at
  the handover call: an entry at the call would clear the pending hand-off the second call must see. Hand backs write it
  where the record is made.
- A user message entry after a `relay.handover` or `relay.handback` entry clears the pending hand-off (a hand-off whose
  response was cut short by Esc or an error did not happen), which the spec's rule alone would keep pending.
- The repair list of a record runs from the previous hand back, so a direct `handover(...)` call (which is written
  before the handover entry) belongs to the round it starts; repairs of the lead before its first handover are listed
  in that record too.
- `listed: false` also hides the tool from `tool_search` and `pi.getAllTools()` reports it (`listed: false`);
  `ToolLoadout.isListed` is new.
- Print mode: the lines go to stderr when `--verbose` is in `process.argv` (the flag is not visible to extensions).
- Tests changed because behaviour changed: suite/agent-session-mcp.test.ts "rejects direct model calls to codemode-only MCP
  tools" (now "runs ... as nested calls, with a note": that is seam C for MCP tools; an unknown name still fails), the tool-list test (tools are direct only in the fallback), the first flow
  test (no worker message at a handover; the role is in the system section), "refuses a handback from the lead..."
  (replaced by the correction and blocked-hand-back tests), the `nextState` test (a handover is a marker as the last line).
  `leadFacts()` lost its first sentence ("Relay mode. You are the lead model (...)"): the section's own line says it.
- Not run (as told): `npm test`, `test:relay:real`, `eval:delegation`. The real-model prompt of
  `test/relay/real.test.ts` still says "with the handover tool"; the lead's section names `tools.handover`.

## Review round 1

- An unawaited or cut-off `tools.handover` no longer leaves the lead in a continue loop: `execute` checks the call's
  signal after the snapshot and writes nothing when it was aborted; at the end of a lead run the worker starts only if a
  tool result really ends with the marker of the next round (`handoverLanded`), otherwise a `relay.void` entry clears
  the pending hand-off and a line says so. This adds an entry kind and a `handoverLanded` field on `run_end`.
- "Already handed over/back." is worded from what is pending (`view.pending`), not from the event.
- Seam C resolves tools only while `codemode` is an active tool; with codemode off a direct call is "not found".
- `relay.direct` labels the role with the stored phase. The notify line says "run as a codemode call".
- `route()` resolves the worker model before it records the lead -> worker transition.
- The blocked flag comes from the latest `relay.handback` entry even after a user message cleared the pending state.
- `endedAfterRelayError` ignores custom entries (such as `codemode-store`) between the mixup and the end of the turn.
- `agent-session.ts` imports `toCodemodeIdentifier`. The real-model prompt names `tools.handover`; it was not run.
