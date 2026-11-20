# Spec 03: command nodes that survive a crash, and nested usage by model

Status: draft for the owner's approval. Grill R1–R11 accepted as recommended on 2026-11-20 ("全是", twice), and
the summary of the eleven decisions confirmed ("确认"); see `decisions.md`. Revised after review round 1 (2 blocking,
7 should-fix); one point the review raised is a new choice for the owner, marked **Owner** below (R12).

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
   Agent tool, a `models.*` call) report one summed `usage` with no model. When a background script's scope ends, the
   core writes that sum as a usage entry under the session's selected model (`agent-session.ts`,
   `_releaseNestedCalls`), which is `graph/auto` or `relay/auto` under a virtual model. In the end-to-end `dev` run
   (PR #145) the review node's reviewers ran on Opus for $0.73; the report says "nested calls", and the session's
   cost breakdown files it under `auto`.

## Goal

A command node says whether it may run twice. The engine writes that it is about to run a command before it runs
it, so after a crash it knows the command may have happened: a replay-safe command runs again, any other one stops
the graph and leaves the decision to the user. A nested call's usage keeps the model that spent it, in the session's
cost breakdown and in the graph report.

## Design

### 1. `replay` on command nodes (R2)

```js
ci:    { run: "gh pr checks --watch --fail-fast", replay: "safe" },
merge: { run: "gh pr merge --merge --delete-branch", replay: "unsafe" },
```

`replay` is `"safe"` or `"unsafe"`; a command node (a node with `run`) without it is `"unsafe"`. `parseGraph` rejects
any other value and rejects `replay` on a model node. Safe means: running the command again after it may have run,
fully or in part, does no harm (a check, a wait, a build).

### 2. Commands run outside a turn (R3)

Every command node runs on the path `/graph start` and `/graph goto` already use, where entries go straight to the
session. The end of a turn no longer runs commands.

**A command visit's runs.** Folded from the branch (section 3), the current visit on a command node is in one of
four conditions: **halted** (a `graph.halt` after its `graph.node`), **finished** (its last run finished),
**interrupted** (its last run has a `graph.run` and did not finish), or **not started** (no `graph.run` and not
halted). The engine starts a command only on a visit that is not halted, not finished, not running in this process
(`commandRun` is unset), and either not started or interrupted with a replay that allows it (section 4).

**At the end of a turn.** `agent_before_settle` with a pending move to a command node writes that node's
`graph.node` (a draft, as now) and returns without `continue`. It notes in memory that this process entered the
visit. At `agent_settled`, if the turn was not aborted and the noted visit is the current one and may start, the
extension updates the footer (`sync`) and then goes on as `/graph goto` does (`proceed` with direct writes and
`mayWait`), started from the hook and not awaited by it. Only a visit this process noted in memory starts without a
look at its `replay`. A visit entered at a settle that was aborted (Esc during the boundary) is **not started** and
noted, so it starts at the user's next action (section 4). A not-started visit this process did not note (found at
`session_start`: a crash between the commit and the start, or an older xpi that died during `/graph goto`, which
writes `graph.node` before it runs the command) may have run, so it follows its `replay` like an interrupted run.

A pending move to a model node or to `end` is entered at the end of the turn as now. A follow-up message the user
queued during the turn keeps the agent run going (`_runBeforeSettleBoundary` continues when messages are queued);
the command then starts when that run settles.

**What the user sees meanwhile** is what already happens after `/graph goto`: the session is idle while the command
runs; a message the user sends starts a turn answered by the model selected before the graph (the node is a command
node); the command's move is left pending until that turn ends; `/graph stop` stops the command; Esc does not.

**Without a UI** (`ctx.hasUI` false, as in `xpi -p`): a command the extension started holds the process.
- The extension keeps the promise of the command run it started (`commandRun`).
- `/graph start` and `/graph goto` without a UI return when the graph has ended, halted or waits for the user, as
  documented now: they wait in a loop for the session to be idle and for no command run to be pending, since a
  command's end can start a model turn and a turn's end can start a command.
- `session_shutdown` with reason `quit` and without a UI waits for a running command to end (its own timeout bounds
  it) instead of aborting it, so a prompt that is not a `/graph` command (`xpi -p "go on"`) does not kill a command it
  led to. After the wait the run's result is written as usual (the `graph.command` message, then the move or the
  halt; `closed` is set only after it), but no turn is started: the session is being disposed, so a move to a model
  node stays pending and is entered at the next run. Other shutdown reasons (new, resume, fork, reload) and every
  shutdown with a UI abort the command as now; on the next open that run reads as interrupted.

### 3. `graph.run`: the intent, written first (R4)

Before a command node runs its command, the extension writes a custom entry:

```
graph.run   { at, node, run, replay, startedAt }
```

then runs the command, then writes what it writes now (the `graph.command` message with details, then the move or
the halt). `startedAt` is the same value as the command details' `startedAt` and names the run.

