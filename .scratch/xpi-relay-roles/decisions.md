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

"Relay happens in one session, so the lead's and the worker's work both leave a trace." The spec states it as a
constraint: nothing leaves the session, and the compaction changes only what the lead reads.

## Grill 4 (2026-11-16): the lead's work as a quote. Accepted by the owner on 2026-11-16 ("按照你的推荐就可以了")

Root cause: after a handover the worker's request still holds the lead's replies as `assistant` messages, which a model
reads as its own words. The prompt sentence and the idle-stall repair (Grill 3 notes) only make up for it.

14. Every worker request is rewritten in `context_with_system`: all messages up to the handover (the lead's text, its
    tool calls and their results, user messages, earlier records) become one user message, a quote marked
    `<relay-lead-work>` with the lead's parts named. The worker's own messages after the handover are sent as they are.
    The session is not changed. No core change: the hook already exists, and relay uses it for its section.
15. The lead's thinking is left out of the quote; the plan is in the handover itself.
16. Tool results are quoted whole: the worker sees them today, and size is the context limit's job.
17. The prompt sentence and the repairs (wrong-role correction, idle stall) stay as a second line of defence; the
    worker's sentence names the quote when there is one.
18. A setting `relay.quoteLead`, default `true`; `false` restores the earlier request.
19. Verification: offline, the worker's request holds no assistant message before the handover. Real (needs a login):
    Haiku as the lead, 30 small tasks; pass = no role mix-up, every task passes, cost not above today's. Budget about
    $0.5. The PR is not merged before this run.

## Grill 5 (2026-11-17): a step list for a round. Accepted by the owner on 2026-11-17 ("都同意")

Looked at oh-my-pi's `todo` (its main at a344c4b31a: a tool with seven ops, a pinned panel, `/todo`, and reminders that
nudge the model and continue a run with open items). Relay takes the core and none of the reminders.

20. `handover` gets an optional `steps` (lines of text), given by the lead. Not required, never asked for; a round
    without it, and `/handover`, work as before.
21. `plan` stays, required: the list is the part of the plan that can be ticked.
22. The worker ticks with a new codemode-only tool `step({ n, status })`, by number, `status` `done` or `skipped`
    (with a `note`). It cannot change a step's text.
23. The worker may add a step (`step({ add })`), shown as the worker's; it cannot remove or reword the lead's.
24. No "in progress" state: open, done, skipped. The first open step is shown as the current one.
25. The list with its state is in the worker's section, so a compaction cannot lose it. Each tick rewrites the
    worker's cached prefix from there; the real run measures that cost, and if it is high the state moves to tool
    results only.
26. A widget above the editor, only for a round with a list: who has the work, the round, the count, the steps;
    closed steps folded in a long list; kept after the hand back until the user's next message.
27. The hand-back record carries the list as the worker left it, before the report.
28. A hand back with open steps is a hand back: no reminder, no continuation. The acceptance commands stay the only
    hard test.
29. Setting `relay.steps`, default `true`.
30. Verification: offline tests for every change of the list and the whole flow on the faux provider. Real: Opus as
    the lead on two long tasks twice, Haiku as the lead on the small tasks once, about $3.5. Reported: whether the
    lead gives steps, whether ticks match the work (against acceptance and the diff), the lead's cost, the cost of
    decision 25. Merged only if the pass rate does not fall and the lead's cost does not rise.
