# 04: Error kinds, part 2: Google, Bedrock, Codex and the rest

Spec: `../03-error-kinds.md`, decision 12 in `../decisions.md`.

**What to build:** every remaining provider fills `errorKind`, `errorStatus` and `retryAfterMs`, and the provider-local
special cases that existed only to feed the text rules are deleted: the Codex copies of the retry and usage-limit
patterns, and Bedrock's rewriting of exception names into text (Bedrock throttling no longer looks like overflow).

**Blocked by:** 03 (Error kinds, part 1)

**Status:** ready-for-agent

- [ ] Google (all Google APIs through the shared helper), Bedrock (by exception name), Codex responses, and every other
      provider with an error path fill the fields
- [ ] Codex: its own retry loop decides by `errorKind`; its local regexes are removed
- [ ] Bedrock: exception-name prefix rewriting removed; `ThrottlingException` is `rate_limit`, never overflow
- [ ] The remaining text table has one comment per group saying why it must stay (mid-stream errors in a 200 stream,
      network errors without a code, overflow as free-text 400)
- [ ] Tests: each converted provider's real error shapes → kind; the Bedrock "Too many tokens" throttling case; all
      existing tests pass
- [ ] Docs updated where they mention provider-specific retry behaviour
