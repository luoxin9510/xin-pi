# Spec 02: what a graph run shows

Status: draft for the owner's approval. Grill 1 of this spec (O1–O9, all as recommended) is in `decisions.md`.

## Problem

A running graph shows little: the footer (`graph dev: build (2/3)`), one line per start, move, halt, block and end,
and `/graph` with the node, the nodes visited and the loop counts. What it does not show:

- what each node cost, in money, tokens and cache, and how long it took;
- what a command node is doing while it runs: `ci` may wait 45 minutes behind one line, "running "ci": …";
- anything at all once the graph has ended: `/graph` says "no graph is running";
- anything a program can read: the result of a command node is text only, and nothing is emitted for other
  extensions (herdr, the roost hub).

The graph's state already lives in the session's entries (spec 01, section 4); everything above can be computed
from them, or from a few more fields in the entries that are written anyway.

## Goal

A graph run you can follow while it runs and read back after it ended: where it is, what it does, what each visit
cost, how it left each node. The same report as JSON, and the same moments as events on the extension bus.

Not in this spec (decision O8 and the PRD's "later" table): a cost budget, stopping a graph that overspends,
OpenTelemetry export, a full-screen graph view, changes to herdr or the roost hub, the cost of background agents
(below).

## Design

### 1. One source: the session branch (O1)

The report is a pure function of the branch, `report(entries)` in `xpi-graph`, next to `readState`. It reads the
graph's own entries and the usage the session already records. Nothing new is stored for the report beyond the
fields of sections 3 and 4. A resumed session, a branch made with `/tree` and a session opened later show the same
report, because they are the same entries.

The run reported is the last `graph.start` on the branch and what follows it, running or ended. Earlier runs on the
branch are not reported (one run at a time is what `/graph` is for; the JSON keeps the same shape for each run, so
more can be added later). When `readState` cannot read the run (`status: "error"`), the report has
`status: "error"`, the message, and the visits it could read up to the bad entry.

**Times.** An entry's `timestamp` is when it was committed, not when it happened: the entries of a move entered at
the end of a turn are drafts (`agent_before_settle`), committed together after the command nodes they cause have
run, so they share one timestamp. Every graph entry the extension writes therefore carries its own time in its
data, `at` (ISO, taken when the entry is made, draft or not): `graph.start`, `graph.node`, `graph.move`,
`graph.halt`, `graph.blocked`, `graph.asked`, `graph.end`. The report uses `data.at` and falls back to the entry's
`timestamp` for entries written before this spec (such a session's times can be off by the length of a command).
A command node's details (section 3) carry its own `startedAt` and `durationMs`.

### 2. Accounting per visit (O2)

A visit is one entry into a node. Its entries (for usage) are those from its `graph.node` entry to the next
`graph.node`. For the last visit of an ended run, the entries after `graph.end` count only for the rest of the agent
run that wrote it: tool results and assistant messages (`own` and `tools`, never `other`) up to and including the
first assistant message with no tool call, and never past a user message or the next `graph.start`. `graph.end`
records `duringRun` (whether an agent run was going on when it was written); after an end written while the session
was idle (`/graph stop` between turns) nothing counts, so a turn another extension starts later is not the graph's. That way a run
ended from inside a script (the approval's "stop") still counts the script's tool result and its subagent, which
are written after `graph.end`, while the cache refreshes and extension calls of an idle session after the run do
not grow its total. Its time (`startedAt`,
`durationMs`) runs from its `graph.node`'s `at` to the next `graph.node`'s `at`, or to the `graph.end`'s `at`, or to
now for the visit that runs; a command visit uses the details' `startedAt` and `durationMs` for the command itself.
The time includes waits. `waitMs` is the time spent on approval questions only (`at` minus `askedAt` of the visit's
`graph.asked` entries); the time a halt took is not split out (the halt is listed with its `at`). For
each visit:

- `node`, `kind`, and for a model node the models that answered (from the assistant messages' `provider` and
  `model`, which differ from the node's setting when the node has none and the model selected before the graph
  answers); for a command node the command;
- `startedAt`, `durationMs`, `waitMs`;
- usage summed over the visit's entries: `requests` (assistant messages), `input`, `output`, `cacheRead`,
  `cacheWrite`, `cost`, in three parts:
  - `own`: `message` entries with `role: "assistant"` and a `usage`;
  - `tools`: `message` entries with `role: "toolResult"` and a `usage` (what a codemode script's nested calls
    spent: foreground subagents started with `Agent`, `models.*` calls), and `usage` entries of kind
    `nested_tool_calls` (calls of a background script after its result was written);
  - `other`: every other usage in the visit's entries, by kind: `usage` entries of the other kinds
    (`cache_warm`, and the extension side calls `recordUsage` writes as `ext:<purpose>`) and the `usage` of
    `compaction` and `branch_summary` entries (the summaries);
  so that "the review node cost $0.40, $0.35 of it in its subagent" can be read. A subagent's usage cannot be split
  from the other nested calls of the same script: the session stores their sum.
- how it was left: `via` (`model`, `approve`, `pass`, `fail`, `goto`) and the target; a pending move (accepted by
  `next`, not entered yet) as `pending: { to }`; or how the graph ended in it.

Every usage the session records inside the run is counted, so the report's total equals the usage of the run's
entries summed by hand, where the run's entries are those of the visits as defined above (after `graph.end`, the
`other` kinds are left out on purpose); the suite test and the by-hand check sum over the same entries. Not counted, and said so in the report and the docs: a background agent's cost, which the session
records only as text in the `subagent` message; usage before `graph.start`.

Totals: the sum of the visits, and the sums per model. A usage recorded under a virtual model (`graph/auto`, as
`nested_tool_calls` entries are during a graph) is put under the model that answered the visit,
and under "unknown" when no model answered in it.

### 3. A command node's result as data (O3)

`graph.command` (the custom message after each command node) gets `details`:

```ts
{ node: string; run: string; code: number | null; timedOut: boolean; startedAt: string; durationMs: number;
  lines: number; outcome: "pass" | "fail" }
```

`lines` counts the lines of the output kept (the runner keeps up to 1 MiB). The text of the message is unchanged.
The extension's `Sink.message` takes the details as a third argument; both of its writers (a draft,
`pi.sendMessage`) already accept them.
A message without `details` (a session from spec 01) is reported with the command and the outcome read from the
move, and no duration. A `graph.command` message sent outside a turn while another turn runs is queued and can land
on the branch after its move or after the next `graph.node`, so the report matches a message to its visit by
`details.node` and `details.startedAt` (the visit of that node whose time contains it), not by its position.

### 4. Approvals that are not approvals

An approval answered "approve" is already on the branch (the move's `via: "approve"`). "Send back", "stop" and a
dismissed question leave nothing but the effect. A new entry `graph.asked` is written when the question is
answered:

```ts
{ node: string; to: string; answer: "approve" | "send_back" | "stop" | "dismissed"; askedAt: string; at: string }
```

It is written before anything the answer causes: before the `graph.move` of an approval, before the `graph.end` of
"stop". `readState` ignores it (it changes no state; `step` already passes over custom types it does not know, as
it does for `graph.blocked`).

### 5. A command you can watch (O4)

`runCheckCommand` gets an `onOutput(text)` option, called with each chunk as it arrives (the cap on kept output is
unchanged). While a command node runs, with a UI:

- the footer shows the elapsed time, refreshed each second: `graph dev: ci 3m12s`;
- a widget `graph` above the editor shows the command and the last 5 lines of its output;
- both go back to the plain status, and the widget is removed, when the command ends, is aborted, or the graph is
  stopped.

Without a UI nothing of this is shown; the result is the same.

### 6. `/graph` as a report (O5, O7)

`/graph` with a run on the branch shows, running or ended:

```
dev (.pi/graphs/dev.js) · running · node build (2/3)
#  node    kind     model / command       time    cost     cache r/w     left by
1  grill   model    anthropic/…-opus-5-5  4m02s   $0.21    41k/6k        approve → spec
2  spec    model    anthropic/…-opus-5-5  2m10s   $0.09    52k/2k        approve → branch
3  branch  command  test "$(git …         0.1s    —        —             pass → build
4  build   model    anthropic/…-haiku-5-5 6m40s   $0.03    120k/9k       model → ci
5  ci      command  for i in $(seq …      4m55s   —        —             fail → build
6  build   model    anthropic/…-haiku-5-5 1m10s   $0.01    30k/1k        (now) → ci pending
asked: grill → spec approve (1) · spec → branch approve (2)
blocked: visit 4 build: bash "git push origin main" (git push origin main)
total 18m57s · $0.34 (tools $0.00) · anthropic/claude-opus-5-5 $0.30 · anthropic/claude-haiku-5-5 $0.04
not counted: the cost of background agents
```

followed by the graph as Mermaid (`flowchart LR`), the current node and the edges taken marked, ready to paste into
a pull request. With no run on the branch, `/graph` shows the graph files as today. Columns are cut to fit the
width; `--json` has everything.

### 7. For programs (O6)

- `/graph --json` shows the report as JSON (the same fields as above, `schemaVersion: 1`) and nothing else: no
  `graph: ` prefix. With a UI it is the text of an `info` notice, which an RPC client receives as the
  `extension_ui_request` it already reads; without one it is written to stdout as one line. The test parses what
  the RPC client receives.
- Events on the extension bus (`pi.events`), each with `{ graph, node, visit, at }` and the entry's own fields:
  `graph:start`, `graph:move` (an accepted move: `to`, `via`; pending until entered), `graph:enter` (a node
  entered, `via`), `graph:command` (the details of section 3), `graph:asked`, `graph:blocked`, `graph:halt`
  (reason), `graph:end` (reason). An event is emitted only for an entry on the branch: drafts that are dropped
  (a graph ended while its command ran) emit nothing. The extension remembers the last graph entry it emitted and,
  after each of its own writes and at `agent_settled`, emits the newer graph entries of the branch in their order
  (an extension does not see the session's `entry_appended`). The mark lives in memory only: at `session_start`
  (a new, resumed or switched session) and `session_tree` it is set to the branch's latest graph entry without
  emitting, so history is never replayed. When the mark is not on the branch at a replay (a branch change it did
  not see), it is set again to the latest graph entry and nothing is emitted that time. So an event can come later
  than the moment in its `at` (a draft's, after its turn), never earlier and never twice; events of entries written
  while the mark was lost are skipped, not replayed. The order follows the branch. herdr and roost are not changed here.

## Tests

- Package (offline): `report` on hand-written branches: usage summed per visit in its three parts (assistant
  messages; tool results and `nested_tool_calls`; the other usage kinds, compaction and branch summary); a visit
  with no request; times from `at` with drafts' timestamps all equal, from `timestamp` when `at` is missing, and to
  a given now; a command visit's time from its details; `waitMs`; the usage after a `graph.end` up to the next user
  message; the last run only when the branch has two; an ended run and a run in `error`; a pending move; a
  `graph/auto` usage put under the visit's model; `graph.command` with and without `details`; `graph.asked`;
  blocked and halted lists; per-model totals; Mermaid output for the dev shape. `readState` ignores `graph.asked`.
- Suite (faux provider): a model node that moves at the end of its turn to a command node taking (fake) time: the
  model visit's time does not include the command's; "stop" on an approval inside a script: `graph.asked` comes
  before `graph.end` and the script's tool result is counted in the last visit; the details of a passing, a
  failing and a timed-out command; `graph.asked` for each answer; `/graph` after the end shows the report;
  `/graph --json` as an RPC client receives it parses and has the visits; the report's total equals the session's
  usage summed in the test; the events in order for a short run, `graph:move` before `graph:enter`, none for the
  drafts of a graph stopped while its command ran, none twice; a command's output reaches the widget through
  `onOutput` and the widget is gone after the command, after `/graph stop`, and after an abort; the footer's
  elapsed time; a resumed session with an ended run emits no event at its next turn; after `/tree` to another
  branch nothing is replayed; `cache_warm` and `ext:` usage after `graph.end` is not counted, a script's tool
  result after a "stop" is; a queued `graph.command` that lands after the next `graph.node` is reported with its
  own visit.
- Runner: `onOutput` gets stdout and stderr in order; the kept output is the same with and without it.
- By hand, real Haiku 5.5: the end-to-end run of `dev` (a Haiku copy, see `decisions.md`) and `/graph` and
  `/graph --json` read after it; the costs in the report against the sum of the session's usage.

## Docs

`docs/graph.md` (a section "What a run shows": the report, what is and is not counted, `--json`, the events),
`docs/slash-commands.md`, `docs/extensions.md` (the `graph:*` events among the bus examples, if the doc lists
built-in events), `docs/porting.md` (the graph unit: `report` and `mermaid` in the package in milestone 1, the
widget and the bus in milestone 2), `docs/xin-pi.md` where it describes the graph, the checks runner's doc if it
has one, `packages/xpi-graph/README.md` (`report`). Each milestone's PR greps the docs and lists what it changed.

## Milestones

1. O-1 `report` in the package; `graph.command` details; `graph.asked`; `/graph` as a report and `--json`;
   Mermaid. One PR.
2. O-2 `onOutput`, the live footer and widget, the bus events; the by-hand run. One PR.
