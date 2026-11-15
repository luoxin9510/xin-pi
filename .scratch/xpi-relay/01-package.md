# Spec 01: the xpi-relay package (step 1, no change of behaviour)

Status: approved by the owner on 2026-11-15 (direction and Grill 1 in `decisions.md`, all as recommended).

## Problem

Relay's control is a tested transition table since #117, but the table sits inside the coding agent, between about
600 lines of wiring in `extensions/relay/index.ts`: building the view from session entries, registering handlers on
five seams, carrying out effects, writing `relay.transition`, notifying. Two of those wirings are workarounds: the
lead-to-worker transition is recorded from inside `route()`, and the router learns of a handover from the last line
of a tool result's text.

## Goal

Relay is a workspace package, `xpi-relay`, that can be tested without the coding agent and ported by implementing
one interface. Its control flow is data on a small internal graph engine. Behaviour does not change. Then the two
workarounds are replaced by core seams.

Not in this spec (step 2, its own spec after measurement): the lead's context threshold, cache warming for the lead,
append instead of replace at a hand back, any new relay behaviour. Not planned: a general graph package, a graph the
user configures, more than one worker.

## Design

### 1. The package (decisions 1, 7)

`packages/xpi-relay`, private, version in step with the others, built with `tsc -p tsconfig.build.json`, tested with
`vitest --run`, laid out like `packages/xpi-shadow-git`. Dependencies: `xpi-ai` for message and model types, and
nothing from `xpi-coding-agent` or `xpi-agent-core` at run time.

