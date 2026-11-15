# Spec 03: the lead's context limit by window, and keeping the lead's cache warm (step 3)

Status: approved by the owner on 2026-11-15 (Grill 3 in `decisions.md`).

## Problem

Two small costs are left on the lead's side after step 2.

- Nothing limits the lead's own context by default. In every measured task it is small (22,000 to 24,000 tokens,
  2.4 percent of the window of Opus 5.5), because the hand-back record replaces the conversation. A lead that does
  not hand over, or a long conversation with the user in a lead phase, grows until the ordinary threshold near the
  end of the window (1,000,000 tokens). A limit can be given only as a number of tokens or as a price tier, and the
  lead's model has no tiers.
- During a worker phase longer than the cache lifetime (five minutes) the lead's cached prefix expires: its tools and
  system prompt, about 6,000 tokens, are written again on the first request after the hand back. Measured: about
  $0.03 each time, 9 percent of the lead's cost. With the worker's limit most rounds are longer than five minutes.
  The core's cache warmer does not help: it keeps the latest request warm, and warms nothing under a virtual model.

## Goal

The lead's context has a default limit that scales with its model. The lead's prefix is still cached when the worker
hands back, where keeping it warm costs less than writing it again.

Not in this spec: a one-hour cache lifetime for the lead (every cache write of the lead would cost 2 times the input
price instead of 1.25, far more than the $0.03 saved); warming anything for the worker (its context starts again
each round); warming the ordinary (non-held) request under a virtual model.

## Design

### 1. A limit as a share of the window (PR F)

- `limit` in `relay.workerContext` and `relay.leadContext` takes a fourth form: a percentage string such as `"30%"`,
  above 0 and at most 100, with an optional fraction (`"12.5%"`). It is that share of the phase model's
  `contextWindow` in the catalog, rounded down. A model outside the catalog, or without a window, has no limit.
- The default of `relay.leadContext.limit` changes from `"off"` to `"30%"`: 300,000 tokens for Opus 5.5. The worker's
  default stays `"tier"`.
- Everything else is as for the other forms: the minimum (`compaction.keepRecentTokens` + 20,000) with an error that
  names the key, the stuck guard (`leadContext.maxCompactions`, then lifted until the next handover), the core taking
  the smaller of the limit and the ordinary threshold, the summary request going to the worker model.
- A wrong string (`"30"`, `"0%"`, `"101%"`, `"abc%"`) is an error that names the key and lists the forms.
- The lead's section already states the lead's own limit when it has one; with the new default it is always there.
  The fact names the tokens, not the percentage.
- Docs: `docs/relay.md` (the settings table, the limit section), `docs/settings.md`, the settings schema,
  `packages/xpi-relay/README.md`.

### 2. Core seam: a held cache entry (PR G)

Today `CacheWarmer` keeps one entry: the latest session request, and only while the selected model is the request's
model, so a request routed by a virtual model is never warmed. That stays.

- `ModelRoute` gains an optional `cache?: { key: string; hold?: { key: string; reuse: "prefix" | "all" } }`.
  - `key` labels the cache entry this request writes. The core remembers the latest request sent under each key
    (the model, the context and the options, as sent) with the prompt tokens of its response.
  - `hold` names another key whose entry is kept warm while requests carrying this `hold` keep coming and the agent
    run is active. `reuse` says what of the held prompt the next request under that key will read: `"prefix"` (the
    tools and the system prompt only) or `"all"`.
  - Ignored for `reason: "direct"`. Validated in `resolveModel`: non-empty strings, `hold.key` different from `key`.
- The held entry is refreshed like the ordinary one: the same request with a one-token output cap, at 90 percent of
  the cache lifetime, recorded as a `cache_warm` usage entry (with the key as its note), never entering the context.
  The rules of the ordinary entry apply: `cacheWarming: "off"` disables it, a request that cannot be replayed safely
  is not held, the one-hour limit, the missed-deadline rule.
- The hold ends when: a request is sent under the held key (it replaces the entry), a request arrives whose route
  does not hold it, the agent run settles (an idle session holds nothing, in every warming mode), the selected model
  changes, the session is disposed.
- Economics, decided at each refresh: the saving is the reused tokens times (cache write price minus cache read
  price) of the held model, where the reused tokens are the held request's prompt tokens for `"all"` and an estimate
  of its tools and system prompt (characters / 4) for `"prefix"`. A refresh costs the held request's prompt tokens at
  the cache read price plus one output token. The entry is refreshed while what the refreshes have cost so far plus
  the next one stays below the saving; then it is left to expire. The $0.05 minimum of the ordinary entry does not
  apply: the saving here is known, not estimated from a probability.
- `cache_warming_decision` fires for the held entry too, with a new optional `key` on the event; an extension can
  override the action as for the ordinary entry.
- `/session` shows the held entry on its own line when there is one.
- Docs: `docs/virtual-models.md`, `docs/extensions.md` (the event's `key`), `docs/settings.md` (`cacheWarming`),
  `docs/session-format.md` if the usage entry's note is described there, `docs/porting.md`.

### 3. Relay holds the lead's entry (PR G)

- A setting `relay.warmLead`, `true` by default. A value that is not a boolean is an error that names the key.
- `route()` returns `cache: { key: "lead" }` in the lead phase and `cache: { key: "worker" }` in the worker phase,
  with `hold: { key: "lead", reuse: "prefix" }` in the worker phase when `warmLead` is on. `RelayRoute` gains the
  field and the adapter passes it on. `route()` stays free of side effects.
- `"prefix"` because the hand-back record replaces the lead's conversation: only the tools and the system prompt are
  read again.
- The lead's section must not change between the handover and the hand back, or the held prefix is useless. The
  section's text depends on settings and the catalog only; a test pins that it is the same string before and after a
  round.
- `/relay` shows, for the session, how many refreshes kept the lead's entry warm and what they cost (from the
  `cache_warm` usage entries with the note `lead`). The eval prints the same per task, and the lead's cache read and
  cache write of the first request after each hand back.

## Tests

- `xpi-relay` (PR F): every form of a limit including the percentage; the wrong strings name the key; the share of
  the window for the lead and for the worker; no window, no limit; the minimum applies to a small percentage; the
  default for the lead; the lead's fact.
- Suite, faux provider (PR F): a lead phase that crosses its limit is compacted and continues.
- Core (PR G): a held entry is refreshed while the holding requests continue and stops at each of the ending
  conditions; the refresh is the held request as sent with one output token; the economics (`"prefix"` and `"all"`,
  the stop when the refreshes would cost more than the saving); `cacheWarming: "off"`; `direct` ignores `cache`;
  validation; the event's `key`; the ordinary entry behaves as before, with and without a held one.
- `xpi-relay` (PR G): the route's `cache` per phase, with and without `warmLead`; a wrong `warmLead` names its key;
  the lead's section is identical across a round.
- Real models (the lead runs them, budget $3): `relaunch and pause` and `workflows` twice each with the defaults.
  Pass: all pass; the first lead request after a hand back reads its prefix from the cache in the rounds longer than
  five minutes; the mean of the lead's cost plus the refreshes is not above the lead's cost in round 3 of the
  measurements ($0.20 and $0.34). If it is above, the default of `warmLead` becomes `false` and the numbers are
  recorded either way.

## Docs

`docs/relay.md`, `docs/settings.md`, `docs/virtual-models.md`, `docs/extensions.md`, `docs/porting.md`,
`packages/xpi-relay/README.md`, the settings schema, the measurements file.
