# Tickets: spec 02, the worker's context limit

Spec: `.scratch/xpi-relay/02-worker-context.md`. Two PRs, each with an independent Opus review, green CI and the docs;
the real-model runs (the lead runs them, budget $10) before the second merges.

## PR D: the core seam

- [x] D1 `ModelRoute.contextLimit`, carried and validated in `resolveModel`, ignored for `direct`: the request
      compacts at the smaller of the limit and today's threshold; no second limit compaction without a response in
      between; `contextLimit` on the compaction entry, written by the core; tests
      Done: `ModelRoute.contextLimit`, `_routeCompactionTrigger`, `appendCompaction(..., contextLimit)`, event field;
      `test/suite/virtual-model-context-limit.test.ts` (9 tests).
- [x] D2 prune first under a route limit, with the limit passed down: no summary when pruning gets to 90 percent
      of the limit; tests
      Done: the limit goes `prepareRequest` -> `_runAutoCompaction` -> `_pruneToolOutputBeforeCompaction`; covered by
      the same test file (prune-only and prune-then-summary cases).
- [x] D3 docs: `virtual-models.md`, `compaction.md`, `session-format.md`, `extensions.md`, `porting.md`
      Done: all five, plus a section in `compaction.md`; no generated docs depend on these inputs.

### Deviations (PR D)

- A limit at or above the usual threshold leaves an ordinary threshold compaction (no `contextLimit`). When the
  limit is the smaller one, the entry carries it even if the context is above the threshold as well; the "no
  response in between" guard does not apply in that case.
- "Newest context-changing entry" is read as the newest message, custom message, branch summary or compaction entry;
  context edits, custom state entries and labels are skipped.
- With compaction disabled (`compaction.enabled: false`) a route limit does not compact either.

## PR E: relay

- [x] E1 settings `relay.workerContext` and `relay.leadContext`, read at each request; the limit from the catalog
      tier, a number or `"off"`; wrong values name their key; tests
- [x] E2 `route()` returns the limit per phase (`RelayRoute.contextLimit`, passed on by the adapter to the core's
      `ModelRoute`) and the `limit` field of the state; `onRequestStart` acts on it; the
      count of summaries from the branch; `RelayHost.keepRecentTokens()`; the stuck guard as a graph
      row (`limit_reached`) with `lift` and `handback`; `relay.limit` entries and notifications; the regenerated
      table, diagram and enumeration digest; tests
- [x] E3 the facts for the lead, the per-round line after a hand back, the record line; tests
- [x] E4 the eval prints the worker's peak context, requests above the tier and compactions per task;
      `EVAL_SETTINGS` merges one level deep
- [x] E5 docs: `relay.md` (with the measured numbers), `settings.md`, `porting.md`, the package README
- [x] E6 real-model validation: three tasks twice each with the defaults
- [x] E7 the diff comparison (`relay.diffChars` 20000, 5000, 0) and the decision on the default, recorded in the
      measurements file
