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
more can be added later).

### 2. Accounting per visit (O2)

A visit is one entry into a node: from its `graph.node` entry to the next `graph.node`, the `graph.end`, or the end
of the branch for the visit that runs now. For each visit:

- `node`, `kind`, and the model (`provider/id`) or the command;
- `startedAt` (the `graph.node` timestamp) and `durationMs`, wall time to the next of those entries or to now;
- usage summed over the visit's entries: `requests` (assistant messages), `input`, `output`, `cacheRead`,
  `cacheWrite`, `cost`, taken from
  - `message` entries with `role: "assistant"` and a `usage` (the node's own model),
  - `message` entries with `role: "toolResult"` and a `usage` (what a codemode script's nested calls spent:
    foreground subagents started with `Agent`, `models.*` calls),
  - `usage` entries of kind `nested_tool_calls` (calls of a background codemode script after its result was
    written);
  the first part is reported as the node's own and the other two as `tools`, so that "the review node cost $0.40,
  $0.35 of it in its subagent" can be read. A subagent's usage cannot be split from the other nested calls of the
  same script: the session stores their sum.
- how it was left: `via` (`model`, `approve`, `pass`, `fail`, `goto`) and the target, or how the graph ended in it.

Not counted, and said so in the report and the docs: a background agent's cost, which the session records only as
text in the `subagent` message; usage from before `graph.start` or after `graph.end`.

Totals: the sum of the visits, and the sums per model.

### 3. A command node's result as data (O3)

`graph.command` (the custom message after each command node) gets `details`:

```ts
{ node: string; run: string; code: number | null; timedOut: boolean; durationMs: number; lines: number;
  outcome: "pass" | "fail" }
```

`lines` counts the lines of the output kept (the runner keeps up to 1 MiB). The text of the message is unchanged.
A message without `details` (a session from spec 01) is reported with the command and the outcome read from the
move, and no duration.

### 4. Approvals that are not approvals

An approval answered "approve" is already on the branch (the move's `via: "approve"`). "Send back", "stop" and a
dismissed question leave nothing but the effect. A new entry `graph.asked` is written when the question is
answered:

```ts
{ node: string; to: string; answer: "approve" | "send_back" | "stop" | "dismissed" }
```

`readState` ignores it (it changes no state); a `graph.asked` from a later visit than the current one is still
only data.

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
6  build   model    anthropic/…-haiku-5-5 1m10s   $0.01    30k/1k        (now)
asked: grill → spec approve (1) · spec → branch approve (2)
blocked: visit 4 build: bash "git push origin main" (git push origin main)
total 18m57s · $0.34 (tools $0.00) · anthropic/claude-opus-5-5 $0.30 · anthropic/claude-haiku-5-5 $0.04
not counted: the cost of background agents
```

followed by the graph as Mermaid (`flowchart LR`), the current node and the edges taken marked, ready to paste into
a pull request. With no run on the branch, `/graph` shows the graph files as today. Columns are cut to fit the
width; `--json` has everything.

### 7. For programs (O6)

- `/graph --json` shows the report as JSON (the same fields as above, `schemaVersion: 1`), as the notice's text, so
  that an RPC client gets it through the UI record it already reads.
- Events on the extension bus (`pi.events`), each with `{ graph, node, visit }` and its own fields:
  `graph:start`, `graph:enter` (node entered, `via`), `graph:command` (the details of section 3), `graph:asked`,
  `graph:blocked`, `graph:halt` (reason), `graph:end` (reason). They are emitted when the entry is written, in the
  same order. herdr and roost are not changed here.

## Tests

- Package (offline): `report` on hand-written branches: usage summed per visit from assistant messages, tool
  results and `usage` entries; a visit with no request; durations from timestamps and to a given now; the last run
  only when the branch has two; an ended run; `graph.command` with and without `details`; `graph.asked`; blocked
  and halted lists; per-model totals; Mermaid output for the dev shape. `readState` ignores `graph.asked`.
- Suite (faux provider): the details of a passing, a failing and a timed-out command; `graph.asked` for each
  answer; `/graph` after the end shows the report; `/graph --json` parses and has the visits; the events in order
  for a short run; a command's output reaches the widget through `onOutput` and the widget is gone after the
  command, after `/graph stop`, and after an abort; the footer's elapsed time.
- Runner: `onOutput` gets stdout and stderr in order; the kept output is the same with and without it.
- By hand, real Haiku 5.5: the end-to-end run of `dev` (a Haiku copy, see `decisions.md`) and `/graph` and
  `/graph --json` read after it; the costs in the report against the sum of the session's usage.

## Docs

`docs/graph.md` (a section "What a run shows": the report, what is and is not counted, `--json`, the events),
`docs/slash-commands.md`, `docs/extensions.md` (the `graph:*` events among the bus examples, if the doc lists
built-in events), `docs/porting.md` (the graph unit: the widget and the bus), the checks runner's doc if it has one,
`packages/xpi-graph/README.md` (`report`).

## Milestones

1. O-1 `report` in the package; `graph.command` details; `graph.asked`; `/graph` as a report and `--json`;
   Mermaid. One PR.
2. O-2 `onOutput`, the live footer and widget, the bus events; the by-hand run. One PR.
