# Tickets for spec 03 (the lead's limit by window, the lead's cache)

Spec: `../03-lead-cache.md`. Two PRs.

## PR F: a limit as a share of the window

- [x] F1 the percentage form of `limit` for both roles (the share of the model's `contextWindow`); wrong strings
      name the key; the minimum applies; tests
- [x] F2 the default of `relay.leadContext.limit` is `"30%"`; the lead's fact; a suite test of a lead phase crossing
      its limit
- [x] F3 docs: `relay.md`, `settings.md`, the settings schema, the package README

## PR G: a held cache entry

- [ ] G1 core: `ModelRoute.cache` (`key`, `hold`), validated in `resolveModel`, ignored for `direct`; the warmer
      remembers the latest request per key and refreshes the held one; the ending conditions; tests
- [ ] G2 core: the economics of a held entry (`"prefix"`, `"all"`, stop when the refreshes cost more than the
      saving); `cache_warming_decision` with `key`; the `/session` line; tests
- [ ] G3 relay: `relay.warmLead`; `route()` returns `cache`; `RelayRoute.cache` passed on by the adapter; the
      section is identical across a round; tests
- [ ] G4 `/relay` and the eval show the refreshes and their cost, and the lead's cache read and write after each
      hand back
- [ ] G5 docs: `relay.md`, `settings.md`, `virtual-models.md`, `extensions.md`, `porting.md`, the package README
- [ ] G6 real-model validation (budget $3) and the decision on the default, recorded in the measurements file
