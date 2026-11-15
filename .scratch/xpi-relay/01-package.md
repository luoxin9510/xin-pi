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
`vitest --run`, laid out like `packages/xpi-shadow-git`.

- Dependencies: `xpi-ai` (message and model types, and `Model` values it passes through) and `typebox` (the two
  tools' parameter schemas move with the tools). `xpi-agent-core` as a type-only devDependency, for `AgentMessage`.
  Nothing from `xpi-coding-agent`.
- It is a **devDependency** of the coding agent, like the other private packages (`scripts/check-runtime-deps.mjs`):
  the bundle carries it.
- Build order: after `xpi-ai` and `xpi-agent-core` (it reads their built types), before `xpi-coding-agent`. The other
  private packages are built before `xpi-ai` today; this one cannot be.

| Now in `extensions/relay/` | Goes to |
|---|---|
| `machine.ts` | `xpi-relay/src/definition.ts` (relay's rows as data) on `src/graph/` (2); `effectiveState`, `initialView`, `MAX_REPAIRS` and the types keep their names |
| `view.ts` | `xpi-relay/src/view.ts`, on `RelayEntry` |
| `router.ts`, `prompts.ts`, `record.ts`, `facts.ts`, `config.ts` | `xpi-relay/src/`, unchanged apart from the entry type |
| `workspace.ts` (git snapshot, diff, acceptance commands) | `xpi-relay/src/workspace.ts`, unchanged: it spawns and kills its own process groups today and keeps doing so |
| `index.ts` | split: the orchestration (which event, which effects, in which order) to `xpi-relay/src/relay.ts`; the calls into the agent core stay in the coding agent |

`RelayEntry` is the shape the package reads, a small discriminated union on `type` that the coding agent's
`SessionEntry` is assignable to: `message` (with `message: AgentMessage`, narrowed on `role` as `view.ts` does),
`custom` (`customType`, `data`), `custom_message`, `compaction` (`summary`, `details`), and a catch-all for the
rest; each with `id` and `timestamp` where `view.ts` and `facts.ts` read them.

`view.ts` resets its overlays when it passes a virtual-model state entry of relay, so it needs that entry's name and
position, not only the stored state. The package keeps its own constant `"pi.virtual-model-state"` and reads the
stored state from the entries itself; a test in the coding agent pins the constant to `VIRTUAL_MODEL_STATE_ENTRY`.

The package's exported surface is what the built-in and the tests use today: `createRelay` and the host types (3);
`transition`, `effectiveState`, `initialView`, `MAX_REPAIRS` and the machine's types; `readRelayConfig`,
`splitModelRef`, `nextState`, the marker helpers, `buildRecord`, the facts functions, the entry-name constants. The
graph engine is not among them. The entry names, the router state shape `{ phase, round }`, the settings and the
texts are byte-for-byte what they are on main.

Registered in each of these, explicitly: root `package.json` (build order, both `build` and `build:offline`), root
`tsconfig.json` paths, `vitest.base.ts` aliases, `scripts/check-entry-graphs.mjs`, the coding agent's `package.json`
(devDependency), `tsconfig.build.json` and `examples/tsconfig.json`, the lockfile, and the regenerated install lock.
The bundle script, the release scripts and CI's `test (other)` pick up a new package without edits; the implementer
checks `build:binary`, which lists packages by hand. The comment in `core/settings-schema.ts` that points at the
relay config gets the new path.

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
  /** What an unmatched (state, event) pair does, per event type: nothing, or a refusal. A new event without an
   *  entry here does not compile. */
  otherwise: { [T in Event["type"]]: (view: View, event: Event) => { next: View; effects: Effect[] } };
}
interface Row<View, Event, Effect, Config> {
  from: string | readonly string[] | "*";
  on: Event["type"] | readonly Event["type"][];
  when?(view: View, event: Event, config: Config): boolean;
  doc: { view: string; event: string; next: string; effects: string };   // the docs table's four columns
  to?: string;                                     // for the diagram; the view comes from `step`
  diagram?: false;                                 // keep the row out of the diagram (it stays in the table)
  step(view: View, event: Event, config: Config): { next: View; effects: Effect[] };
}
function defineGraph(graph): Graph;                // validates, throws on a bad definition
function transition(graph, view, event, config): { next: View; effects: Effect[]; row?: string };
function toMermaid(graph): string;                 // stateDiagram-v2
function pairs(graph): { state: string; event: string; rows: string[] }[];   // for exhaustive tests
```

- `defineGraph` refuses a definition where a row names a state or event that is not declared, where a declared
  state appears in no row's `from`, or where a row without `when` is followed by a row for the same (state, event)
  that can therefore never match. An event may be answered by `otherwise` alone. Guards make full reachability
  undecidable; the check is on what is declared, the typed `otherwise` covers "every event has an answer", and the
  exhaustive test (Tests) covers the rest.
- Relay's states are `lead` and `worker` (the stored phase). Pending, paused, blocked, user-asked, mixups and stalls
  stay overlays on the view, read by guards. Paused and pending can both be true today (a `model_away` with a
  pending hand back), and the pending answer ("already") wins over the paused refusal: the first row is `from: "*"`,
  `on` handover or handback, `when` pending, so the order of today's early returns is the order of the rows. The
  stored state stays `{ phase, round }`.
- `definition.ts` holds relay's rows: the same decisions as `machine.ts` today, in the same order, one row per
  branch, each with the four cells the docs table shows. `transition(view, event, config)` keeps its signature and is
  re-exported from the package, so the machine tests call it as they do now.
- The two-phase view (a hand-off is pending until the next request commits it, or is voided) stays in `view.ts`:
  it is relay's reading of its entries. The engine sees it only through the rows' guards.

### 3. The host interface (decision 1)

Today's handlers read most things from a per-call context (the branch, the working directory, the abort signal, the
selected model), and the handover tool uses its own `signal` argument. So the interface has two parts: what the host
is, and what one call carries.

```ts
interface RelayHost {                                // lives as long as the extension
  appendEntry(type: string, data: unknown): void;
  settings(): unknown;                               // the `relay` block, read at each use
  sendMessage(message, options): void;               // /handover, /handback
  activeTools(): string[];
  setActiveTools(names: string[]): void;
  registerTools(specs: ToolSpec[]): void;            // called again when the exposure changes (codemode on or off)
}
interface RelayCall {                                // one handler call
  entries: readonly RelayEntry[];                    // the session branch
  model: { provider: string; id: string } | undefined;   // the selected model, for "is relay selected"
  cwd: string;
  signal: AbortSignal | undefined;
  findModel(ref: string): Model<Api> | undefined;    // the catalog's full model: `route` returns it
  notify(text: string, level?: "info" | "warning" | "error"): void;   // the adapter: the UI, or stderr in print mode with --verbose
  isIdle(): boolean;
}
function createRelay(host: RelayHost): {
  route(request, call): RelayRoute;                  // the physical model, the thinking level, the next stored state
  section(call): string | undefined;                 // the `relay` prompt section, or none
  handover(params, signal, call): Promise<ToolOutcome>;
  handback(params, call): Promise<ToolOutcome>;
  onDirectCall(tool, call): void;
  onSessionStart(call): void;                        // tool sync
  onBeforeAgentStart(call): void;                    // tool sync when codemode was switched
  onModelSelect(model, call): void;                  // tool sync, pause and resume
  beforeSettle(event: SettleEvent, call): Promise<SettleResult | undefined>;
  commands: { handover(args, call): Promise<void>; handback(call): void; status(call): string };
};
```

- `SettleEvent` is what relay reads of `agent_before_settle` today: `outcome`, the boundary `entries`, and the
  context messages (for the worker's last text). `SettleResult` is `{ entries: RelayDraft[]; continue: boolean }` (false when there are entries to write but the run
  ends, as after a voided handover), where
  `RelayDraft` is the package's own union of the three drafts relay writes (`custom`, `custom_message`,
  `compaction`), which the adapter passes on as `SessionBoundaryDraft`s.
- `onDirectCall` receives every top-level `tool_call` of a hand tool and decides itself whether it was a repaired
  direct call (not the direct fallback, no parent call): the adapter filters nothing.
- `ToolSpec` carries a tool's name, label, description, typebox parameters, effect, and its exposure and listing
  (`deferred` and unlisted with codemode, `direct` without); `registerTools` is how the direct fallback switches.
- The built-in (`extensions/relay/index.ts`) becomes the adapter: it keeps the `XPI_SUBAGENT_DEPTH` guard,
  implements `RelayHost` on `ExtensionAPI`, builds a `RelayCall` from each handler's context, registers the virtual
  model, the commands and the handlers, and forwards each to `createRelay`'s result. No decision is taken in it.
- The names above are the spec's intent; the implementer may adjust signatures where the code needs it and lists
  each change under Deviations.

### 4. Core seam: a commit point at the start of a request (decision 5)

After the move passes. Today `route()` records the lead-to-worker `relay.transition` itself, and must not write it
twice on a retry.

- New extension event `request_start`, fired once per request right after the routed state is stored on the branch
  (`agent-session.ts`, where the virtual-model state entry is appended) and before threshold compaction and the
  context transform: `{ reason, model, routerState?, previousRouterState? }`. The message projection is built before
  routing, so this is not "before the context is built"; it is "after the route is committed". Handlers may append
  entries. Not fired when routing or resolving the physical model fails. A retry fires it again with the same
  states; the handler compares them.
- Relay records its committed transitions there (`previousRouterState.phase !== routerState.phase`), and `route()`
  becomes side-effect free. `createRelay`'s result gains `onRequestStart(event, call)` in PR B, which appends the
  entry and notifies.
- Two visible differences, both intended: `relay.transition` now follows the state entry instead of preceding it
  (`readView` does not depend on the order; a test pins that), and a transition is no longer written when the
  physical model then fails to resolve (missing credentials), which it is today.
- Docs: `docs/extensions.md` (the event, its place in the request order), `docs/porting.md`.

### 5. Core seam: a structured hand-off signal (decision 5)

After seam 4 passes. Today the handover is a marker line that must stay the last line of a tool result, which the
codemode result and the direct-call note are arranged around.

- `AgentToolResult` and the `ToolResultMessage` of `xpi-ai` gain an optional `signal?: { type: string; data?:
  JsonValue }`: kept on the tool-result message in the session, never sent to the provider, as `nestedCalls` is
  today. It has to be carried through each place a result is rebuilt: `createToolResultMessage` and the
  `afterToolCall` merge in `agent-loop.ts`, the extension runner's `tool_result` rebuild (which drops unknown
  fields), and codemode's capture of the call that ended the script (`execute.ts`), which copies that call's signal
  onto the codemode result. The direct-call repair keeps it.
- `nextState()` and `handoverLanded` (in `view.ts`) read `signal.type === "relay.handover"` with `data.round`
  instead of the last line. For sessions written before the change both still accept the marker line (decision 7).
- The handover result keeps its neutral sentence and drops the marker line: the model no longer sees
  `<relay-handover .../>`. The worker's section (`prompts.ts`) names the handover by that sentence instead of
  quoting the marker. This is the one text change of step 1, and it is why this seam comes last, with its own real
  Haiku runs.
- Assertions that name the marker change in the suite and in the machine tests; each is listed in the tickets.
- Docs: `docs/extensions.md`, `docs/codemode.md`, `docs/relay.md`, `docs/porting.md`.

### 6. Generated diagram (decision 6)

The engine is internal, so the package exports two functions built on it, `relayDiagram()` (Mermaid) and
`relayTable()` (the four-column table from the rows' `doc` cells). The diagram has the two states and a `paused`
note; a row with `to` is an edge, a row without one is a self-loop on its `from` unless it sets `diagram: false`
(refusals and corrections do, so they appear in the table only), and a `from: "*"` row is drawn once
as a note beside the diagram, not as an edge from every state. The generator and its staleness test live in the
coding agent, next to `generate:schemas`: `npm run generate:relay-docs` writes both between marker comments in
`packages/xpi-coding-agent/docs/relay.md`, and a test fails when the file is stale. They replace the hand-written
diagram and table of #117; the table keeps its View, Event, Next and Effects columns.

## Tests

- `xpi-relay/test/machine.test.ts`: the 33 tests of `test/relay-machine.test.ts`, moved; only import paths change
  (`transition`, `effectiveState`, `initialView`, `MAX_REPAIRS` come from the package).
- `xpi-relay/test/graph.test.ts`: `defineGraph` refusals (undeclared names, an unused state, a shadowed row), an event answered only by
  `otherwise` loads,
  first-match order, `otherwise`, `toMermaid` of a three-state sample, `pairs`.
- `xpi-relay/test/exhaustive.test.ts`: for both phases, every combination of the overlays (pending handover,
  pending handback, paused, blocked, user-asked, mixups 0-2, stalls 0-2) and every event with every payload
  (`byUser`; `status`; `afterRelayError`, `handoverLanded`, `workerIdle`; `passed` with `attempt` below, at and
  above `maxRounds`; `tool`), `transition` returns the same result as the old `machine.ts`, kept in the test
  directory as a reference copy. At the end of PR A the copy and the comparison are deleted (they pin texts that
  PR C changes); the enumeration stays as a test that every combination returns a result with a valid next view and
  known effect types, so the rows stay guarded.
- `xpi-relay/test/host.test.ts`: `createRelay` against a fake `RelayHost` for the flows the suite covers at the unit
  level (handover, hand back, acceptance failure, void, pause).
- `xpi-coding-agent/test/suite/relay.test.ts`: the 29 tests, their assertions unchanged through the move and seam
  4; its imports of `config`, `facts`, `record` and `router` point at the package. Seam 5 changes the assertions that
  name the marker line, here and in the machine tests; each changed assertion is listed in the tickets.
- The coding agent pins the package's state-entry constant to `VIRTUAL_MODEL_STATE_ENTRY`.
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
