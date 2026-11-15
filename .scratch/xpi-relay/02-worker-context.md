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
| `workerContext.limit` | `"tier"` | `"tier"`: `tierFraction` of the worker model's first price tier, the lowest `cost.tiers[].inputTokensAbove` in the catalog (the list has no promised order); a model without tiers, or one that is not in the catalog, has no limit. A number: that many prompt tokens. `"off"`: no limit. |
| `workerContext.tierFraction` | `0.95` | The part of the tier used with `"tier"`, above 0 and at most 1. |
| `workerContext.maxCompactions` | `4` | Summaries written under the limit in one round before `whenStuck` applies. `0`: the guard is off. |
| `workerContext.whenStuck` | `"lift"` | `"lift"`: the limit is lifted for the rest of the round. `"handback"`: the worker is told to hand back with a progress report, so the lead can split what is left. |
| `leadContext.limit` | `"off"` | The same three forms, for the lead's own context. Off by default: the lead's context is small in every measured task. |
| `leadContext.tierFraction`, `leadContext.maxCompactions` | `0.95`, `4` | As for the worker. When the lead is stuck the limit is always lifted, until the next handover. |

Read with the other relay settings at each request, so a change applies to the next one; a wrong value ends the
request with an error that names the key, as today. With Haiku 5.5 as the worker the default limit is 95,000 tokens.

A limit must leave room for what a compaction keeps: the computed limit (a number, or the fraction of a tier) below
`compaction.keepRecentTokens` plus 20,000 (40,000 with the defaults) is an error that names the key. A limit that a
compaction cannot get under would compact on every request. Relay reads only its own settings block, so the host
supplies the value: `RelayHost.keepRecentTokens()`, the compaction setting as resolved for `relay/auto`.

### 2. Core seam: a context limit on the route (decision 2)

Today the threshold for a virtual model is checked in `prepareRequest` against the routed model's window with the
compaction settings of the *selected* model (`_exceedsCompactionThreshold(route.model, ...)` reads
`getCompactionSettings(this.model)`), so a per-model override names `relay/auto` and cannot tell the worker from the
lead.

- `ModelRoute` gains an optional `contextLimit?: number` (prompt tokens). `resolveModel` in `model-runtime.ts`
  rebuilds the route object, so the field is carried there and validated there: a positive finite integer, else the
  request fails naming the virtual model. It is ignored for `reason: "direct"` (summary requests and `ctx.complete`).
