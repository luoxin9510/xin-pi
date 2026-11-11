# 01: Structured output (`schema` on an `Agent` call)

Status: done (2026-11-10, PR #10; owner approved Grill 1 on 2026-11-10)

## Problem

An `Agent` result's `output` is prose. A script that fans out agents and combines their answers has to parse prose or
ask for JSON and hope. Claude Code's `agent(prompt, { schema })` returns validated JSON and fails after 5 invalid
attempts.

## Facts this builds on

- Tool parameters in pi are any JSON Schema (`xpi-ai/src/utils/validation.ts`, `validateToolArguments`): arguments are
  coerced and validated, and a failure goes back to the model as the tool's error with the failing paths.
- A tool result may set `terminate: true`; the agent stops after the batch when every result in it says so
  (`xpi-agent-core/src/types.ts`).
- A child is an `xpi --mode rpc` process whose tool events the runner already reads (`subagent/runner.ts`); the child
  already gets one extra extension with `-e` (codemode in `only` mode, `subagent/resolve.ts`).

## Solution

`Agent({ ..., schema })`, where `schema` is a JSON Schema object with `type: "object"` at the top.

- The child gets one more tool, `StructuredOutput`, whose parameters are the schema. Its description: "Return the final
  result. Call it exactly once, as your last action." Its result sets `terminate: true`.
- The child's tail prompt gets one line: "Finish by calling the `StructuredOutput` tool with your result; do not write
  the result as text."
- The tool is a direct tool also for codemode-only children (it is listed next to `codemode`), so the final call is a
  normal tool call the runner sees in the event stream, not a call hidden inside a script.
- pi validates the arguments. An invalid call returns the validation error to the model, which calls again. The child
  extension counts invalid calls; after 5 the tool result says so and terminates.
- The runner takes the validated arguments of the accepted call from the event stream.

Result: `structured` (the validated value) is added to the `Agent` result, and `output` is its JSON text
(`JSON.stringify(value, null, 2)`), so code that only reads `output` keeps working.

Failures (the call returns, it does not throw; `status: "failed"`):

| Case | `error` |
|---|---|
| 5 invalid `StructuredOutput` calls | `structured output did not match the schema after 5 attempts: <last error>` |
| The agent ended without calling the tool | one automatic reminder turn ("Call StructuredOutput now with your result."); still none: `the agent ended without structured output`; `output` keeps its last text |
| `maxTurns` reached first | `partial`, as today, without `structured` |

Bad input throws, like other bad input: `schema` is not an object, is not `type: "object"`, or does not compile.

Other paths:

- `resume` with `schema`: allowed; the schema is per call, not stored.
- `run_in_background: true`: the end message carries the JSON text as its output.
- The user talking to the subagent on its screen: no `StructuredOutput` tool in those exchanges.
- Print mode: same as interactive.
- Prompt cache: the tool list is part of the prefix, so a child with a schema has its own prefix (same as a child
  with a `tools` list today). Stated in the docs; `prefixKey` includes the schema's hash.

## Out of scope

Streaming partial structured output; schemas with a non-object root; a schema in the agent file (per-call only).

## Testing

- Offline (`npm run test:subagent`, fake child): result has `structured` and JSON `output`; invalid then valid call;
  5 invalid calls; no call then reminder then call; no call twice; bad schema throws; `resume` with and without schema;
  background end message; `prefixKey` differs with a schema.
- Real, by hand (haiku, `test:subagent:real`): an Explore agent returns `{ files: string[], summary: string }` for a
  small temp repo; a codemode-only child and a `codemode: false` child both finish with the tool.
- Evals: one case added to `test:subagent:evals` (main writes a script that uses `schema` and reads `structured`).

## Tickets (after approval)

1. Tracer: child extension with the tool, runner picks up the accepted call, `structured` in the result (fake child + one real run).
2. Failure paths: invalid-call limit, reminder turn, bad schema, `maxTurns`.
3. Background, resume, prefix key, tool description for main, docs, eval case.
