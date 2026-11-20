# Spec 03: command nodes that survive a crash, and nested usage by model

Status: draft for the owner's approval. Grill R1–R11 accepted as recommended on 2026-11-20 ("全是", twice), and
the summary of the eleven decisions confirmed ("确认"); see `decisions.md`.

This is step 1 of three steps that borrow ideas from upstream's `pi-durable` (no code is ported, chord is not
brought in; spec 01's rule). Step 2 (a model turn cut off by a crash, in the core) and step 3 (waits that do not hold
a process, with roost) are not in this spec.

## Problem

1. **A command node runs again after a crash, whatever it does.** A command entered at the end of a turn runs inside
   `agent_before_settle`, where every entry is a draft: the `graph.node` of the command node, its `graph.command`
   message and the move it leads to are committed only after the command has run. When the process dies while the
   command runs (a kill, a closed laptop, a crash), the drafts are lost; the branch still holds the model's pending
   move, and the next run enters the node again and runs the command again. That is fine for `gh pr checks --watch`,
   and wrong for `gh pr merge`, `git tag` or `npm publish`: they may have happened already.
2. **Nobody can tell what a nested call cost by model.** A codemode script's nested calls (a subagent through the
   Agent tool, above all) report one summed `usage` with no model. When a background script's scope ends, the core
   writes that sum as a usage entry under the session's selected model (`agent-session.ts`, `_releaseNestedCalls`),
   which is `graph/auto` or `relay/auto` under a virtual model. In the end-to-end `dev` run (PR #145) the review
   node's reviewers ran on Opus for $0.73; the report says "nested calls", and the session's cost breakdown files
   it under `auto`.

## Goal

A command node says whether it may run twice. The engine writes that it is about to run a command before it runs
it, so after a crash it knows the command may have happened: a replay-safe command runs again, any other one stops
the graph and leaves the decision to the user. A nested call's usage keeps the model that spent it, in the session's
cost breakdown and in the graph report.

## Design

### 1. `replay` on command nodes (R2)

```js
ci:    { kind: "command", run: "gh pr checks --watch --fail-fast", replay: "safe" },
merge: { kind: "command", run: "gh pr merge --merge --delete-branch", replay: "unsafe" },
```

`replay` is `"safe"` or `"unsafe"`; a command node without it is `"unsafe"`. `parseGraph` rejects any other value
and rejects `replay` on a model node. Safe means: running the command again after it may have run, fully or in part,
does no harm (a check, a wait, a build).

### 2. Commands run outside a turn (R3)

Every command node runs on the path `/graph start` and `/graph goto` already use, where entries go straight to the
session. The end of a turn no longer runs commands:

- `agent_before_settle` with a pending move to a command node writes that node's `graph.node` (a draft, as now) and
  returns without `continue`. The turn settles.
- At `agent_settled`, when the branch is on a command node that has not run in this visit, the extension goes on as
  `/graph goto` does (`proceed` with direct writes and `mayWait`), started from the hook and not awaited by it.
- What happens meanwhile is what already happens after `/graph goto`: the session is idle while the command runs; a
  message the user sends starts a turn answered by the model selected before the graph (the node is a command
  node); the command's move is left pending until that turn ends; `/graph stop` stops the command; Esc does not.
- A pending move to a model node or to `end` is entered at the end of the turn as now.
- `before_agent_start` keeps entering a pending move before the next run (a turn cut off or a quit), and runs a
  command it reaches there, now with direct writes from the first entry on.

The visible change: during a command that a turn led to, the session no longer shows a running turn, and a message
typed meanwhile is answered at once (by the pre-graph model) instead of waiting behind the command.

### 3. `graph.run`: the intent, written first (R4)

Before a command node runs its command, the extension writes a custom entry:

```
graph.run   { at, node, run, replay, startedAt }
```

then runs the command, then writes what it writes now (the `graph.command` message with details, then the move or
the halt). `startedAt` is the same value as the command details' `startedAt`, which matches the two.

A visit's run is **finished** when, after its `graph.run`, the branch has the matching `graph.command` message
(same `details.node` and `startedAt`, wherever it landed) or any later `graph.node`, `graph.move`, `graph.halt` or
`graph.end`. A command's message can be queued behind a turn the user started; the move written next to it is not.
A `graph.run` with none of these is **interrupted**: the process ended while the command ran.

`readState` folds this into the current visit: the number of `graph.run` entries of the visit and whether the last
one is interrupted. An older session without `graph.run` reads as before.

### 4. After a crash (R8, R9)

At `session_start` the extension reads the state. With an interrupted run on the current visit it **only tells**
(nothing is written: the process that opened the session may only be looking, such as a viewer or the roost hub):

- replay-safe: `graph dev: "ci" was interrupted while its command ran; it runs again when you go on (any message, or
  /graph goto ci)`;
- not replay-safe: `graph dev: "merge" was interrupted while its command ran; it may have run. Check, then /graph
  goto merge to run it again, /graph goto <node> to go on, or /graph stop`.

Then, at the user's first action that would go on (`before_agent_start`, `/graph goto`):

- **safe, and fewer than 3 interrupted runs in this visit**: the command runs again, a new `graph.run` first, and the
  graph goes on from its result. A message's turn starts after it, as with any command entered at
  `before_agent_start`.
- **unsafe, or a safe command interrupted 3 times in this visit (R9)**: the extension writes
  `graph.halt { reason }` (`"merge" was interrupted while its command ran, and it is not replay-safe`, or `… was
  interrupted 3 times`), and the graph is halted on the command node with the rules of spec 01 for a halt there:
  the pre-graph model answers, the union of all `deny` lists holds, `next` is refused, only `/graph goto` and
  `/graph stop` move it. `/graph goto` writes the halt first, then its own move.

The assumption: one process runs a session at a time (the session file has a lock). A command still running in
another process is not looked for.

### 5. What a run shows (R10)

- `/graph`: the row of a visit with interrupted runs says `interrupted ×N` next to how it was left (or alone, when
  the visit is halted or still pending).
- `/graph --json`: a command visit has `runs: [{ startedAt, finished }]`, one per `graph.run`, oldest first. The
  field is new and optional; `schemaVersion` stays `1`.
- Bus event `graph:run` when a `graph.run` entry is written, with `{ graph, node, visit, at, run, replay }`, told in
  the same way and order as the other `graph:*` events (spec 02). There is no event for "interrupted": a listener
  sees a `graph:run` with no `graph:command` after it.

### 6. The repository's graphs (R5)

Every command node of `.pi/graphs/dev.js` and `.pi/graphs/release.js` states `replay`, even where it matches the
default: in `dev.js`, `branch` and `ci` are `"safe"` (`branch` run again is no longer on `main` and stops with its
message) and `merge` is `"unsafe"`; in `release.js`, a node that only reads or checks is `"safe"`, and a node that
changes versions, commits, tags or pushes is `"unsafe"`. `test/repo-graphs.test.ts` asserts that every command node
of both graphs has `replay`.

### 7. Nested usage by model (R11)

A tool's result may carry `usageByModel: { provider, model, usage }[]`, the part of its `usage` spent by each model.
`usage` stays the total, so a caller that does not know the new field sees what it sees now. The sum of
`usageByModel` is at most `usage`; the rest is unattributed.

- The Agent tool fills `usageByModel` with one item: the provider and id of the model its run used, and the run's
  usage. A background agent's cost stays uncounted (spec 02).
- The nested-call recorder (`core/nested-tool-calls.ts`) keeps the attributed usage per model besides the total.
  A nested result's `usageByModel` adds to it; usage without it is unattributed.
- A model-issued tool result message carries the `usageByModel` of its nested calls along with `usage`, as it
  carries `usage` now.
- When a detached scope ends (`_releaseNestedCalls`), the core writes one usage entry per model, with the real
  provider and model, and one more for the unattributed rest under provider `unknown`, model `unattributed`, if
  any. It no longer writes the session's selected model.
- `getUsageCostBreakdown` puts a tool result message's `usageByModel` under each model and the rest under
  `Tools/summaries` as now; usage entries keep their own provider and model.
- The graph report's `byModel` puts a visit's nested usage under the model that spent it, and only the unattributed
  rest under `nested calls`. The visit's `own` / `tools` / `other` split does not change.

The session format gains one optional field on tool result messages; older sessions read as before.

## Docs (in the same PRs)

- `docs/graph.md`: `replay`; commands run outside the turn (what the user sees meanwhile); `graph.run` in the
  entries table; what happens after a crash; `interrupted ×N`, `runs`, `graph:run`.
- `docs/extensions.md`: `usageByModel` on a tool's result.
- `docs/porting.md`: the graph unit (the `agent_settled` start of commands, `graph.run`); the core's nested usage.
- `docs/session.md` or wherever tool result messages are described: the new optional field.
- The coding agent's README and the repo README where they describe graphs or the cost breakdown, if they do.

## Testing

- Package tests (`xpi-graph`): `parseGraph` with `replay`; `readState` with finished, interrupted and repeated
  `graph.run`s, a message that landed late, an old session without `graph.run`; `report` with `runs`.
- Suite tests (fake runner): a command entered at the end of a turn runs after the turn settled, with `graph.run`
  on the branch before it starts; a message typed during it is answered and the move waits; after a simulated crash
  (a branch ending in `graph.run`), `session_start` writes nothing; then a safe command runs again at the next
  message and at `/graph goto`, an unsafe one halts with the reason, the third interrupted safe run halts; the
  `graph:run` event order.
- Core tests: the recorder keeps per-model usage; a released scope writes one usage entry per model plus the
  unattributed rest; the cost breakdown with `usageByModel`; the Agent tool's result carries it.
- By hand, recorded in `decisions.md`: a graph of command nodes only (no model), the process killed with `kill -9`
  while a `sleep` command runs, reopened: once with `replay: "safe"`, once without. Then the same with a Haiku 5.5
  model node before the command node, checking the hand-over after the rerun; and one Haiku run with a subagent in
  a node, checking `/graph` and the cost breakdown name the subagent's model.

## Milestones

1. **Replay** (`issues/07-replay.md`): sections 1–6, the docs for them, package and suite tests, the by-hand kill
   runs.
2. **Usage by model** (`issues/08-usage-by-model.md`): section 7, its docs and tests, the by-hand subagent run.

Each: a branch, a PR, green CI, an independent Opus review, then merged. No release, no npm.