- The request compacts when the estimated context exceeds **the smaller of** the route limit and today's threshold
  (the routed model's window minus the reserve). Without a route limit nothing changes.
- No compaction on every request: a limit-triggered compaction is skipped when the newest context-changing entry on
  the branch is a compaction with no assistant response after it. Within one request there is no loop already (after
  compacting, the request is prepared again but not routed again).
- The compaction entry records the limit in a field the core owns, `contextLimit` on the entry, written whoever
  supplied the summary (an extension answering `session_before_compact` replaces `details`, so `details` cannot carry
  it). It is set only when the route limit is what triggered the compaction. `session_before_compact` fires as for
  any threshold compaction, with the limit on the event.
- Relay's `route()` returns the worker's limit in the worker phase and the lead's in the lead phase, each `undefined`
  when off or lifted.
- The estimate: it is the provider's own count up to the latest response, plus characters/4 for what came after;
  right after a compaction or a prune it is characters/4 for the whole context, which tends to undercount code and
  JSON. So a request shortly after a prune can still go out above the tier. Section 3 leaves headroom for that, and
  the eval counts the worker's requests above the tier (7), so the size of the effect is measured, not assumed.
- The session format gains a field: `CompactionEntry.contextLimit`, written by `appendCompaction`. The session
  format docs (`docs/session-format.md`) and the entry's type list it; older readers ignore an unknown field.
- Docs: `docs/virtual-models.md`, `docs/compaction.md`, `docs/session-format.md`, `docs/extensions.md`,
  `docs/porting.md`.

### 3. Prune first under a route limit (decision 3)

Today, under a virtual model, a threshold compaction prunes old tool output and then always writes a summary
(`_pruneToolOutputBeforeCompaction` returns false for any virtual model and measures against `this.model`); under a
physical model it stops after pruning when that was enough.

- The limit is passed down (`_runAutoCompaction(reason, willRetry, limit)` to the prune step). When the trigger is a
  route's `contextLimit`, the limit is known and comparable, so the shortcut applies: after pruning, if the estimate
  is at or below **90 percent of the limit**, no summary is written and the conversation's messages stay. The 10
  percent is headroom for the estimate's error after a prune. Without a route limit a virtual model behaves as
  today.
- Pruning rewrites the cached prefix from the first pruned tool result on. That is one cache write of the context at
  the worker's price, and still cheaper than a summary request followed by the same rewrite.
- Only a summary counts for `maxCompactions`: pruning alone loses no reasoning.

### 4. The stuck guard (decision 4)

- Relay counts the summaries written under a limit in the current phase: the compaction entries with `contextLimit`
  on the branch after the latest `relay.handover` (worker) or the latest hand back (lead). Compaction entries stay on
  the branch, so the count follows the branch. A failed acceptance run starts no new round, so the count carries
  across it.
- The guard is raised in `route()`, for a non-direct request, when the count has reached `maxCompactions`.
  `route()` stays free of side effects and passes its decision on through the state it returns: `RelayState` gains an
  optional `limit?: "lifted" | "asked"`, stored on the branch with the phase and the round. `onRequestStart` sees the
  change between `previousRouterState` and `routerState`, as it sees a phase change since PR B, and runs the graph
  row there (the entry, the notification, the steer). A state without the field reads as limited, so sessions from
  before the change continue. The request that lifts the limit is itself not limited: the compaction check runs
  after `request_start`.
  - `"lift"`: no limit for the rest of the round. One `relay.limit` entry (`{ round, phase, action: "lifted",
    compactions }`) and one notification: `relay: worker compacted 4 times in round N, limit lifted`.
  - `"handback"` (worker only): one steering message (`sendMessage` with `deliverAs: "steer"`, which reaches the
    worker after the request in flight) asking it to hand back `blocked` with what is done and what is left; the
    limit stays. One `relay.limit` entry with `action: "handback"` and a notification. It does not count as a stall
    or a mix-up, and a `/handback` by the user in the same round takes precedence. If the worker has not handed back
    after two more summaries, the limit is lifted as with `"lift"`.
- A new handover resets the count and the lift: the new round's state has no `limit` field. The lead's count runs
  from the latest hand back, or from the start of the branch before the first handover, and its lift lasts until the
  next handover.
- Prune-only passes are not counted and not capped: each needs `compaction.prune.minSavingsTokens` of old tool
  output, so they cannot repeat without new output to prune.
- It is a row of relay's graph: event `limit_reached` (`{ phase, compactions }`) with the actions as effects, so the
  generated table and diagram show it and the enumeration covers it.
- The record: `view.ts` treats every compaction without `details.relay` as the lead's "earlier summary" today. A
  summary written under a limit in a worker phase is the worker's working memory, not the lead's: `readPhase` skips
  compactions with `contextLimit` after the latest handover when it picks the earlier summary. A summary under the
  lead's own limit is the lead's and is kept as the earlier summary, as an ordinary compaction is.
- The worker's section: once a summary has replaced the handover's tool result, "the tool result that contains
  `Handed over...`" points at nothing. The sentence becomes "the handover (a tool result that contains `Handed
  over...`, or its mention in a summary of this conversation)". The plan is in the section itself, so nothing is lost.

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

Measure before changing the default: `relay.diffChars` at 20000 (today), 5000 and 0 on the three tasks of the
validation (`fork agent type`, `relaunch and pause`, `workflows`), with the lead's cost and the number of lead
requests after the hand back. The 20000 runs are the validation runs themselves. The default changes only if the
lead's cost drops clearly
and the tasks still pass; the result is recorded in `measurements-2026-11-15.md` (or a new dated file) either way.

### 7. The eval

`EVAL_SETTINGS=<json>` (added with this spec) merges settings into every run's project settings, one level deep:
an object-valued key such as `relay` is merged with the arm's own, so `{"relay":{"workerContext":{...}}}` keeps the
arm's lead, worker and thinking levels and the runs stay comparable with the baseline. The delegation
eval's per-task output gains the worker's peak context, the number of worker requests above the first price tier and
the compactions in the worker phase, so a run shows what this spec is about without a separate script.

## Tests

- Core: a route with `contextLimit` compacts at the limit and not before; without it nothing changes; prune-only when
  pruning is enough (no summary entry, the messages stay), a summary when it is not; `contextLimit` on the entry.
- `xpi-relay`: the limit from a catalog tier, from a number, `"off"`, a model without tiers, `tierFraction`; wrong
  values name their key; the count from branch entries; `lift` and `handback` (including the fall-back lift); reset at
  a new handover; the facts and the record line; the new graph row, the regenerated docs and the enumeration digest
  (it changes on purpose).
- Suite (faux provider): a worker phase that crosses the limit is compacted and continues; the fifth summary lifts
  the limit; the lead phase is not limited by default; a settings change applies to the next request.
- Core, more: the smaller of the two thresholds wins; `contextLimit` survives `resolveModel` and is rejected when it
  is not a positive integer; ignored for `direct`; no second limit-triggered compaction without a response in
  between; the entry's `contextLimit` is written when an extension supplied the summary.
- `xpi-relay`, more: a limit below the minimum names its key, also when it comes from a small `tierFraction`; the
  `limit` field of the state (set by `route()`, acted on in `onRequestStart`, absent after a handover, absent in an
  old session); the lead's guard lifts and counts from the start of the branch before the first handover; the
  earlier summary skips the worker's limit summaries; the worker's section wording.
- Real models (the lead runs them, budget $10): `fork agent type`, `relaunch and pause` and `workflows` twice each
  with the defaults, then once each with `diffChars` 5000 and 0. Pass: all six default runs pass, the mean cost of
  the two runs of each task is below its unlimited run ($0.71, $1.16, $1.47), and `workflows` does not time out.

## Docs

`docs/relay.md` (the limit, the stuck guard, the new facts, the settings table, the measured numbers),
`docs/settings.md`, `docs/compaction.md`, `docs/virtual-models.md`, `docs/extensions.md`, `docs/porting.md`,
`packages/xpi-relay/README.md`, the generated relay table and diagram.
