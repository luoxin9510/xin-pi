# Relay: a strong model plans and reviews, a cheap model builds

Status: approved by the owner on 2026-11-10 (open questions answered "as recommended"; real runs with Opus and Haiku
allowed). Implemented in `src/extensions/relay/`; user docs in `docs/relay.md`.

## Problem

A long task goes best on one strong model, and that is also the expensive way to run it. Most of the tokens of such a
task are not judgement: they are file reads, test output and the mechanical part of the edits. The owner's premise:
Haiku 5.5 costs nothing, and every Opus 5.5 or Fable 5.2 token must go to work only that model can do. Sonnet is not
used.

## Solution

A built-in extension, `builtin:relay`, registers a virtual model, `relay/auto`. The session has two roles:

- **lead** (default `anthropic/claude-opus-5-5`): explores, decides the plan and the acceptance criteria, reviews the
  result.
- **worker** (default `anthropic/claude-haiku-5-5`): carries the plan out.

One conversation, one model selection. The footer shows which model answers (`relay → opus`, `relay → haiku`), as for
any virtual model.

```
lead explores → handover(plan, acceptance, findings)
             → worker builds (reads the whole conversation once, uncached: free)
             → the extension runs the acceptance commands; on failure the output goes back to the worker (3 rounds)
             → the conversation is compacted to the hand-back record
             → lead reads the record only → accepts / hands over again / fixes it itself
```

## What the lead pays for

| Step | Lead tokens |
|---|---|
| Exploring and planning | Its own reading and thinking. Wide searches can go to Haiku scouts (the `Agent` tool); the lead reads the conclusion. |
| `handover` | The note it writes (output tokens, one to two thousand). |
| Worker phase, acceptance rounds | None. |
| Hand back | The system prompt and tools from cache (1 hour lifetime), plus one cache write of the hand-back record. |

The worker's transcript (every file it read, every failed attempt, every test run) never reaches the lead.

## Decisions (agreed with the owner, 2026-11-10)

1. Hand back is a compaction, not a kept prefix. It is never more expensive, and every later lead request is cheaper.
2. The lead's own note is kept word for word in the record. Haiku summarizes only its own work.
3. No cache warming of the lead's conversation. Dropped while implementing: the 1 hour cache lifetime for the lead. It
   makes every cache write of the lead's exploring cost 2x in place of 1.25x, which is more than the one rewrite of
   the system prompt and tools it saves after a long worker phase.
4. A built-in extension in `xpi-coding-agent` now; a package of its own once the interface has settled.
5. The lead reads key code itself; wide searches may go to Haiku scouts.
6. After a hand back the lead chooses: accept, write a correction and hand over again, or make a small fix itself.
7. Acceptance commands that fail go back to the worker at most 3 times; then the lead is woken regardless.
8. The lead model is a setting. Thinking: high while planning, medium while reviewing.
9. `/handback` wakes the lead now; `/handover [instructions]` gives the work to the worker without a planning phase.

## The two tools

Both are always in the tool list, so the list is the same for both models and neither model's cache is broken by a
phase change. Each refuses the wrong caller.

**`handover`** (lead only)

| Field | Meaning |
|---|---|
| `plan` | The steps, in order, specific enough to follow without the lead. |
| `acceptance` | Shell commands that must exit 0 (tests, a type check, a grep). May be empty. |
| `criteria` | What "done" means beyond the commands, for the lead's own review. |
| `findings` | What the lead learned and must not lose: the files involved, constraints, traps. |
| `stopWhen` | When the worker must stop and hand back instead of pushing on. |

The result tells the reader that it is now the worker and what its job is. The next request is routed to the worker.

**`handback`** (worker only): `status` (`done` or `blocked`) and `report` (what was done, where it left the plan, what
is unresolved). A worker turn that ends without calling it counts as `done` with its last message as the report.

## Hand back

When the worker's run is over (`agent_before_settle`), the extension:

1. Runs each acceptance command in the session's directory (10 minute limit each). If one fails and fewer than 3
   rounds are used, the commands' output is sent to the worker and it continues. `blocked` skips this step.
