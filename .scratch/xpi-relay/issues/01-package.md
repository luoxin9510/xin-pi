# Tickets: spec 01, the xpi-relay package

Spec: `.scratch/xpi-relay/01-package.md`. Three PRs, each with an independent Opus review, green CI, the docs and the
real Haiku runs (the lead runs them) before merge.

## PR A: the move (no change of behaviour)

- [x] A1 the package skeleton, registered in each place the spec lists; build order after `xpi-ai` and
      `xpi-agent-core`; a devDependency of the coding agent; `build:binary` checked
      Done: `packages/xpi-relay` (package.json, tsconfig.build.json, vitest.config.ts) registered in root `package.json` (both builds, after `xpi-agent-core`), `tsconfig.json`, `vitest.base.ts`, `check-entry-graphs.mjs`, the coding agent's `package.json` (devDependency, and `build:binary` builds it after `xpi-agent-core`), `tsconfig.build.json`, `examples/tsconfig.json`, the lockfile; the install lock needed no change. `npm run build` of the coding agent bundles the package.
- [x] A2 the graph engine in `src/graph/`: `defineGraph` with its refusals, `transition`, `toMermaid`, `pairs`; tests
      Done: `src/graph/graph.ts` (`defineGraph`, `transition`, `toMermaid`, `pairs`), internal; `test/graph.test.ts`, 14 tests.
- [x] A3 relay's definition as rows; the machine's exports kept; the 33 machine tests moved (import paths only); the
      exhaustive test (overlays and event payloads) against the reference copy of `machine.ts`; at the end of this
      PR the copy and the comparison go, the enumeration stays
      Done: `src/definition.ts` has 26 rows; the 33 machine tests moved (import path only); the exhaustive comparison against the reference copy passed on 31104 combinations (432 views x 34 events x 2 `maxRounds`); the reference copy and the comparison are deleted, the enumeration stays as a no-reference test.
- [x] A4 the pure modules moved (`view`, `router`, `prompts`, `record`, `facts`, `config`, `workspace`) on
      `RelayEntry`
      Done: `view`, `router`, `prompts`, `record`, `facts`, `config`, `workspace` moved with `git mv`; `view.ts` and `facts.ts` read `RelayEntry` (`src/entry.ts`); `view.ts` keeps its own `VIRTUAL_MODEL_STATE_ENTRY`.
- [x] A5 `RelayHost`, `RelayCall` and `createRelay`; the built-in as the adapter; `host.test.ts`; the 29 suite tests
      with unchanged assertions (imports point at the package); the state-entry constant pinned
      Done: `src/host.ts`, `src/relay.ts` (`createRelay`); `extensions/relay/index.ts` is the adapter (151 lines, no decision); `test/host.test.ts` (16 tests); the 29 suite tests pass with unchanged assertions (only imports changed); `test/relay-package.test.ts` pins the constant.
- [x] A6 `relayDiagram()` and `relayTable()`; `generate:relay-docs` and its staleness test in the coding agent
      Done: `src/docs.ts` (`relayDiagram`, `relayTable`), `scripts/generate-relay-docs.ts`, `npm run generate:relay-docs`, `test/relay-docs.test.ts`; `docs/relay.md` holds the generated blocks between marker comments.
- [x] A7 docs: the package README, `relay.md`, `porting.md`, `xin-pi.md`, the READMEs
      Done: `packages/xpi-relay/README.md`, `relay.md`, `porting.md`, `docs/xin-pi.md`, the root and coding-agent READMEs.
- [ ] A8 real Haiku runs

## PR B: the commit point

- [x] B1 core: the `request_start` event; tests; `docs/extensions.md`
      Done: `RequestStartEvent` in `extensions/types.ts` (typed in `ExtensionAPI.on`, exported), emitted from
      `prepareRequest` in `agent-session.ts` through the runner's generic `emit`; four tests in
      `test/suite/virtual-models.test.ts` (order, failed route, retry, physical model).