| Now in `extensions/relay/` | Goes to |
|---|---|
| `machine.ts` | `xpi-relay/src/definition.ts` (relay's rows as data) on `src/graph/` (2) |
| `view.ts` | `xpi-relay/src/view.ts`; takes entries of a minimal `RelayEntry` type and the stored state as an argument |
| `router.ts`, `prompts.ts`, `record.ts`, `facts.ts`, `config.ts` | `xpi-relay/src/`, unchanged apart from the entry type |
| `workspace.ts` (git snapshot, diff, acceptance commands) | `xpi-relay/src/workspace.ts`; the process-tracking hook is a host call |
| `index.ts` | split: the orchestration (which event, which effects, in which order) to `xpi-relay/src/relay.ts`; the calls into the agent core stay in the coding agent |

`RelayEntry` is the shape the package reads: `{ type, id?, timestamp?, customType?, data?, message?, summary?,
details? }`, a structural subset of the coding agent's `SessionEntry`, so the coding agent passes its entries as they
are. The entry names, the router state shape `{ phase, round }`, the settings and the texts are byte-for-byte what
they are on main.

Registered wherever a workspace package is (the commit that added `xpi-shadow-git` is the list): root `package.json`
build order, `tsconfig.json` paths, `vitest.base.ts` aliases, `scripts/check-entry-graphs.mjs`, the coding agent's
`package.json` dependency, `tsconfig.build.json` and `examples/tsconfig.json`, the lockfile, the install lock, and
the bundle (the package is bundled like the other private ones).

### 2. The graph engine (decisions 2, 3, 6)

`xpi-relay/src/graph/`, internal: not re-exported from the package's `index.ts`.

```ts
interface Graph<View, Event extends { type: string }, Effect, Config> {
  name: string;
  /** How a view names its state, for the completeness check and the diagram. */
  stateOf(view: View): string;
  states: readonly string[];
  events: readonly Event["type"][];
  /** In order; the first row that matches wins. */
  rows: readonly Row<View, Event, Effect, Config>[];
  /** What an unmatched (state, event) pair does: nothing, or a refusal. */
  otherwise(view: View, event: Event): { next: View; effects: Effect[] };
}
interface Row<View, Event, Effect, Config> {
  from: string | readonly string[] | "*";
  on: Event["type"] | readonly Event["type"][];
  when?(view: View, event: Event, config: Config): boolean;
  label: string;                                   // one line, for the diagram and for /relay
  to?: string;                                     // for the diagram; the view comes from `step`
  step(view: View, event: Event, config: Config): { next: View; effects: Effect[] };
}
function defineGraph(graph): Graph;                // validates, throws on a bad definition
function transition(graph, view, event, config): { next: View; effects: Effect[]; row?: string };
function toMermaid(graph): string;                 // stateDiagram-v2
function pairs(graph): { state: string; event: string; rows: string[] }[];   // for exhaustive tests
```

- `defineGraph` refuses a definition where a row names a state or event that is not declared, where a declared
  state or event appears in no row, or where a row without `when` is followed by a row for the same (state, event)
  that can therefore never match. Guards make full reachability undecidable; the check is on what is declared, and
  the exhaustive test (Tests) covers the rest.
- Relay's states are `lead`, `lead:pending`, `worker`, `worker:pending`, `paused`, derived from the view by
  `stateOf` (the stored phase plus the pending and paused overlays). The stored state stays `{ phase, round }`.
- `definition.ts` holds relay's rows: the same decisions as `machine.ts` today, in the same order, one row per
  branch, each with the label that the docs table uses. `transition(view, event, config)` keeps its signature and is
  re-exported from the package, so the machine tests call it as they do now.
- The two-phase view (a hand-off is pending until the next request commits it, or is voided) stays in `view.ts`:
  it is relay's reading of its entries. The engine sees it only as states.

### 3. The host interface (decision 1)

```ts
interface RelayHost {
  entries(): readonly RelayEntry[];                 // the session branch
  storedState(): RelayState | undefined;            // the router state on the branch
  appendEntry(type: string, data: unknown): void;
  notify(text: string, level?: "info" | "warning" | "error"): void;
  settings(): unknown;                              // the `relay` block
  findModel(ref: string): RelayModel | undefined;   // price and id of a physical model
  cwd(): string;
  signal(): AbortSignal | undefined;
  trackChild(pid: number): void;                    // acceptance commands and git
  sendMessage(message, options): void;              // /handover, /handback
  codemodeActive(): boolean;
  verbose(): boolean;
}
function createRelay(host: RelayHost): {
  route(request): RelayRoute;                       // which role, which thinking level, the next stored state
  section(): string | undefined;                    // the `relay` prompt section, or none
  handover(params, signal): Promise<ToolOutcome>;   // the tools' execute
  handback(params): Promise<ToolOutcome>;
  onDirectCall(tool): void;
  onModelSelect(isRelay: boolean): void;
  beforeSettle(event): Promise<SettleResult | undefined>;
  commands: { handover(args): Promise<void>; handback(): void; status(): string };
  tools: ToolSpec[];                                // names, descriptions, parameter schemas
};
```

The built-in (`extensions/relay/index.ts`) becomes the adapter: it implements `RelayHost` on `ExtensionAPI` and
`ExtensionContext`, registers the virtual model, the two tools, the three commands and the handlers, and forwards
each to `createRelay`'s result. No decision is taken in it. The names above are the spec's intent; the implementer
may adjust signatures where the code needs it and lists each change.

### 4. Core seam: a commit point at the start of a request (decision 5)

After the move passes. Today `route()` records the lead-to-worker `relay.transition` itself, after resolving the
worker model so that a failing route writes nothing, and must not write it twice on a retry.

- New extension event `request_start`, fired once per request after the route is resolved and its state stored,
  before the context is built: `{ reason, model, routerState?, previousRouterState? }`. Handlers may append entries.
  Not fired when routing fails. A retry fires it again with the same states; the handler compares them.
- Relay records its committed transitions there (`previousRouterState.phase !== routerState.phase`), and `route()`
  becomes side-effect free.
- Docs: `docs/extensions.md` (the event, its place in the request order), `docs/porting.md`.

### 5. Core seam: a structured hand-off signal (decision 5)

After seam 4 passes. Today the handover is a marker line that must stay the last line of a tool result, which the
codemode result and the direct-call note are arranged around.

- `AgentToolResult` gains an optional `signal?: { type: string; data?: JsonValue }`: kept on the tool-result message
  in the session, never sent to the provider. Codemode copies the signal of the nested call that ended the script
  onto its own result; the direct-call repair keeps it.
- `ModelRouteRequest.messages` already carries tool results; `nextState()` reads `signal.type === "relay.handover"`
  with `data.round` instead of the last line. For sessions written before the change it still accepts the marker
  line (decision 7).
- The handover result keeps its neutral sentence and drops the marker line: the model no longer sees
  `<relay-handover .../>`. The worker's section names the handover by that sentence. This is the one text change of
  step 1, and it is why this seam comes last, with its own real Haiku runs.
- Docs: `docs/extensions.md`, `docs/codemode.md`, `docs/relay.md`, `docs/porting.md`.

### 6. Generated diagram (decision 6)

`npm run generate:relay-diagram` (in `xpi-relay`) writes the Mermaid diagram of `toMermaid(relayGraph)` between two
marker comments in `packages/xpi-coding-agent/docs/relay.md`; a test fails when the file is stale, as the settings
schema's does. The hand-written diagram and table of #117 are replaced by the generated diagram and a table
generated from the rows' labels.

## Tests

- `xpi-relay/test/machine.test.ts`: the 33 tests of `test/relay-machine.test.ts`, moved; only import paths change.
- `xpi-relay/test/graph.test.ts`: `defineGraph` refusals (undeclared names, unused state or event, a shadowed row),
  first-match order, `otherwise`, `toMermaid` of a three-state sample, `pairs`.
- `xpi-relay/test/exhaustive.test.ts`: for every pair from `pairs(relayGraph)` and every combination of the overlays
  (pending, paused, blocked, user-asked, mixups 0-2, stalls 0-2), `transition` returns without throwing, and the old
  `machine.ts` (kept in the test directory as a reference copy until this spec is done) returns the same result.
- `xpi-relay/test/host.test.ts`: `createRelay` against a fake `RelayHost` for the flows the suite covers at the unit
  level (handover, hand back, acceptance failure, void, pause).
- `xpi-coding-agent/test/suite/relay.test.ts`: the 29 tests, unchanged, through the move and seam 4. Seam 5 changes
  the assertions that name the marker line; each changed assertion is listed in the tickets.
- Seam tests: `request_start` (order, not fired on a failed route, fired again on retry) in the agent-session suite;
  `signal` on tool results (kept in the session, absent from the provider payload, copied by codemode, kept by the
  direct-call repair).
- Real Haiku, on a build made with `npm ci` and `npm run build` in the worktree (symlinked dependencies load main's
  builds): `npm run test:relay:real`, and five manual sessions watching the worker's first move, after the move,
  after seam 4 and after seam 5.

## Docs

`packages/xpi-relay/README.md` (new: what the package is, the host interface, the engine as internal);
`docs/relay.md` (generated diagram and table, the package, seams 4 and 5); `docs/extensions.md`; `docs/codemode.md`;
`docs/porting.md` (relay: copy the package, implement `RelayHost`; the two seams as host requirements);
`docs/xin-pi.md` and the root and coding-agent READMEs where packages are listed.
