# 02: Stream interrupt

Spec: `../02-stream-interrupt.md`, decisions 6-8 in `../decisions.md`.

**What to build:** a `message_update` handler may return `{ interrupt: { inject } }`. The session aborts the current
request (not the run), hides the abandoned attempt from model context (kept in the session file), appends `inject` as
a hidden custom message and requests the same turn again. At most 3 interrupts per user prompt.

**Blocked by:** None (independent of 01; lands after it by the agreed order)

**Status:** done (PR #35, merged 2026-11-10)

- [x] `message_update` handlers can return a result; the runner aggregates results like `message_end`; the first
      `interrupt` of an attempt wins, later updates of that attempt are ignored
- [x] The session aborts the request without setting the run-abort flag (`_agentRunAbortRequested` stays false)
- [x] Post-run handling, before the error-retry branch: hide the attempt and its tool results with the existing omit
      mechanism, append `inject` as a hidden custom message, continue the run
- [x] Verified and tested: no tool call of the abandoned attempt starts
- [x] Cap of 3 interrupts per user prompt; past it, interrupts are ignored and the stream finishes
- [x] The abandoned attempt's usage stays in cost totals; the error-retry counter does not change
- [x] An event or entry tells extensions an interrupt happened (name chosen in implementation, documented)
- [x] Tests (faux provider, `test/suite/harness.ts`): retry happens; abandoned attempt in the session file but not in
      the next request; inject is in it; no tool of the attempt ran; cap holds; retry counter unchanged; cost includes
      both attempts; a user abort during the retry still ends the run
- [x] Docs: `packages/xpi-coding-agent/docs/extensions.md` (`message_update` result, cap, cost), `docs/xin-pi.md`
- [x] Real-model Haiku regression after merge (check OAuth expiry first)

## Comments

- Event name: `stream_interrupted`, both an extension event (`pi.on("stream_interrupted")`) and an `AgentSessionEvent`
  (json/rpc/subscribe), fields `message`, `inject`, `count`, `limit`.
- Request-only abort needed a small `xpi-agent-core` change: each request gets its own `AbortController` linked to the
  run signal, exposed through `AgentLoopConfig.onRequestStart(abortRequest)`. The session never touches
  `_agentRunAbortRequested`.
- Handled in `AgentSession._handlePostAgentRun` before the error-retry branch (`_retryAfterStreamInterrupt`): omit via
  `_omitRecoveryAttempt`, hidden custom message `stream_interrupt`, `agent.continue()`.
- Tool calls cannot start: the loop runs tools only after the assistant message ends and an `aborted` result ends the
  loop first. Extra guard: if a provider completes a request that was aborted alone, the loop rewrites `stopReason` to
  `aborted`. Tested for an early interrupt and for one on the last event (`toolcall_end`).
- Count resets at each user `message_start` and at each run start; the cap counts per user prompt.
- Faux aborted messages carry zero usage, so the cost test sets usage on the aborted message in a `message_end` handler.
- Tests: `packages/xpi-coding-agent/test/suite/stream-interrupt.test.ts`.

2026-11-10: real-model Haiku regression on main 8901b7eb4: `test:subagent:real` 91/91, `:parent` 12/12, `:tui` 16/16.
