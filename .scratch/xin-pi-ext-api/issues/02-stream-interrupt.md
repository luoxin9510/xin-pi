# 02: Stream interrupt

Spec: `../02-stream-interrupt.md`, decisions 6-8 in `../decisions.md`.

**What to build:** a `message_update` handler may return `{ interrupt: { inject } }`. The session aborts the current
request (not the run), hides the abandoned attempt from model context (kept in the session file), appends `inject` as
a hidden custom message and requests the same turn again. At most 3 interrupts per user prompt.

**Blocked by:** None (independent of 01; lands after it by the agreed order)

**Status:** ready-for-agent

- [ ] `message_update` handlers can return a result; the runner aggregates results like `message_end`; the first
      `interrupt` of an attempt wins, later updates of that attempt are ignored
- [ ] The session aborts the request without setting the run-abort flag (`_agentRunAbortRequested` stays false)
- [ ] Post-run handling, before the error-retry branch: hide the attempt and its tool results with the existing omit
      mechanism, append `inject` as a hidden custom message, continue the run
- [ ] Verified and tested: no tool call of the abandoned attempt starts
- [ ] Cap of 3 interrupts per user prompt; past it, interrupts are ignored and the stream finishes
- [ ] The abandoned attempt's usage stays in cost totals; the error-retry counter does not change
- [ ] An event or entry tells extensions an interrupt happened (name chosen in implementation, documented)
- [ ] Tests (faux provider, `test/suite/harness.ts`): retry happens; abandoned attempt in the session file but not in
      the next request; inject is in it; no tool of the attempt ran; cap holds; retry counter unchanged; cost includes
      both attempts; a user abort during the retry still ends the run
- [ ] Docs: `packages/xpi-coding-agent/docs/extensions.md` (`message_update` result, cap, cost), `docs/xin-pi.md`
- [ ] Real-model Haiku regression after merge (check OAuth expiry first)

## Comments
