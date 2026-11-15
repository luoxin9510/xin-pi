# Spec 03: the lead's context limit by window, and keeping the lead's cached prefix warm (step 3)

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
- A built-in default that does not fit is no limit, not an error: the lead's 30 percent of a small window (38,400
  tokens of a 128,000 window, below the minimum of 40,000), or the worker's tier under a large `keepRecentTokens`.
  Nobody chose it, and relay must work with any lead model. A limit the settings chose (`limit`, or `tierFraction`
  for a tier) that does not fit stays an error. This changes step 2 for the worker's default, which was an error.
- The lead's default applies only where it is at least 100,000 tokens (found in review: 30 percent of a 200,000
  window is 60,000, and the lead would compact every few turns). Below that the lead has no default limit.
- The lead's stuck guard counts from the later of the latest hand back and the latest user message, and its lift
  ends at the next user message (found in review: counted from the start of the branch, a long conversation lost
  the limit for good after four summaries).
- A wrong string (`"30"`, `"0%"`, `"101%"`, `"abc%"`) is an error that names the key and lists the forms.
- The lead's section already states the lead's own limit when it has one; with the new default it is always there.
  The fact names the tokens, not the percentage.
- Docs: `docs/relay.md` (the settings table, the limit section), `docs/settings.md`, the settings schema,
  `packages/xpi-relay/README.md`.

### 2. Core seam: a held prefix (PR G)

Revised after the review of PR F, which read this section: replaying the whole request is not known to refresh the
shorter cache entry at the system prompt's breakpoint, the route does not reach the warmer today, and the ending
conditions were incomplete.

Today `CacheWarmer` keeps one entry: the latest session request, and only while the selected model is the request's
model, so a request routed by a virtual model is never warmed. That stays.

- `ModelRoute` gains an optional `cache?: { key: string; holdPrefix?: string }`.
  - `key` labels the requests of one role. The core remembers the latest session request sent under each key: the
    physical model, the tools and the system prompt of its context, and its options, as sent.
  - `holdPrefix` names another key. While requests carrying it keep coming and the agent run is active, the cached
    prefix (tools and system prompt) of that key's remembered request is kept warm.
  - Validated in `resolveModel`: non-empty strings, `holdPrefix` different from `key`; else the request fails naming
    the virtual model. Ignored for `reason: "direct"`.
