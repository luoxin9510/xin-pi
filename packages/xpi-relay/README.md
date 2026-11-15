# xpi-relay

Relay runs one conversation on two models. A strong model, the **lead**, explores, plans and reviews; a cheap model, the
**worker**, builds. The lead gives the work away with a `handover` tool; when the worker is done, acceptance commands are
run and the conversation is compacted to a hand-back record, which is all the lead reads of the worker's phase. Both
models work in one session, and every phase change and every repair is an entry on the branch and a line for the user.

This package is the logic: the transition table, the view read from session entries, the router, the prompts, the
hand-back record, the facts the lead decides with, the workspace helpers (git snapshot, diff, acceptance commands) and
the orchestration. It imports nothing of the coding agent. The coding agent's built-in `relay` extension
(`packages/xpi-coding-agent/src/extensions/relay/index.ts`) wires it to the agent core. User docs:
[relay.md](../xpi-coding-agent/docs/relay.md); porting: [porting.md](../xpi-coding-agent/docs/porting.md#relay).

Private: it is bundled into `xpi-coding-agent` and not published.

## The host interface

To use relay in another host, implement `RelayHost` once and build a `RelayCall` for each handler call, then forward the
host's events to what `createRelay(host)` returns.

```typescript
import { createRelay, type RelayCall, type RelayHost } from "xpi-relay";

const relay = createRelay(host); // registers the two hand tools through host.registerTools

// A virtual model: pick the physical model and the next stored router state for each request.
const route = relay.route(request, call);
```

`RelayHost` is what lives as long as the extension:

| Member | What it is |
|---|---|
| `appendEntry(type, data)` | Append a custom entry to the session branch. |
| `settings()` | The `relay` block of the settings, read at each use (the package validates it). |
| `sendMessage(message, options)` | `/handover` and `/handback` send a message for the model. |
| `activeTools()`, `setActiveTools(names)` | The direct fallback adds the hand tools to the active set while relay is selected. |
| `registerTools(specs)` | Called at the start and again when the exposure changes (codemode switched on or off). A `ToolSpec` carries the tool's name, description, typebox parameters, exposure and an `execute(params, signal, call)`. |

`RelayCall` is what one handler call carries: the branch as `RelayEntry[]` (read at each use, since the branch grows
while a call awaits), the selected model, `cwd`, the abort signal, `findModel(ref)` (the catalog's full model for
`provider/model`), `notify(text, level)` (a line for the user, never a message) and `isIdle()`.

`RelayEntry` is a small discriminated union on `type` (`message`, `custom`, `custom_message`, `compaction`, and the entry
types relay does not read) that the host's session entry must be assignable to. The router state is read from the
`custom` entry named `pi.virtual-model-state`, the name the agent core uses for virtual models (the package keeps its
own copy of the constant).

What `createRelay` returns, and which host event feeds it:

| Method | Fed by |
|---|---|
| `route(request, call)` | the virtual model's router |
| `section(call)` | the system prompt build (the `relay` section; `undefined` leaves the prompt alone) |
| `handover`, `handback` | the two tools (`ToolSpec.execute` calls them) |
| `onDirectCall(tool, call)` | every `tool_call` (it ignores all but top-level hand-tool calls made while codemode is on) |
| `onSessionStart`, `onBeforeAgentStart`, `onModelSelect` | the same events: tool sync, pause and resume |
| `beforeSettle(event, call)` | the end of a run: acceptance commands, the record, continuations; returns the entries to write |
| `commands.handover`, `commands.handback`, `commands.status` | `/handover`, `/handback`, `/relay` |

## The transition table

`transition(view, event, config)` is pure. Its rows are data in `src/definition.ts`, tried in order, on a small graph
engine in `src/graph/` (`defineGraph`, `transition`, `toMermaid`, `pairs`). The engine is internal: it is not exported
and carries no stability promise. `relayDiagram()` and `relayTable()` render the state diagram and the table of
[relay.md](../xpi-coding-agent/docs/relay.md) from the rows.

## Tests

```
cd packages/xpi-relay
npm run build   # needs xpi-ai and xpi-agent-core built first, for their types
npm test
```

`test/machine.test.ts` has an expectation for every row, `test/exhaustive.test.ts` enumerates every combination of
overlays and events, `test/graph.test.ts` covers the engine, and `test/host.test.ts` runs `createRelay` against a fake
host.