- [x] B2 `onRequestStart`: relay records committed transitions there; `route()` without side effects; suite tests unchanged
      Done: `onRequestStart(event, call)` in `relay.ts`, `RelayRequestStart` in `host.ts`, the adapter subscribes
      `request_start`. No assertion of `test/suite/relay.test.ts` changed. One assertion of
      `xpi-relay/test/host.test.ts` changed (see below). `exhaustive.test.ts` untouched.
- [ ] B3 docs (`relay.md`, `porting.md`) and real Haiku runs
      Done (docs): `relay.md`, `porting.md`, `xpi-relay/README.md`, `extensions.md`, `virtual-models.md`. The real
      Haiku runs are left to the lead.

## PR C: the hand-off signal

- [x] C1 core: `signal` on tool results (session only, not sent to the provider); codemode copies the ending call's
      signal; the loop, the runner's rebuild and the direct-call repair carry it; tests
      Done: `ToolResultSignal` in `xpi-ai`, `signal` on `AgentToolResult` and `ToolResultMessage`; copied in
      `createToolResultMessage`; the `tool_result` event shows it read-only; codemode copies it from the terminating
      call. Tests: `xpi-ai/test/tool-result-signal-payload.test.ts` (Anthropic, OpenAI completions),
      `xpi-agent-core/test/agent-loop.test.ts` (kept through an `afterToolCall` that rewrites content),
      `xpi-coding-agent/test/suite/tool-result-signal.test.ts` (codemode copy and non-copy, direct-call repair,
      extension `tool_result` handler, session file and reload).
- [x] C2 relay: `nextState()` reads the signal and still accepts the marker line of older sessions; the handover
      result drops the marker line; `handoverLanded` and the worker's section follow; the changed suite and
      machine-test assertions listed here
      Done: `handoverRoundOf` (router.ts) reads the signal, else the old last-line marker; the handover result is the
      neutral sentence plus `signal: { type: "relay.handover", data: { round } }`; `ToolOutcome.signal`, passed on by
      the adapter; the worker's section quotes the sentence; generated `relay.md` regenerated (two doc cells).
- [ ] C3 docs (`extensions.md`, `codemode.md`, `relay.md`, `porting.md`) and real Haiku runs
      Done (docs): `extensions.md`, `codemode.md`, `relay.md`, `porting.md`, `xpi-relay/README.md`. The real Haiku
      runs are left to the lead.

## Changed assertions (PR C)

- `xpi-relay/test/exhaustive.test.ts`: the pinned SHA-256 digest changed on purpose (`32fa6292...` to
  `dded7871...`): the handover result text lost its marker line and the effect gained `signal`.
- `xpi-relay/test/machine.test.ts`, "lead | handover: ...": the result is now the neutral sentence (no
  `\n<relay-handover round="2"/>`) with `signal: { type: "relay.handover", data: { round: 2 } }`; title changed.
- `xpi-relay/test/host.test.ts`: "writes the entry, answers with the marker...": it expected the last line to be the
  marker; it now expects the exact sentence and `outcome.signal`. "makes the worker answer the next request" and
  "continues a landed handover" and "voids a handover" (title only) pass the outcome's signal on the fake tool
  result, since the text no longer holds a marker. New: "still continues a handover of an older session".
- `test/suite/relay.test.ts`: the first test (worker section quotes the sentence, no marker in the worker's
  context; was `toContain(handoverMarker(1))`), the codemode-off test (`toContain("Handed over to the worker model
  (round 1)")`), the direct-call test (`...written by the lead.` and no marker, was `\n${handoverMarker(1)}`), the
  parallel test (splits on the sentence, not the marker), and the `nextState` tests: `handoverResult` now carries the
  signal; the old marker-line cases moved to "accepts the handover of an older session" (unchanged bodies); new
  "accepts a handover from the signal ...".
- `test/suite/relay.test.ts` worker section: `<relay-handover round="N"/>` is replaced by "the tool result that says
  `Handed over to the worker model (round N)`"; `/handover` by the user keeps `<relay-handover-by-user>`.

## Deviations (PR C)

