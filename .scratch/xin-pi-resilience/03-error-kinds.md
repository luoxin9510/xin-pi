# 03: Classify provider errors once, retry by kind

Status: approved (Grill 1, `decisions.md`, 2026-11-10). Tickets in `issues/`.

Origin: the omp study (`~/Developer/omp-study/09-对比-xpi/xpi可借鉴清单.md`, item 3). omp classifies every provider
error once into bit flags (`errorId`) from the error class, the status code and, last, the text; every retry layer
reads the flags.

## Problem Statement

A provider error reaches the agent as a string. `AssistantMessage` has `stopReason: "error"` and `errorMessage`, and
nothing else: the status code is formatted into the text and dropped, and `retry-after` never reaches the session. So
the session-level retry and the overflow check decide by matching text against two large regex tables (about 70
retry patterns and 30 overflow patterns), the Codex provider keeps its own copies of some of them, and Bedrock rewrites
its exception names into text so the regexes can find them. Every new provider message means a new pattern, and a
pattern can match the wrong kind of error (Bedrock throttling text contains "Too many tokens").

## Solution

Each provider fills structured error fields on the failed message: a kind, the HTTP status when there is one, and the
retry-after delay when the provider sent it. The kind comes from the error class and status first; text matching
stays only as the fallback for errors that carry nothing else (mid-stream failures, network errors without a code,
overflow messages behind a plain 400). The session's retry decision, its overflow check and the compaction retry read
the kind. Messages without the fields (old sessions, providers not yet converted) go through today's text rules.

## User Stories

1. As the owner, I want retries decided by what kind of error happened, so that a new error text does not need a new
   regex.
2. As the owner, I want rate limits to wait as long as the provider asked, so that the session does not retry too early
   and fail again.
3. As the owner, I want a usage-limit error (quota spent) not retried like a rate limit, so that the session stops
   instead of looping.
4. As the owner, I want context overflow told apart reliably from other 400 errors, so that compaction runs when it
   should and not otherwise.
5. As the owner, I want authentication failures not retried, so that I see "log in again" at once.
6. As the owner, I want old sessions and unconverted providers to keep working, so that the change is safe to ship in
   parts.
7. As the owner, I want the kind visible in the message (and in `--mode json`), so that I can see why something was or
   was not retried.
8. As a maintainer, I want one place that maps provider errors to kinds, so that the Codex and Bedrock special cases
   disappear.
9. As a maintainer, I want the remaining text patterns in one table with a comment on why each must stay, so that
   nobody adds one without a reason.
10. As an extension author, I want the kind on the message, so that my extension can react to errors without parsing
    text.

## Implementation Decisions

- New optional fields on the failed `AssistantMessage` in xpi-ai: `errorKind`, `errorStatus`, `retryAfterMs`.
- Kinds (proposed, Grill question): `transient` (5xx, timeouts, network), `rate_limit` (429 and equivalents),
  `usage_limit` (quota or plan limit spent), `context_overflow`, `auth`, `invalid_request` (other 4xx, not retried),
  `unknown`.
- One classifier module in xpi-ai, used by every provider's catch path. Order: error class or `code` on the cause
  chain → status code → provider error code in the body → text fallback (today's tables, moved in).
- The session's retry check reads `errorKind`; `transient` and `rate_limit` retry; `retryAfterMs`, when present,
  replaces the computed backoff (capped by the existing `maxAgentDelayMs`). The overflow check reads
  `context_overflow` first, text second. The compaction/branch-summary retry uses the same check.
- Messages without `errorKind` use today's functions unchanged.
- Rollout order: classifier + fields + session reading them, then convert providers in order of use (Anthropic, the
  OpenAI family, Google, Bedrock, Codex); each conversion deletes its local special cases.

## Testing Decisions

- Good tests feed a provider's real error shapes (SDK error objects, HTTP responses, SSE error events) and assert on
  the resulting message fields and on whether the session retried, never on regex internals.
- Prior art: `xpi-ai/test/retry.test.ts` and `overflow.test.ts` (real error texts as constants; they become the
  fallback's tests), `provider-retry.test.ts`, `bedrock-error-metadata.test.ts`, `error-body.test.ts`;
  `xpi-coding-agent/test/agent-session-retry.test.ts` with `createHarness` and the `suite/regressions/*retry*` tests.
- Every existing retry/overflow test must pass unchanged: they are the compatibility proof.

## Out of Scope

- Credential pools, account rotation, model fallback chains (omp layers 3 and 4 beyond plain retry).
- Changing retry counts or defaults.
- Persisted sessions rewritten with kinds.

## Further Notes

Text matching cannot go entirely: errors inside a 200 SSE stream, network errors without a code, and most overflow
messages (a 400 with free text) carry nothing else. The goal is that text is the last step, in one table, not the
only signal.
