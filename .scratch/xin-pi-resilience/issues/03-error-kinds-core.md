# 03: Error kinds, part 1: classifier, session, Anthropic and OpenAI family

Spec: `../03-error-kinds.md`, decisions 10-12 in `../decisions.md`.

**What to build:** a failed `AssistantMessage` from the Anthropic and OpenAI-family providers carries `errorKind`,
`errorStatus` (when HTTP) and `retryAfterMs` (when the provider sent one). The session's retry check, its overflow
check and the compaction/branch-summary retry read `errorKind` first and fall back to today's text rules when it is
absent. A retry-after replaces the computed backoff; one longer than `retry.maxAgentDelayMs` stops the session at once
with a message that gives the wait.

**Blocked by:** None (can start immediately)

**Status:** done (PR #30, merged 2026-11-10)

- [x] Optional fields on `AssistantMessage`: `errorKind` (`transient` | `rate_limit` | `usage_limit` |
      `context_overflow` | `auth` | `invalid_request` | `unknown`), `errorStatus`, `retryAfterMs`
- [x] One classifier module in xpi-ai: error class / `code` on the cause chain → status → provider error code in the
      body → text fallback (the existing retry, usage-limit and overflow tables move in, unchanged in content)
- [x] Anthropic and the OpenAI-family providers (completions, responses, azure responses) fill the fields in their
      error path; retry-after parsed from `retry-after-ms` / `retry-after`
- [x] Session: retry only `transient` and `rate_limit`; overflow decided by `context_overflow` first; `retryAfterMs`
      replaces backoff, longer than `retry.maxAgentDelayMs` → stop with the wait in the message; compaction and branch
      summary retry use the same check
- [x] Messages without `errorKind` (old sessions, other providers) behave exactly as today
- [x] The fields appear in `--mode json` output (they are on the message)
- [x] Tests: each kind from real error shapes of the converted providers (SDK error objects, HTTP responses, SSE error
      events); session retries transient and rate limit only; retry-after honoured and over-cap stop; every existing
      retry and overflow test passes unchanged
- [x] Docs: where retry settings and behaviour are described (`docs/settings.md`, any provider or SDK doc that lists
      `AssistantMessage` fields)

## Comments

2026-11-10: **overflow and usage-limit text outrank the status** (review): an OpenAI-compatible server that sends overflow text with a 500 or 429 is compacted, not retried, as with the old text rules.

**Behaviour change:** a non-5xx status whose text the old regexes would have retried (a 404 saying "timeout") is now `invalid_request` and not retried.

**An over-cap retry-after** ends the retry with `auto_retry_end` (`attempt: 0`, the wait in `finalError`).
