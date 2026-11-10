# 03: `ctx.complete`

Spec: `../03-side-model-call.md`, decisions 9-12 in `../decisions.md`.

**What to build:** `ctx.complete({ model, prompt | messages, systemPrompt?, schema?, maxTokens?, signal?, purpose })`
makes one side call with the session's auth and providers and returns `{ text, value?, usage, model }`. It retries
`transient` and `rate_limit` with the session's retry settings, validates a JSON answer against `schema`, records a
usage entry `ext:<purpose>`, and throws errors with a kind.

**Blocked by:** None (lands after 02 by the agreed order)

**Status:** ready-for-agent

- [ ] Available on the extension context in commands and event handlers, not only during a run
- [ ] Model reference: `inherit`, an alias from the new shared `settings.models`, or anything the existing model
      resolver accepts (`provider/id`, patterns)
- [ ] `settings.models` in schema, defaults and settings manager; the subagent extension reads it after its own
      `subagent.models`, so existing settings keep working
- [ ] Auth through the registry's request-time resolution (the compaction path); `cacheRetention` none; fresh session id
      per call
- [ ] Schema: the prompt asks for JSON matching the schema; parse and validate with the existing tool-argument
      validator; up to 2 retries quoting the error; no forced tool choice
- [ ] Errors throw with `kind`: the `errorKind` values plus `aborted`, `no_model`, `no_auth`, `schema`
- [ ] Usage entry `ext:<purpose>` for every billed attempt, failed or not; footer and `/session` totals include it
- [ ] Caller's signal combined with the session's abort
- [ ] Tests (faux provider): text answer; schema valid first try and second try; schema failure error; transient retry;
      auth error kind; usage entry recorded and counted; abort; command context without a run
- [ ] Docs: `packages/xpi-coding-agent/docs/extensions.md`, `docs/settings.md` (`models`), `docs/subagent.md` (alias
      lookup order), `docs/xin-pi.md`

## Comments
