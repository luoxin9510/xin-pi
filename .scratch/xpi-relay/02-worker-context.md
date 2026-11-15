# Spec 02: the worker's context limit (step 2)

Status: approved by the owner on 2026-11-15 (Grill 2 in `decisions.md`: all as recommended, with the limit freely
configurable in settings).

## Problem

Measured on eight long tasks (`measurements-2026-11-15.md`): 71 percent of a relay session's cost is the worker's,
and 92 percent of the worker's cost comes from requests above 100,000 prompt tokens, where Haiku 5.5 costs five times
as much per token. Nothing limits the worker's context: it reached 294,000 tokens with no compaction. A hard limit
at 95,000 tokens halves the cost of medium tasks and makes the largest one time out, compacting every two to three
minutes.

## Goal

The worker's context stays below its model's first price tier where that is possible, and a task that needs more
still finishes. The lead knows the price tier and what each round did. Every limit is a setting.

Not in this spec: appending the record instead of replacing the conversation (measured: no difference), warming the
lead's cache (about 9 percent of the lead's cost; later), more than one worker.

## Design

### 1. Settings (decisions 1, 4; the owner: freely configurable)

```json
{
  "relay": {
    "workerContext": { "limit": "tier", "tierFraction": 0.95, "maxCompactions": 4, "whenStuck": "lift" },
    "leadContext": { "limit": "off" }
  }
}
```

| Key | Default | Meaning |
|---|---|---|
| `workerContext.limit` | `"tier"` | `"tier"`: `tierFraction` of the worker model's first price tier (`cost.tiers[0].inputTokensAbove` in the catalog); a model without tiers has no limit. A number: that many prompt tokens. `"off"`: no limit. |
| `workerContext.tierFraction` | `0.95` | The part of the tier used with `"tier"`, above 0 and at most 1. |
| `workerContext.maxCompactions` | `4` | Limit-triggered compactions in one round before `whenStuck` applies. `0`: never. |
| `workerContext.whenStuck` | `"lift"` | `"lift"`: the limit is lifted for the rest of the round. `"handback"`: the worker is told to hand back with a progress report, so the lead can split what is left. |
| `leadContext.limit` | `"off"` | The same three forms, for the lead's own context. Off by default: the lead's context is small in every measured task. |

Read with the other relay settings at each request, so a change applies to the next one; a wrong value ends the
request with an error that names the key, as today. With Haiku 5.5 as the worker the default limit is 95,000 tokens.

### 2. Core seam: a context limit on the route (decision 2)

Today the threshold for a virtual model is checked in `prepareRequest` against the routed model's window with the
compaction settings of the *selected* model (`_exceedsCompactionThreshold(route.model, ...)` reads
`getCompactionSettings(this.model)`), so a per-model override names `relay/auto` and cannot tell the worker from the
lead.

- `ModelRoute` gains an optional `contextLimit?: number` (prompt tokens). When it is set, the request compacts when
  the estimated context exceeds it; when it is absent, today's rule applies unchanged.
- The compaction that follows is a `threshold` compaction with `details.limit` naming the limit, so extensions and
  the session show why it happened. `session_before_compact` fires as for any threshold compaction.
- Relay's `route()` returns the worker's limit in the worker phase and the lead's in the lead phase, each `undefined`
  when off or lifted.
- Docs: `docs/virtual-models.md`, `docs/compaction.md`, `docs/extensions.md`, `docs/porting.md`.

### 3. Prune first under a route limit (decision 3)

Today, under a virtual model, a threshold compaction prunes old tool output and then always writes a summary; under
a physical model it stops after pruning when that was enough.

- When the trigger is a route's `contextLimit`, the limit is known and comparable, so the same shortcut applies:
  after pruning, if the estimate is at or below the limit, no summary is written and the conversation's messages
  stay. Without a route limit a virtual model behaves as today.
- A prune-only pass counts as a compaction for `maxCompactions` only when it writes a summary: pruning alone loses no
  reasoning and is cheap.

### 4. The stuck guard (decision 4)

- Relay counts the summaries written under the worker's limit since the handover (from the compaction entries on the
  branch after the latest `relay.handover`, so the count follows the branch).
- When the count reaches `maxCompactions`:
  - `"lift"`: `route()` returns no limit for the rest of the round. One `relay.limit` entry
    (`{ round, action: "lifted", compactions }`) and one notification: `relay: worker compacted 4 times in round N,
    limit lifted`.
  - `"handback"`: the worker gets one steering message asking it to hand back `blocked` with what is done and what
    is left; the limit stays. One `relay.limit` entry with `action: "handback"` and a notification. If the worker
    has not handed back after two more compactions, the limit is lifted as with `"lift"`.
- A new handover resets the count and the lift.
- This is a row of relay's graph: event `limit_reached` in the worker phase, with the two actions as effects, so the
  generated table and diagram show it and the enumeration covers it.

### 5. What the lead is told (decision 5)

Facts, no rule about splitting:

- In the lead's section, with the prices: the worker's first price tier (the token count and how many times dearer
  the tokens are above it), that the worker's context grows with what it reads in one round and starts again after a
  hand back, and the limit in force (`worker context limit: 95,000 tokens; after 4 compactions in a round it is
  lifted`).
- After each hand back, with the round's time and spend: the worker's peak context, how many summaries were written
  under the limit, and whether the limit was lifted or a hand back was asked for.
- The hand-back record gets the same line, with the round's repairs.

### 6. The diff in the record (decision 6)

Measure before changing the default: `relay.diffChars` at 20000 (today), 5000 and 0 on three tasks, with the lead's
cost and the number of lead requests after the hand back. The default changes only if the lead's cost drops clearly
and the tasks still pass; the result is recorded in `measurements-2026-11-15.md` (or a new dated file) either way.

### 7. The eval

`EVAL_SETTINGS=<json>` (added with this spec) merges settings into every run's project settings. The delegation
eval's per-task output gains the worker's peak context, the number of worker requests above the first price tier and
the compactions in the worker phase, so a run shows what this spec is about without a separate script.

## Tests

- Core: a route with `contextLimit` compacts at the limit and not before; without it nothing changes; prune-only when
  pruning is enough (no summary entry, the messages stay), a summary when it is not; `details.limit` on the entry.
- `xpi-relay`: the limit from a catalog tier, from a number, `"off"`, a model without tiers, `tierFraction`; wrong
  values name their key; the count from branch entries; `lift` and `handback` (including the fall-back lift); reset at
  a new handover; the facts and the record line; the new graph row, the regenerated docs and the enumeration digest
  (it changes on purpose).
- Suite (faux provider): a worker phase that crosses the limit is compacted and continues; the fifth summary lifts
  the limit; the lead phase is not limited by default; a settings change applies to the next request.
- Real models (the lead runs them, budget $10): the three most expensive tasks twice each with the defaults, and the
  diff comparison of 6. Pass: all three tasks pass, their total cost is below the unlimited runs, and `workflows`
  does not time out.

## Docs

`docs/relay.md` (the limit, the stuck guard, the new facts, the settings table, the measured numbers),
`docs/settings.md`, `docs/compaction.md`, `docs/virtual-models.md`, `docs/extensions.md`, `docs/porting.md`,
`packages/xpi-relay/README.md`, the generated relay table and diagram.
