# 03: `ctx.complete`

Spec: `../03-side-model-call.md`, decisions 9-12 in `../decisions.md`.

**What to build:** `ctx.complete({ model, prompt | messages, systemPrompt?, schema?, maxTokens?, signal?, purpose })`
makes one side call with the session's auth and providers and returns `{ text, value?, usage, model }`. It retries
`transient` and `rate_limit` with the session's retry settings, validates a JSON answer against `schema`, records a
usage entry `ext:<purpose>`, and throws errors with a kind.

**Blocked by:** None (lands after 02 by the agreed order)

**Status:** in review

- [x] Available on the extension context in commands and event handlers, not only during a run
- [x] Model reference: `inherit`, an alias from the new shared `settings.models`, or anything the existing model
      resolver accepts (`provider/id`, patterns)
- [x] `settings.models` in schema, defaults and settings manager; the subagent extension reads it after its own
      `subagent.models`, so existing settings keep working
- [x] Auth through the registry's request-time resolution (the compaction path); `cacheRetention` none; fresh session id
      per call
- [x] Schema: the prompt asks for JSON matching the schema; parse and validate with the existing tool-argument
      validator; up to 2 retries quoting the error; no forced tool choice
- [x] Errors throw with `kind`: the `errorKind` values plus `aborted`, `no_model`, `no_auth`, `schema`
- [x] Usage entry `ext:<purpose>` for every billed attempt, failed or not; footer and `/session` totals include it
- [x] Caller's signal combined with the session's abort
- [x] Tests (faux provider): text answer; schema valid first try and second try; schema failure error; transient retry;
      auth error kind; usage entry recorded and counted; abort; command context without a run
- [x] Docs: `packages/xpi-coding-agent/docs/extensions.md`, `docs/settings.md` (`models`), `docs/subagent.md` (alias
      lookup order), `docs/xin-pi.md`

## Comments

- `models` has no default entry in `SETTINGS_DEFAULTS`: an empty alias table is the default (`SettingsManager.getModelAliases()` returns `{}`). The subagent built-in aliases (haiku, sonnet, ...) are not applied to `ctx.complete`; define them in `models` to share them.
- Alias lookup in subagents: `{ built-in, models, subagent.models }`, later wins. A bad `models` value fails the subagent config at session start, naming `models.<alias>`.
- Usage entries show in footer and `/session` totals under the call model (provider/model), not under the purpose; the purpose is the entry `kind` (`ext:<purpose>`).
- Retry reuses `retryAssistantCall` (same policy and `retryAfterMs` rules as compaction); a stream function that throws instead of returning an error message is not caught (rethrown as is).
- `ExtensionContext.complete` is required (hand-built contexts in two tests needed it). Implementation: `src/core/side-call.ts`, `AgentSession.complete`. Tests: `test/suite/ctx-complete.test.ts` (20), `test/subagent/faults/model-aliases.test.ts` (4).
