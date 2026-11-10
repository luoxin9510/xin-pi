# 02: Interrupt a streaming response and retry the turn

Status: accepted (Grill 1, `decisions.md`). Ticket in `issues/`.

Origin: omp's time-traveling stream rules (TTSR): a rule sits dormant until the model's output matches its pattern;
then the stream is aborted, the rule is injected as a reminder, and the turn is requested again. The rule costs context
only when it is broken.

## Problem Statement

An extension sees the model's output as it streams (`message_update`) but cannot act on it well. `ctx.abort()` ends the
whole run, not the request, so there is no way to say "stop this attempt, add this reminder, try again". Composing it
from today's API (abort, then `sendMessage` with `triggerTurn` after the run ends) is fragile: the abort flag ends the
run, the aborted attempt's tool results are left for the extension to clean up, and `triggerTurn` is delayed while the
session settles.

Keeping the partial output and asking the model to continue is not an option on Claude: a request that ends with an
assistant message (prefill) returns 400 on every current Claude model.

## Solution

A `message_update` handler may return `{ interrupt: { inject } }`. The core then aborts the current request (not the
run), hides the abandoned attempt from model context (it stays in the session file, as overflow recovery already does),
appends `inject` as a hidden custom message, and requests the same turn again. A package such as a stream-rules package
needs nothing else.

## User Stories

1. As a package author, I want to stop the model mid-stream when its output matches a rule, so that a bad answer is
   not finished and paid for in full.
2. As a package author, I want to give the model a reminder and have it retry the same turn, so that the user sees a
   corrected answer without typing anything.
3. As the owner, I want the abandoned attempt kept in the session file, so that `/tree` and export show what happened.
4. As the owner, I want the abandoned attempt hidden from the model, so that the retry is not anchored on the bad
   output.
5. As the owner, I want a limit on interrupts per prompt, so that two rules that keep triggering cannot loop forever.
6. As the owner, I want the abandoned attempt's cost counted, so that the footer stays honest.
7. As the owner, I want an interrupt not to count as an error retry, so that retry limits keep their meaning.
8. As a package author, I want to know the interrupt happened (an event or entry), so that I can show it in the UI.
9. As the owner, I want tool calls from the abandoned attempt never to run, so that an interrupted attempt has no side
   effects.

## Implementation Decisions

- `message_update` handlers can return a result; the session aggregates them like `message_end` results. The first
  `interrupt` wins for that attempt; later updates of the same attempt are ignored.
- The session aborts the agent's request without setting the run-abort flag, then, in the post-run handling before the
  error-retry branch: hides the attempt and its tool results (the existing omit mechanism), appends `inject` as a hidden
  custom message, and continues the run.
- Discard only: the partial output is never sent back.
- A cap on interrupts per user prompt (Grill question 7); past it, interrupts are ignored and the stream finishes.
- The abandoned attempt keeps its usage on the aborted message, so cost totals include it; the retry counter does not
  change.
- Must be verified: that no tool call of the attempt starts before the stream ends.

## Testing Decisions

- Session-level tests with the faux provider streaming a response that an inline extension interrupts: the retry
  happens, the abandoned attempt is in the session file but not in the next request's messages, the inject is, no tool
  of the attempt ran, the cap holds, the retry counter is unchanged, the cost includes both attempts.
- Prior art: `test/suite/` harness tests for retry and overflow recovery (`_omitRecoveryAttempt` paths).

## Out of Scope

- The stream-rules package itself (rule files, matching, once-per-rule).
- Keeping the partial output (prefill).
- Interrupting from `tool_call` (it can already block with a reason).

## Further Notes

The reminder goes in as a custom message, the same channel extensions use today; a mid-conversation `system` role would
keep the cache slightly better on some Claude models but is model-gated, so it is not used.
