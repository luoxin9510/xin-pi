# 03: Side model calls from extensions (`ctx.complete`)

Status: accepted (Grill 1, `decisions.md`). Ticket in `issues/`.

Origin: omp's judge and one-shot calls (a second model reviews, classifies or summarises; usage is journalled; retries
follow the error class). Needed by the planned advisor, auto-thinking and autolearn packages.

## Problem Statement

An extension can call a model today, but every one repeats the same boilerplate: find the model in `modelRegistry`,
check auth, build a user message with a timestamp, call `complete`, filter text blocks (see the summarize example).
Nothing handles retries, nothing validates a JSON answer, and the call's cost is invisible: the footer counts only
session entries, and an extension cannot write a usage entry.

## Solution

`ctx.complete({ model, prompt | messages, systemPrompt?, schema?, maxTokens?, signal?, purpose })` makes one side call
with the session's auth and providers. It returns the text, the validated value when a schema was given, the usage and
the model used; it retries transient errors and rate limits like the session does; it records the usage in the
session so the footer cost includes it; it throws an error with a kind (the same kinds as `errorKind`, plus `aborted`,
`no_model`, `no_auth`, `schema`).

## User Stories

1. As a package author, I want one call to ask a model something, so that my package is a few lines, not fifty.
2. As a package author, I want to name the model as `haiku`, `provider/id` or `inherit`, so that I do not look models up
   myself.
3. As the owner, I want shared model aliases in settings, so that "haiku" means the same thing in every package and in
   subagents.
4. As a package author, I want to pass a JSON schema and get a validated value, so that I can ask yes/no or pick-one
   questions safely.
5. As the owner, I want side calls to show up in the session's cost, so that a chatty advisor cannot hide its bill.
6. As the owner, I want side calls retried on transient errors and rate limits only, so that they behave like the main
   session.
7. As a package author, I want a typed error with a kind, so that I can fall back quietly when the side model is down.
8. As the owner, I want a side call stopped when the session is aborted, so that nothing keeps running after I press Esc.
9. As a package author, I want the call to work from commands and event handlers, not only during a run.

## Implementation Decisions

- Model reference: `inherit` (the session's model), an alias from `settings.models`, or a reference resolved by the
  existing model resolver. The subagent extension's alias table moves to the shared `settings.models` (Grill question
  11).
- Auth through the registry's request-time resolution, the same path compaction uses; no prompt caching (`cacheRetention`
  none) and a fresh session id per call, as compaction does.
- Schema: the prompt asks for JSON matching the schema; the answer is parsed and validated with the existing tool
  argument validator; on failure one or two retries quoting the validation error. No forced tool choice (rejected by
  current Claude models).
- Retries: the session's retry settings and the error-kind rules.
- Usage: a usage entry with kind `ext:<purpose>` for every billed attempt, failed or not.
- Cancellation: the caller's signal combined with the session's.

## Testing Decisions

- Faux-provider tests through an inline extension: text answer, schema answer valid on first and second try, schema
  failure error, transient retry, auth error kind, usage entry recorded and counted in totals, abort.
- Prior art: compaction's `completeSummarization` tests, `test/suite/` harness.

## Out of Scope

- Named model roles with fallback chains (`@judge`, `@smol`); the reference syntax leaves room for them.
- Answer caching.
- Streaming side calls.

## Further Notes

The `purpose` string is also what the footer and `/session` show for the cost line.
