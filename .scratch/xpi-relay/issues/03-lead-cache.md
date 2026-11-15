# Tickets for spec 03 (the lead's limit by window, the lead's cache)

Spec: `../03-lead-cache.md`. Two PRs.

## PR F: a limit as a share of the window

- [x] F1 the percentage form of `limit` for both roles (the share of the model's `contextWindow`); wrong strings
      name the key; the minimum applies; tests
- [x] F2 the default of `relay.leadContext.limit` is `"30%"`; the lead's fact; a suite test of a lead phase crossing
      its limit
- [x] F3 docs: `relay.md`, `settings.md`, the settings schema, the package README

## PR G: a held prefix

- [x] G1 core: `ModelRoute.cache` (`key`, `holdPrefix`), validated in `resolveModel`, ignored for `direct`; the
      label handed from `prepareRequest` to the warmer and consumed by the stream function; the warmer remembers the
      latest request per key and refreshes the held prefix in a slot of its own; the ending conditions; tests
- [x] G2 core: the refresh request (tools, system prompt, one short message, one output token); the economics;
      `cache_warming_decision` with `key`; the `/session` line; tests
- [x] G3 relay: `relay.warmLead`; `route()` returns `cache`; `RelayRoute.cache` passed on by the adapter; the suite
      test that the prefix is the same before a handover and after the hand back; tests
- [x] G4 `/relay` and the eval show the refreshes and their cost, and the lead's cache read and write after each
      hand back
- [x] G5 docs: `relay.md`, `settings.md`, `virtual-models.md`, `extensions.md`, `porting.md`, the package README
- [x] G6 real-model validation (budget $3) and the decision on the default, recorded in the measurements file