**The session file is written first.** A session is not written to disk until it has a user or assistant message
(`SessionManager._persist`); a graph started as the first thing in a session, on a command node, would leave nothing
to reopen. Before the first `graph.run` the extension asks the session to be written now, through a small core
addition (an extension API to persist the session, named in the milestone). The milestone checks how `/resume`
lists a session that has graph entries and no message, and keeps it listed.

**Finished or interrupted.** Every entry a run writes as its result carries the run's `startedAt`: the `graph.command`
message (`details.startedAt`, as now), the move it leads to (`graph.move` with `via: "pass" | "fail"` gets
`runStartedAt`), and a halt it causes (stopped while running, no edge, an edge at its limit: `graph.halt` gets
`runStartedAt`). A run is **finished** when the branch has any entry carrying its `startedAt` in one of these
fields, wherever it landed (a message can be queued behind a turn the user started). A `graph.run` with none is
**interrupted**: the process ended while the command ran. Entries written for other reasons later in the visit (a
halt written because the run was interrupted, a `/graph goto`) do not finish it.

`readState` folds this into the current visit: its runs (each with `startedAt` and `finished`), whether the last is
interrupted, and the visit's condition from section 2. An older session without `graph.run` reads as before: a visit
with a `graph.command` is finished, a halted one is halted, and a command visit with neither is not started.

### 4. After a crash (R8, R9, R12)

At `session_start` the extension reads the state. With an interrupted or not-started run on the current visit it
**only tells** (nothing is written: the process that opened the session may only be looking, such as a viewer or the
roost hub):

- replay-safe, interrupted: `graph dev: "ci" was interrupted while its command ran; it runs again when you go on
  (any message, or /graph goto ci)`;
- replay-safe, not started: `graph dev: "ci" was entered and its command has no record of starting; it runs when you
  go on (any message, or /graph goto ci)`;
- not replay-safe, interrupted or not started: `graph dev: "merge" may have run its command (it was interrupted, or
  has no record). Check, then /graph goto merge to run it again, /graph goto <node> to go on, or /graph stop`.

Then, at the user's first action that would go on (`before_agent_start`, `/graph goto`):

- **noted by this process (section 2), or safe with fewer than 3 interrupted runs in this visit**: the command
  starts, a new `graph.run` first, and the graph goes on from its result.
  - **Owner (R12)**: at `before_agent_start` the command is started and not awaited, as at the end of a turn
    (section 2): the user's message is answered at once by the model selected before the graph, and the command's
    move waits for that turn to end. The other way, awaiting it, holds the message for the whole command (a
    `gh pr checks --watch` can take 10 minutes or more), which is how a pending command is entered today. A side
    effect: after a turn cut off by Esc whose move leads through a command node to a model node, the next message is
    answered by the pre-graph model, not by that model node.
- **unsafe and not noted, or safe and interrupted 3 times in this visit (R9)**: the extension writes `graph.halt {
  reason, interrupted: startedAt }` (no `startedAt` for a visit that was not started) (`"merge" may have run its
  command, and it is not replay-safe`, or `… was interrupted 3 times`), and the graph is halted on the command node with the rules of spec 01 for a halt there: the
  pre-graph model answers, the union of all `deny` lists holds, `next` is refused, only `/graph goto` and
  `/graph stop` move it. `/graph goto` writes the halt first, then its own move.

The assumption: one process runs a session at a time (the session file has a lock). A command still running in
another process is not looked for. A normal quit during a command also reads as interrupted on the next open; that
is right, and `docs/graph.md` says so.

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
default:

- `dev.js`: `branch` and `ci` are `"safe"` (`branch` run again is no longer on `main` and stops with its message);
  `merge` is `"unsafe"`.
- `release.js`: `ci`, `sync` (`git checkout main && git pull --ff-only`) and the node that waits for main's CI are
  `"safe"`; `patch`, `minor` (they change versions, commit, push and open a PR), `merge` and `tag` are `"unsafe"`.

`test/repo-graphs.test.ts` asserts that every command node of both graphs has `replay`.

### 7. Nested usage by model (R11)

A tool's result may carry `usageByModel: { provider, model, usage }[]`, the part of its `usage` spent by each
physical model. `usage` stays the total, so a caller that does not know the new field sees what it sees now. The sum
of `usageByModel` is at most `usage`; the rest is unattributed. A virtual model (`graph/auto`, `relay/auto`) never
appears in it: usage is attributed only to the model that answered (an assistant message's `responseModel`, else
`model`, resolved to a physical model), and what cannot be resolved stays unattributed.

**Who fills it.**
- **The Agent tool, from the child's own reports.** The child's runner already adds up the `usage` of each
  assistant message it receives; it also adds it per model, from that message's provider and `responseModel`. This
  is right when the child was started with a pattern, with `inherit` inside a graph node (`graph/auto`), on
  `relay/auto` (two physical models), or had its model switched while it ran. The tool's `model` field (`spec.model`)
  is not used for this. A background agent's cost stays uncounted (spec 02); its result has no usage.