- How the label reaches the warmer: `prepareRequest` in `agent-session.ts` has the route and the stream function in
  `sdk.ts` has the request. `prepareRequest` hands the route's `cache` to the warmer for the next session request
  (after the route is committed, before it returns); the stream function's existing call for a session request
  (`options.sessionId` is the session's) consumes it. A request without a pending label changes nothing about held
  prefixes: summary requests, `ctx.complete`, subagents, the refreshes themselves. A retry is routed again and
  carries its own label.
- The refresh is a new request, not a replay of the conversation: the remembered tools and system prompt, one short
  user message (`.`), the remembered options with a one-token output cap, no retries, no continuation. It goes
  through the same request building as the original, so the serialized tools and system prompt are the same bytes
  and the lookup hits the cache breakpoint at the end of the system prompt (`anthropic-messages.ts` puts breakpoints
  on the last tool, the system blocks and the last user message). It costs a cache read of the prefix; the short
  message adds a few tokens.
- Timing and the other rules are the ordinary entry's: at 90 percent of the cache lifetime of the held model for the
  retention the request used, `cacheWarming: "off"` disables it, a request that cannot be replayed safely
  (`isCacheWarmingReplayable`) is not held, the one-hour limit from the remembered request, the missed-deadline rule.
  The refresh is recorded as a `cache_warm` usage entry with the note `held prefix: <key>`, and never enters the
  context.
- The hold ends when:
  - a session request is sent under the held key (it reads the prefix itself; a refresh in flight is aborted);
  - a labelled session request arrives that does not hold it;
  - the agent run settles, in every warming mode (an idle session holds nothing; a user who interrupts the worker and
    resumes later starts without a hold until the next lead request is remembered and held again, which is accepted);
  - the selected model changes away from the virtual model, the session branch changes (`/tree`, fork, switch), the
    session is disposed.
  The held slot is separate from the ordinary run: `start()` for the ordinary entry must not clear it.
- Economics, decided at each refresh from the held model's prices. The prefix tokens are estimated as characters / 4
  of the remembered system prompt and tool definitions. The saving is the prefix tokens times (cache write price
  minus cache read price); a refresh costs the prefix tokens at the cache read price plus one output token. The
  prefix is refreshed while what the refreshes have cost so far plus the next one stays below the saving; then it is
  left to expire. The $0.05 minimum of the ordinary entry does not apply: the saving is one known cache write, not
  an estimate from a probability. Unknown prices: no refresh.
- `cache_warming_decision` fires for a held prefix too, with a new optional `key` on the event; an extension can
  override the action as for the ordinary entry.
- `/session` shows a held prefix on its own line when there is one.
- Docs: `docs/virtual-models.md`, `docs/extensions.md` (the event's `key`), `docs/settings.md` (`cacheWarming`),
  `docs/session-format.md` if the usage entry's note is described there, `docs/porting.md`.

### 3. Relay holds the lead's prefix (PR G)

- A setting `relay.warmLead`, `true` by default. A value that is not a boolean is an error that names the key.
- `route()` returns `cache: { key: "lead" }` in the lead phase and `cache: { key: "worker" }` in the worker phase,
  with `holdPrefix: "lead"` in the worker phase when `warmLead` is on. `RelayRoute` gains the field and the adapter
  passes it on. `route()` stays free of side effects.
- Only the prefix, because the hand-back record replaces the lead's conversation: the tools and the system prompt
  are all the next lead request reads again.
- The saving exists only if the first lead request after a hand back sends the same tools and system prompt as the
  lead's last request before the handover. A suite test pins that on the faux provider's captured requests (the
  serialized tools and system prompt of the two requests are equal), for a session that starts under `relay/auto`.
  Known cases where they differ, and the refresh is wasted: relay selected in the middle of a session, tools added
  during the lead phase, a codemode switch during the round. They are listed in the docs; the cost is bounded by the
  economics rule (at most one cache write of the prefix).
- `/relay` shows, for the session, how many refreshes kept the lead's prefix warm and what they cost (from the
  `cache_warm` usage entries with that note). The eval prints the same per task, and the lead's cache read and cache
  write of the first request after each hand back.

## Tests

- `xpi-relay` (PR F): every form of a limit including the percentage; the wrong strings name the key; the share of
  the window for the lead and for the worker; no window, no limit; the minimum applies to a small percentage; the
  default for the lead; the lead's fact.
- Suite, faux provider (PR F): a lead phase that crosses its limit is compacted and continues.
- Core (PR G): a held prefix is refreshed while the holding requests continue, and stops at each of the ending
  conditions; the refresh carries the remembered tools and system prompt, one short user message and a one-token cap;
  an unlabelled request (a summary, a refresh) neither sets nor ends a hold; the ordinary entry and the held slot do
  not clear each other; the economics (the stop when the refreshes would cost more than the saving, unknown prices);
  `cacheWarming: "off"`; `direct` ignores `cache`; validation; the event's `key`; the ordinary entry behaves as before.
- `xpi-relay` (PR G): the route's `cache` per phase, with and without `warmLead`; a wrong `warmLead` names its key.
- Suite, faux provider (PR G): the tools and system prompt of the first lead request after a hand back equal those
  of the last lead request before the handover; a refresh is sent during a long worker phase (fake timers) and is on
  the branch as a usage entry.
- Real models (the lead runs them, budget $3): `relaunch and pause` and `workflows` twice each with the defaults.
  Pass: all pass; the first lead request after a hand back reads its prefix from the cache in the rounds longer than
  five minutes; the mean of the lead's cost plus the refreshes is not above the lead's cost in round 3 of the
  measurements ($0.20 and $0.34). If it is above, the default of `warmLead` becomes `false` and the numbers are
  recorded either way.

## Docs

`docs/relay.md`, `docs/settings.md`, `docs/virtual-models.md`, `docs/extensions.md`, `docs/porting.md`,
`packages/xpi-relay/README.md`, the settings schema, the measurements file.
