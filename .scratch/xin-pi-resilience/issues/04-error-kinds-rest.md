# 04: Error kinds, part 2: Google, Bedrock, Codex and the rest

Spec: `../03-error-kinds.md`, decision 12 in `../decisions.md`.

**What to build:** every remaining provider fills `errorKind`, `errorStatus` and `retryAfterMs`, and the provider-local
special cases that existed only to feed the text rules are deleted: the Codex copies of the retry and usage-limit
patterns, and Bedrock's rewriting of exception names into text (Bedrock throttling no longer looks like overflow).

**Blocked by:** 03 (Error kinds, part 1)

**Status:** done

- [x] Google (all Google APIs through the shared helper), Bedrock (by exception name), Codex responses, and every other
      provider with an error path fill the fields
- [x] Codex: its own retry loop decides by `errorKind`; its local regexes are removed
- [x] Bedrock: exception-name prefix rewriting removed; `ThrottlingException` is `rate_limit`, never overflow
- [x] The remaining text table has one comment per group saying why it must stay (mid-stream errors in a 200 stream,
      network errors without a code, overflow as free-text 400)
- [x] Tests: each converted provider's real error shapes → kind; the Bedrock "Too many tokens" throttling case; all
      existing tests pass
- [x] Docs updated where they mention provider-specific retry behaviour

## Comments

- Providers converted: Google and Vertex (status from the SDK `ApiError`), Bedrock (exception name), Codex, Mistral
  (`MistralHttpError` now keeps the response headers for `retry-after`), pi-messages (`PiMessagesResponseError` keeps
  status and headers; a relayed `error` event is classified by its text). The image and classifier endpoints
  (`openrouter-images`, `llama-cpp-classify`, `system-one-shared`, `openai-decisions`) return their own output types, not
  an `AssistantMessage`, so they have no error fields to fill.
- Bedrock: `BEDROCK_ERROR_PREFIXES` is gone; the message now starts with the raw exception name
  (`ThrottlingException: ...`, `ValidationException: ...`), so two existing assertions on the old prefixes changed
  (`bedrock-error-metadata`, `bedrock-strict-tool-fallback`). The classifier got an exception-name step before the
  status and text steps. `ValidationException` is `invalid_request` unless its text says overflow.
- The `^(Throttling error|Service unavailable):` entry in the overflow exclusion list stays for old sessions without a
  kind; it is commented as such.
- Codex: the retry loop now decides by kind in one place. Behaviour change: a non-retryable HTTP failure (for example
  a 400) is no longer retried as if it were a network error; a retry delay above `maxRetryDelayMs` keeps its status
  and wait on the error so the final message is still `rate_limit` with `retryAfterMs`.
- `usage_limit_reached` and `usage_not_included` (Codex body codes) were added to the provider-code table.