- **Codemode's `models.*` calls.** They add their usage into the script result now, with no model; they add it under
  the model the call resolved to.

**How it travels.** The field is added to the types it passes through: `AgentToolResult` and `AfterToolCallResult`
in `xpi-agent-core`, `ToolResultMessage` in `xpi-ai`, the `tool_result` event and its result in the coding agent's
extension types; `agent-loop.ts` copies it where it copies `usage`.
- The nested-call recorder (`core/nested-tool-calls.ts`) keeps attributed usage per model for both its total and its
  unreported part (`takeUnreportedUsage`), so a detached scope hands each model's usage out once.
- A model-issued tool result message carries `usageByModel` merged from the tool's own result and its nested calls,
  as `usage` is merged now (`agent-session.ts`, the message-start merge). This covers the model calling the Agent
  tool directly, not from a script.
- A `tool_result` hook that returns `usage` without `usageByModel` drops the attribution (the new `usage` is all
  unattributed); a hook may return both.
- When a detached scope ends (`_releaseNestedCalls`), the core writes one usage entry per model with the real
  provider and model, and one for the unattributed rest under provider `unknown`, model `unattributed`, if any. It no
  longer writes the session's selected model.

**Where it is read.**
- `getUsageCostBreakdown` puts a tool result message's `usageByModel` under each model; the unattributed rest of a
  tool result and usage entries under `unknown/unattributed` share one key, `Tools/unattributed`; compaction and
  branch summaries stay under `Tools/summaries`.
- The graph report's `byModel` puts a visit's nested usage under the model that spent it, and only the unattributed
  rest (including `unknown/unattributed` entries) under `nested calls`. The visit's `own` / `tools` / `other` split
  does not change.
- Older sessions keep their `nested_tool_calls` entries under the model they were written with (the selected model,
  so possibly a virtual one or the wrong one); `docs/graph.md` says so.

The session format gains one optional field on tool result messages; older sessions read as before.

## Docs (in the same PRs)

- `docs/graph.md`: `replay`; commands run outside the turn (what the user sees meanwhile, `xpi -p`); `graph.run` and
  the `run` / `interrupted` fields in the entries table; what happens after a crash, a normal quit included;
  `interrupted ×N`, `runs`, `graph:run`; older sessions' nested usage.
- `docs/extensions.md`: `usageByModel` on a tool's result and in `tool_result`; the session-persist API.
- `docs/porting.md`: the graph unit (commands started at `agent_settled`, `graph.run`, the shutdown wait without a
  UI); the core's nested usage and the persist API.
- Where tool result messages and the cost breakdown are described: the new field and `Tools/unattributed`.
- The coding agent's README and the repo README where they describe graphs or the cost breakdown, if they do.

## Testing

- Package tests (`xpi-graph`): `parseGraph` with `replay`; `readState` for each condition: finished (by message,
  by a move or halt carrying `run`, by a message that landed late), interrupted, interrupted then halted then
  `goto` (the run stays interrupted), not started, halted (an old session halted on a command node is not started
  again), repeated runs, an old session without `graph.run`; `report` with `runs`.
- Suite tests (fake runner):
  - a command entered at the end of a turn runs after the turn settled, with `graph.run` on the branch before it
    starts; a message typed during it is answered and the move waits; a queued follow-up runs first; an aborted
    settle does not start it;
  - after a simulated crash (a branch ending in `graph.run`, or in a command node's `graph.node`), `session_start`
    writes nothing; a safe or not-started command starts at the next message (not awaited) and at `/graph goto`; an
    unsafe one halts with the reason; the third interrupted safe run halts;
  - the first `graph.run` of a new session is on disk;
  - without a UI, `/graph start` returns only after a command started at a settle and the turns after it; a prompt
    that leads to a command does not end before it (shutdown waits); with a UI, shutdown aborts it;
  - the `graph:run` event order.
- Core tests: per-model usage from a child's assistant messages, including a virtual model and a model switch; the
  recorder's per-model total and unreported part; a released scope writes one usage entry per model plus
  `unknown/unattributed`; a `tool_result` hook that replaces `usage`; the message-start merge; the cost breakdown
  with `usageByModel`.
- By hand, recorded in `decisions.md`: a graph of command nodes only (no model), started as the first thing in a new
  session, the process killed with `kill -9` while a `sleep` command runs, reopened: once with `replay: "safe"`, once
  without. Then the same with a Haiku 5.5 model node before the command node, checking the hand-over after the
  rerun; one `xpi -p "/graph start …"` run through a command node; and one Haiku run with a subagent in a node,
  checking `/graph` and the cost breakdown name the subagent's model.

## Milestones

1. **Replay** (`issues/07-replay.md`): sections 1–6, the persist API, the docs for them, package and suite tests, the
   by-hand kill runs.
2. **Usage by model** (`issues/08-usage-by-model.md`): section 7, its docs and tests, the by-hand subagent run.

Each: a branch, a PR, green CI, an independent Opus review, then merged. No release, no npm.
