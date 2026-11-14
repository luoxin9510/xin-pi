# Decisions: relay roles, codemode-only hand tools, and a state machine

Reported by the owner (2026-11-15): with `relay/auto`, after a handover or a hand back the model sometimes mixes up
its role and stops.

Causes found in the code (author):

- Both models get the same system prompt, which says "You are the lead model" (`leadFacts`, passed as the `handover`
  tool's `promptGuidelines`). The worker is told it is the worker only in the `handover` tool result.
- Both tools are in both models' tool lists. A wrong-role call fails ("Only the lead hands over...") and a model often
  ends its turn after such an error: a worker's end counts as a hand back, a lead's end just stops.

## Grill 1 (2026-11-15). Accepted by the owner on 2026-11-15 ("都按照推荐")

1. A role-specific system prompt per request (`context_with_system`): the lead gets the decision facts, the worker its
   own brief and no mention of being the lead. The two are different physical models with separate prompt caches, so
   this costs no cache.
2. `handover` and `handback` are called only from codemode (`exposure: "codemode"`). Two seams make that work: the
   router learns of a phase change from a marker message relay writes, not from a tool result named `handover`; and a
   nested call's `terminate` ends the script and the turn (a codemode feature for every tool).
3. With codemode off (`-codemode`), the two tools fall back to direct tools and `/relay` says so.
4. A direct call of a tool that is only exposed through codemode (here `handover(...)` called directly) is run by
   xpi as a nested call, through the same pipeline and hooks, with a note in the result to call it from codemode next
   time; no extra request. A core feature for every codemode-only tool (MCP tools too).
5. A wrong-role call is blocked by a hook with a short role correction; the second one in the same phase hands back
   for the model (`blocked`, the report says the roles were mixed up).
6. A turn that ends right after a relay tool error is continued automatically with a role reminder, at most twice,
   then 5 applies. A lead that answers with text in its review is a normal end.

## Grill 2 (2026-11-15). Accepted by the owner on 2026-11-15 ("都按照推荐")

7. Each role sees only its own tool: the lead's prompt names `tools.handover`, the worker's `tools.handback`, each with
   its usage. The two tools are left out of codemode's own tool listing.
8. The role prompt is one short section; the lead's decision facts go with `handover`'s usage, the worker's duties
   with `handback`'s. No "you are the worker" message is inserted into the conversation at a handover.
9. `/model` to another model during a worker phase pauses the relay; back on `relay/auto` the worker continues, with
   a notification `relay paused (worker phase, round N)`. The other model sees neither relay tools nor role text.
10. `handover` and `handback` stop the script at once; other calls of the same response finish; the new role answers
    the next request.
11. A second `handover`/`handback` in the same turn is not run and answers "already handed over/back", no error and
    not counted as a mix-up. `/handback` while the worker calls `handback`: one hand back, with the worker's report and
    the acceptance commands skipped as the user asked.
12. A handover counts once its tool result is written; Esc or an error before that leaves the phase as it was. An
    ordinary compaction in a worker phase keeps the phase: it lives in the router state on the branch, and the role
    prompt is built from that state.

## Grill 3 (2026-11-15). Accepted by the owner on 2026-11-15 ("都按照推荐")

13. Relay's control flow becomes one explicit transition table, a pure function `transition(state, event) ->
    { next, effects }`, with states `lead`, `worker`, `verifying`, `paused` and events for the hand tools, acceptance
    results, `/model`, the commands, wrong-role calls and repeated calls. Decisions 9-12 are rows of it; every
    (state, event) pair has a test. Not a user-configurable graph: multi-agent graphs belong to workflows.

## Purpose (owner, 2026-11-15)

"Relay mode is for transparency, observability and saving money. For an orchestrator over several agents we have
workflows." The spec adds an observability section from this: every transition and every repair leaves a visible
line and an entry, and `/relay` and the record show them.
