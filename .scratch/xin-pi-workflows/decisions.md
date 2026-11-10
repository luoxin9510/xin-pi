# Decisions

## Grill 1 (2026-11-10): all 11 accepted by the owner on 2026-11-10

The owner asked for the two unverified facts of `02-workflows.md` to be checked first; both were (see its Verified
facts). One consequence, within decision 5 (Claude Code's names and semantics): a saved workflow starts with
`export const meta = { name, description }`, Claude Code's format, not a description comment.

Structured output (`01-structured-output.md`)

1. Mechanism: a `StructuredOutput` tool in the child whose parameters are the schema (pi validates, the model retries
   inside its own run), not parsing the last message in the parent.
2. Result: `structured` holds the value and `output` its JSON text; a schema failure returns `status: "failed"` instead of
   throwing; 5 invalid attempts, and one automatic reminder turn when the agent ends without the call.
3. The schema is per call only (no `schema` field in agent files).

Workflows (`02-workflows.md`)

4. A workflow is a saved codemode script: `.pi/workflows/<name>.js` and `~/.pi/agent/workflows/<name>.js`, run as
   `/name args`, started directly as a background script with no model turn.
5. Helpers `agent`, `parallel`, `pipeline`, `phase`, `log`, `args` with Claude Code's names and semantics, available in
   every codemode script, not only in saved workflows.
6. Saving: `s` on a script row in the panel; the model runs saved workflows through a `Workflow` tool.
7. A hard cap of 1000 agents per script run.
8. Left for later specs: pause/resume, restart one agent, relaunch with saved results, `/deep-research`, reading
   `.claude/workflows/`, the size warning.

Names and messages (`03-names-and-messages.md`)

9. `name` is unique per session and also accepted by `resume`.
10. `SendMessage` to a running agent is a steer that returns at once; to a finished one it continues the agent like
    `resume`. No agent-to-agent messages.

Order

11. Specs for fork and for the inert agent-file fields are written after 1-3 have landed.
