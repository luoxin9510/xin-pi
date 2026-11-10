# 03: Error kinds, part 1: classifier, session, Anthropic and OpenAI family

Spec: `../03-error-kinds.md`, decisions 10-12 in `../decisions.md`.

**What to build:** a failed `AssistantMessage` from the Anthropic and OpenAI-family providers carries `errorKind`,
`errorStatus` (when HTTP) and `retryAfterMs` (when the provider sent one). The session's retry check, its overflow
check and the compaction/branch-summary retry read `errorKind` first and fall back to today's text rules when it is
absent. A retry-after replaces the computed backoff; one longer than `retry.maxAgentDelayMs` stops the session at once
with a message that gives the wait.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] Optional fields on `AssistantMessage`: `errorKind` (`transient` | `rate_limit` | `usage_limit` |
      `context_overflow` | `auth` | `invalid_request` | `unknown`), `errorStatus`, `retryAfterMs`
- [ ] One classifier module in xpi-ai: error class / `code` on the cause chain → status → provider error code in the
      body → text fallback (the existing retry, usage-limit and overflow tables move in, unchanged in content)
- [ ] Anthropic and the OpenAI-family providers (completions, responses, azure responses) fill the fields in their
      error path; retry-after parsed from `retry-after-ms` / `retry-after`
- [ ] Session: retry only `transient` and `rate_limit`; overflow decided by `context_overflow` first; `retryAfterMs`
      replaces backoff, longer than `retry.maxAgentDelayMs` → stop with the wait in the message; compaction and branch
      summary retry use the same check
- [ ] Messages without `errorKind` (old sessions, other providers) behave exactly as today
- [ ] The fields appear in `--mode json` output (they are on the message)
- [ ] Tests: each kind from real error shapes of the converted providers (SDK error objects, HTTP responses, SSE error
      events); session retries transient and rate limit only; retry-after honoured and over-cap stop; every existing
      retry and overflow test passes unchanged
- [ ] Docs: where retry settings and behaviour are described (`docs/settings.md`, any provider or SDK doc that lists
      `AssistantMessage` fields)
