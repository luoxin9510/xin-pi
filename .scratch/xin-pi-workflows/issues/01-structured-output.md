# 01: Structured output (`schema` on an Agent call)

Spec: `../01-structured-output.md`. One ticket: the three planned tickets (tracer, failure paths, the rest) were small
enough to land together.

**Status:** done (2026-11-10), branch `subagent-structured-output`

- [x] Child: `StructuredOutput` tool (`model-only`, parameters = the schema, `terminate: true`), registered by the subagent
      extension in the child when `XPI_SUBAGENT_SCHEMA_FILE` is set (`structured-output.ts`, `index.ts`)
- [x] Resolve: the tool joins `--tools` (`+codemode,+StructuredOutput`, an agent's list, or `+StructuredOutput`), one line
      at the end of the tail, the schema in `prefixKey` (`resolve.ts`)
- [x] Runner: accepted call -> `structured` and JSON `output`; 5 invalid calls -> failed + child stopped; no call -> one
      reminder prompt, then failed; a valid call in the last allowed turn is completed, not partial (`runner.ts`)
- [x] Agent tool: `schema` parameter, `structured` in the result, schema checked before a child starts; main's tool
      description mentions `schema` (`agent-tool.ts`)
- [x] Offline tests: `test/subagent/faults/structured-output.test.ts` (13); fake child replays a second prompt and records
      the schema file
- [x] Real, haiku: `test/subagent/real/17-structured-output.test.ts`, codemode-only and direct-tools children (3 runs, 2/2
      each, about $0.0003 a run)
- [x] Evals: "schema returns a value" (direct) and "parent asks for a structured result" (main uses `schema` on its own),
      3/3 each
- [x] `docs/subagent.md`: Structured output section, input and result

## Comments

2026-11-10: **The schema check had to go beyond the validator.** pi's `compile` accepts almost any schema (it must take
MCP servers' schemas): `properties: 5` or `required: "x"` compile. `checkSchema` therefore checks the top level itself
(object, `type: "object"`, `properties` an object of schemas, `required` a list of names, no required name that
`additionalProperties: false` excludes, which is the case Claude Code's docs name). Nested mistakes surface as failed
attempts.

**Exposure.** `model-only` keeps the tool visible to a codemode-only child: codemode's `only` mode hides declared
`direct` tools, not `model-only` ones. Verified on haiku: a codemode-only child is offered exactly `codemode` and
`StructuredOutput`.

**Two test-side mistakes, not product bugs:** the real test first counted the probe extension's own `.ts` file, and the
first eval expected relative paths while Explore returned absolute ones.