2. Compacts the conversation to the hand-back record:
   - the user's messages, word for word;
   - the lead's `handover` note, word for word, and one line per earlier round;
   - the worker's report;
   - `git diff --stat` since the handover and the diff itself up to 20,000 characters (beyond that the lead is told to
     read the files it cares about); outside a git repository, the list of files written;
   - each acceptance command with its exit status and the end of its output.
   Nothing of the worker's transcript is kept after the record.
3. Sends the lead a message to review, which starts its turn.

The summary request of an ordinary compaction during a worker phase goes to the worker model (`reason: "direct"`).

## Routing

Router state on the session branch: `{ phase: "lead" | "worker", round }`. So a fork or `/tree` navigation sees the
phase of its own branch, and it survives compaction.

| Situation | Route |
|---|---|
| No state yet | lead |
| Lead phase, a `handover` succeeded in this turn | worker, `round + 1` |
| Worker phase, the hand-back record is the latest compaction and no response follows it | lead |
| Retry | the model that failed |
| Anything else | the phase's model |

A user message during a worker phase (steering, or after Esc) goes to the worker: the user is talking to the model
that is doing the work, and it is free. `/handback` is the way to the lead.

## Settings

```json
{
  "relay": {
    "lead": "anthropic/claude-opus-5-5",
    "worker": "anthropic/claude-haiku-5-5",
    "leadThinking": { "plan": "high", "review": "medium" },
    "workerThinking": "medium",
    "maxRounds": 3,
    "acceptanceTimeoutMs": 600000,
    "diffChars": 20000
  }
}
```

The block is in the settings schema. A second virtual model for Fable needs no code: `relay.lead`.

## Changes to core

None. What the design needed already exists:

- the summary request of a compaction is routed (`reason: "direct"`), so it goes to the worker;
- `agent_before_settle` accepts a compaction draft with `firstKeptEntryId: null` (keep nothing) together with a message
  and a continuation, which is the hand back in one step;
- a tool result can end the run (`terminate`), which `handback` uses.

Not verified: that the existing cache warmer (`cacheWarming`) spends no lead tokens during a long worker phase. It
refreshes the cache of the last request's model, which is the worker then.

## Out of scope

- A classifier that decides whether a task needs the lead at all. The user picks `relay/auto` or a plain model.
- More than one worker at a time. The lead can already start parallel agents with the `Agent` tool.
- An A/B evaluation against a lead-only run (it spends lead tokens; the owner decides when).

## Tests

- Offline (faux provider, `test/suite/`): the routing table above row by row; `handover` and `handback` refuse the
  wrong caller; acceptance failure goes to the worker and stops after 3 rounds; the record's content; the lead's
  request after a hand back contains the record and nothing of the worker's transcript; fork keeps the phase.
- Real: Haiku in both roles (told apart by thinking level and by router state), one task end to end with one failing
  acceptance round. Cost per physical model read from the session.
- A run with a real lead model only on the owner's word.

## Docs

`docs/relay.md` (new), `docs/virtual-models.md` (`cacheRetention`), `docs/settings.md`, `docs/docs.json`, the README
feature list, `docs/xin-pi.md` (core changes).

## Answers to the open questions (owner, 2026-11-10: as recommended)

1. A user message during a worker phase goes to the worker; `/handback` reaches the lead.
2. Acceptance commands run without asking.
3. Real tests use Haiku in both roles by default; `RELAY_TEST_LEAD` names a real lead. Opus and Haiku may be used.
4. Extension `builtin:relay`, model `relay/auto`, settings block `relay`.
5. The lead may finish a small task without a handover.

## Differences from the draft

- The record also keeps the lead's replies to the user (without tool activity), not only the user's messages.
- `handback` ends the worker's run at once (no extra worker request).
- `/handback` tells the worker to stop and report; the hand back follows when its run ends.
- The settings are read at each request.

## Facts in place of rules (owner, 2026-11-10)

The lead gets no rule about when to hand over. It gets the objective (`relay.objective`: by default as few lead tokens
as possible, worker tokens not counted), the API list prices of both models from the catalog, what a handover does and
what comes back, and after each hand back the measured time and usage of the session. `relay.minuteCost` puts a price
on the user's waiting time; unset by default. `relay.workerRecord` says what is known about the worker.

The owner's criterion for relay: the lead's cost below the lead working alone, and the time below the worker working
alone. Measured with `npm run eval:delegation -- --long` (results in `docs/relay.md`): met in all three tasks, one run
each. With the earlier rules the lead never handed over.
