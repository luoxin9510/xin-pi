# Tickets: spec 02, the worker's context limit

Spec: `.scratch/xpi-relay/02-worker-context.md`. Two PRs, each with an independent Opus review, green CI and the docs;
the real-model runs (the lead runs them, budget $10) before the second merges.

## PR D: the core seam

- [ ] D1 `ModelRoute.contextLimit`: the request compacts when the estimate exceeds it; absent, nothing changes;
      `details.limit` on the compaction entry; tests
- [ ] D2 prune first under a route limit: no summary when pruning is enough; tests
- [ ] D3 docs: `virtual-models.md`, `compaction.md`, `extensions.md`, `porting.md`

## PR E: relay

- [ ] E1 settings `relay.workerContext` and `relay.leadContext`, read at each request; the limit from the catalog
      tier, a number or `"off"`; wrong values name their key; tests
- [ ] E2 `route()` returns the limit per phase; the count of summaries from the branch; the stuck guard as a graph
      row (`limit_reached`) with `lift` and `handback`; `relay.limit` entries and notifications; the regenerated
      table, diagram and enumeration digest; tests
- [ ] E3 the facts for the lead, the per-round line after a hand back, the record line; tests
- [ ] E4 the eval prints the worker's peak context, requests above the tier and compactions per task
- [ ] E5 docs: `relay.md` (with the measured numbers), `settings.md`, `porting.md`, the package README
- [ ] E6 real-model validation: three tasks twice each with the defaults
- [ ] E7 the diff comparison (`relay.diffChars` 20000, 5000, 0) and the decision on the default, recorded in the
      measurements file