- `ToolResultSignal` is an exported interface of `xpi-ai` (and imported by agent-core), not an inline type.
- The `tool_result` event gains a read-only `signal`; the handler result type has no `signal`, so no handler can
  replace or drop it (the loop's merge spreads the original result).
- `handoverResult`/`handoverResultStart` live in `router.ts` (so `prompts.ts` can quote the sentence without a
  cycle); `handoverMarker` and `lastLineHandoverRound` stay, for older sessions.
- The signal is copied only for a terminating nested call that ended the script (`endedByCall`).

## Changed assertions (PR B)

- `xpi-relay/test/host.test.ts`, "makes the worker answer the next request, and writes the transition then": it
  expected `route()` to append `relay.transition` and notify. It now expects `route()` to write nothing, then
  `onRequestStart` to write the entry and the notice, and a second `onRequestStart` with equal states (a retry) to
  write nothing.
- New, not changed: `host.test.ts` "reads the same view whether relay.transition precedes or follows the state entry".
- `test/suite/relay.test.ts`: none. Its "writes no transition when the worker model cannot be resolved" already held
  (the old `route()` resolved the model before writing).

## Deviations (PR B)

- `onRequestStart` records only a lead-to-worker change (previous phase lead or absent, current phase worker), not
  every `previousRouterState.phase !== routerState.phase`: the hand back is written by `beforeSettle` and the next
  request's state change would otherwise record it twice.
- `RelayRequestStart` is a package type with the two state fields only (the package does not depend on the core's
  event type); the core event's `routerState` is `route.state ?? previous state` when the router returns no state.
- For a physical model, `reason` is computed the same way as for a virtual one (`user`, `continuation`, `retry`).

## Deviations (PR A)

- `RelayEntry`'s catch-all is `OtherEntry`, which lists the entry types relay does not read, instead of an open
  `type: string`: an open member stops `type` from narrowing the other members. A new core entry type makes the
  adapter fail to compile until it is added.
- `ToolSpec` carries `execute(params, signal, call)`, so the adapter registers every spec the same way and holds no
  name-to-handler switch. `createRelay`'s result still has `handover` and `handback`.
- `section(call)` returns `{ text } | undefined`: `undefined` leaves the prompt alone (wrong settings, as today),
  `{ text: undefined }` removes the section. The plain `string | undefined` could not tell the two apart.
- `SettleEvent` is `{ outcome, contextMessages }` without `entries`: relay only copied them back. `SettleResult`
  holds relay's own drafts, and the adapter writes `[...event.entries, ...result.entries]`, the order of today.
- `onDirectCall(tool, call)` takes `{ name, parentToolCallId }` and filters itself, so the adapter filters nothing.
- `commands.status(call)` returns `{ text, level }` (`info`, or `error` for wrong settings) instead of a string, so the
  error line of today needs no decision in the adapter.
- `RelayCall.entries`, `model` and `signal` are getters on the adapter side: the handover tool reads the branch twice
  around an await and must see what was appended in between.
- The docs table has one row per branch of `machine.ts`, so it is longer than the table of #117 (a refusal row for a
  paused relay, the `/handover` and `/handback` commands, the voided and continued handover, the first and second wrong
  role call). The diagram labels its edges with event names and draws the pending-hand-off row as a note.
- `toMermaid` draws a `from: "*"` row as a note beside the first state (the spec said "drawn once as a note"); the
  `paused` note is added by `relayDiagram()`.
- The package index re-exports every module, not only the names the spec lists; the graph engine stays out.
- A5 and A6 are one commit: the pre-commit check runs on the working tree, and the generator needs `relayDiagram`.
  The lockfile commit needed `PI_ALLOW_LOCKFILE_CHANGE=1` (a new workspace package, intended).
- After review: the adapter assigns `getBranch()` to `readonly RelayEntry[]` without a cast, so the first deviation's
  promise holds; `cwd` is a getter; the package index no longer exports `relayGraph` or the engine's types (only the
  machine's names); `Row` has an optional `label` for diagram edges; a row for the lead's second stall was added to the
  table (no change of behaviour); the exhaustive test pins a SHA-256 digest of all outputs, which PR C updates on purpose.
