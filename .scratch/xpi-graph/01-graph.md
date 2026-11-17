# Spec 01: xpi-graph, flow control by a graph

Status: waiting for the owner's approval. Grills 1 and 2 are in `decisions.md` (all 20 as recommended); the owner has
not read this spec yet. No code before the approval.

The product text, with diagrams, is `prd.html` in this directory (Chinese).

## Problem

The hard rules of a flow live in prompts and memory: "merge only after CI is green", "grill a spec before building
it". A rule in a prompt lowers the chance of a mistake; it does not remove it. Each of these rules was added after
the mistake had happened once (a PR merged with CI red; a spec built without a grill).

Example: the model finishes the implementation, forgets the rule, and runs `gh pr merge`. Nothing stops it.

## Goal

A flow written as a graph. A **node** is a stretch of work in the same session with its own model, role prompt and
limits. An **edge** says where a node may go next and what lets it go. The model can only leave a node by a declared
edge; inside a node it works as it does today. With no edge from "build" to "merge", the mistake above is not
available.

The guarantee is against skipped steps (a model that forgets, or takes a shortcut). It is not a sandbox: a model
that sets out to get around the limits of a node can (decisions 7, 15, 18). The docs say so.

Not in this spec (decisions 3, 14, 15, 20, and the PRD's "later" table): parallel nodes, subagent nodes, graphs
drawn by the model, graph variables, a tool allow-list per node, compaction on an edge, cost per node, waiting in
the background through roost, a TUI panel, credential isolation, moving relay or `/review` onto the graph, a
release, npm.

## Design

### 1. The graph file (decisions 1, 6, 8, 14, 15, 16, 17)

`.pi/graphs/<name>.js`:

```js
export default {
  name: "dev",
  start: "grill",
  nodes: {
    grill:  { model: "anthropic/claude-opus-5-5", prompt: "Grill the request...", readOnly: ["**"] },
    build:  { model: "anthropic/claude-haiku-5-5", prompt: "Build what the spec says.",
              deny: ["gh pr merge", "git push origin main"] },
    ci:     { run: "gh pr checks --watch", timeout: "30m" },
    review: { model: "anthropic/claude-opus-5-5", prompt: "Have a fresh Opus subagent review the change..." },
    merge:  { run: "gh pr merge --merge --delete-branch" },
  },
  edges: [
    { from: "grill",  to: "build",  exit: "approve" },
    { from: "build",  to: "ci",     exit: "model" },
    { from: "ci",     to: "review", exit: "pass" },
    { from: "ci",     to: "build",  exit: "fail", max: 3 },
    { from: "review", to: "merge",  exit: "model", label: "no findings" },
    { from: "review", to: "build",  exit: "model", label: "findings to fix", max: 3 },
    { from: "merge",  to: "end",    exit: "pass" },
  ],
  requires: [{ before: "merge", passed: "ci", notAfter: ["build"] }],
};
```

- **Read, never run.** The file's first statement is `export default <literal>`. The literal is read with the parser
  that reads a workflow's `meta` (`LiteralParser` in `extensions/subagent/workflows.ts`: quotes of any kind, bare
  keys, trailing commas), moved to a shared place and taught `//` and `/* */` comments if it does not know them. A
  graph is therefore plain data (decision 17), and listing or starting a graph runs no code from the project.
- **Where.** `.pi/graphs/` from the cwd up to the repository root (closest wins; only in a trusted project), then
  `<agent dir>/graphs/`. No `.claude/` directory and no built-in graphs. The name is the file name and must match
  `name`; `[a-z0-9][a-z0-9-]*`.
- **A model node:** `prompt` (required), `model` (a `provider/model` reference; absent: the model selected when the
  graph started), `thinking` (absent: the level selected at the start), `deny` (strings), `readOnly` (gitignore
  patterns).
- **A command node:** `run` (one shell command, fixed text) and `timeout` (`"<n>s"`, `"<n>m"` or `"<n>h"`; default
  `"10m"`). No `prompt`, no `model`.
- **An edge:** `from`, `to`, `exit`, optional `label` (what the edge means, shown to the model) and `max`.
  - From a model node, `exit` is `"model"` (the model picks it) or `"approve"` (the model asks, the user decides).
    Two edges of one node cannot share a `to`.
  - From a command node, `exit` is `"pass"` (exit code 0) or `"fail"` (anything else, a timeout included); at most
    one of each.
  - `to: "end"` ends the graph. `end` is a reserved id and is not declared in `nodes`.
- **`requires`:** `{ before: A, passed: B, notAfter?: [C, ...] }`, B a command node. See 3.

### 2. The package `xpi-graph` (decisions 2, 11)

`packages/xpi-graph`, private, no dependency on the coding agent, laid out like `xpi-relay` (`source` export, build
with `tsc`, vitest). It answers three questions and changes nothing:

- `parseGraph(value: unknown): Graph` validates the parsed literal (the trust boundary: every field is checked) and
  throws one error that lists every problem found, each with its place (`edges[3].to: no node "revieww"`).
- `checkGraph(graph)`: the structural rules of 3, same error form.
- `readState(entries, graph?)`: the state of the session branch, folded from entries (4).
- `exits(graph, state)`: the edges the current node may take now, with their counts and limits.

It does not reuse `xpi-relay/src/graph/graph.ts` (decision 2): that file is internal to relay and is a table of
(state, event) rows, not nodes and edges. Relay is not touched.

### 3. Checks at load (decisions 8, 16)

A graph that fails any of these does not start; the error names the nodes and edges.

- Every `from` and `to` names a node (or `to` is `end`); `start` names a node; every node has an edge out; every
  node can be reached from `start`; `end` can be reached from `start`.
- Exit kinds fit the node kind (1). A command node whose result has no edge is allowed: that result halts the graph
  (5).
- **Loops.** An edge is on a loop when its `to` can reach its `from`. Such an edge without `max` gets `max: 3`.
  `max` is the number of times the edge may be taken in one run of the graph.
- **`requires`.** Take the graph without B's `pass` edge. If A can be reached from `start`, there is a path to A
  that does not pass B: error, with the path. For each C in `notAfter`: if A can be reached from C in that same
  reduced graph, there is a path from C to A with no pass of B after it: error, with the path.

  Example 1: adding the edge `build -> merge` to the graph above fails the first check with
  `grill -> build -> merge`.

  Example 2, why `notAfter` exists: add a node `patch` that only the review can reach, for small fixes, with the
  edges `review -> patch` and `patch -> merge`. Every path to `merge` passes `ci`, so the first check is silent,
  but `ci -> review -> patch -> merge` merges code that was changed after the check. With `notAfter: ["patch"]`
  the second check fails with `patch -> merge`.

  `/graph goto` (7) is the user's own jump and is not subject to `requires`.

### 4. State is the session branch (decisions 8, 17)

Custom entries, written by the extension, never shown to the model:

| Entry | Data | When |
|---|---|---|
| `graph.start` | the whole graph, the file path, the model and thinking level selected before | `/graph start` |
| `graph.node` | `node`, `via` (`start`, `model`, `approve`, `pass`, `fail`, `goto`), `edge` (index), `report` | each entry into a node |
| `graph.halt` | `reason` | the graph stops and waits for the user (5) |
| `graph.blocked` | the call and the rule | a limit blocked a call (6) |
| `graph.end` | `reason` (`done`, `stopped`, `model_changed`) | the graph is over |

- The graph runs from the copy in `graph.start`. The file is not read again: an edit to it applies to the next
  start (decision 17).
- `readState` walks the branch from the last `graph.start` that has no `graph.end` after it: the current node is
  the last `graph.node`; the count of an edge is the number of `graph.node` entries that took it since the start or
  since the last `goto` (a `goto` is the user taking over, so the counts start again).
- Resume: the last `graph.node` on the branch is the position. Moving to another branch of the session tree moves
  the graph with it; re-running a node is branching from its `graph.node` entry.
- A state that cannot be read (bad entry data, a node the stored graph does not have) is an error state: the
  extension halts and tells the user; it never guesses.

Messages the model does see (custom messages): `graph.enter` (the node, its prompt, the edges out with their
labels, how to leave), `graph.command` (a command node's command, exit code and the last 200 lines of output),
`graph.reminder` (5).

### 5. Running (decisions 4, 5, 6, 9, 10, 13)

`builtin:graph` in `src/extensions/graph/`, wired like `builtin:relay`: the file implements a small host interface
on the extension API and forwards.

- **Model.** A virtual model `graph/auto`. `/graph start` stores the current selection and selects `graph/auto`;
  its router reads the state and returns the node's model and thinking level. This is how relay switches models, and
  a resumed session restores the selection without help. If a node has no `model` and the selection at the start is
  itself a virtual model, `/graph start` refuses. A node's `model` that names a virtual model (`relay/auto`) is a
  load error. If the user selects another model while a graph runs, the graph ends (`model_changed`) with a notice.
- **Prompt and cache (decision 10).** The role prompt is always part of the `graph.enter` message, never of the
  system prompt, so the system prompt is the same in every node and a move between two nodes on one model keeps the
  prompt cache. The system prompt gets one fixed `graph` section (a graph is running; leave a node with `next`).
- **`next({ to, report })`** (decision 13). Deferred exposure: only a codemode script reaches it. `/graph start`
  refuses when codemode is off. The tool is registered at the first start (or at `session_start` on a branch with a
  running graph) and is inactive when no graph runs.
  - `to` is not an edge out of the current node: an error that lists the targets and their labels.
  - The edge is at its `max`: halt.
  - An `approve` edge: with a UI, `select` with Approve, Send back, Stop the graph. Send back ends the turn; the
    user's next message is the comment and the model stays in the node. Without a UI: halt (decision 4).
  - Otherwise the result carries a signal and ends the turn; at `agent_before_settle` the extension writes
    `graph.node` and `graph.enter` and asks for one more request, which the router sends to the new node's model.
- **Command nodes** run at the same point, by the engine (`pi.exec`, the session's cwd, the node's timeout, the
  run's abort signal): write `graph.node`, run, write `graph.command`, take the `pass` or `fail` edge, and go on
  until a model node, `end`, or a halt. A result with no edge, or an edge at its `max`, halts. The model is not
  asked and cannot report a result of its own.
- **A turn that ends without `next`** (decision 5): if the node has an `approve` edge, nothing (the node talks with
  the user). Otherwise one `graph.reminder` and one more request; the second time in the same visit, halt. An
  aborted turn (Escape) is left alone.
- **Halt.** `graph.halt`, a notice with the reason and what to do (`/graph goto <node>`, `/graph stop`, or just
  answer). The graph stays on its node and the session stays usable.
- **End.** `graph.end`, the stored selection is restored, the tool is deactivated, the status is cleared.
- One graph per session (decision 9): `/graph start` while one runs is refused.
- Subagent children do not get the command, the tool or the virtual model.

### 6. Limits of a node (decisions 7, 15, 18)

A `tool_call` handler, active only while a graph is on a model node. Calls made by a codemode script emit the event
too.

- `deny`: a `bash` or `powershell` call whose command text contains one of the strings is blocked. No shell
  parsing.
- `readOnly`: a call with effect `write` and a string `path` that matches a pattern is blocked. Matching is
  `builtin:protect`'s (`extensions/protect/match.ts`), reused, not copied.
- Always, while a graph runs: the graph directories and the session file are read-only.
- A blocked call returns a reason written for the model, shows a warning with a UI, and writes `graph.blocked`.
- Commands the engine runs for a command node are not checked: they are the graph's own text.
- Subagents: while a node is active the extension keeps the node's limits in `XPI_GRAPH_LIMITS` (JSON) in its own
  environment; a subagent child inherits it and its `builtin:graph` installs only this handler. The ticket checks
  that the child does inherit the variable and adds it to `docs/environment-variables.md`.

### 7. Commands and status (decision 9)

- `/graph`: no graph running: the graphs found, with their directories. Running: graph, node, the nodes visited on
  this branch, the counts of the looping edges, the halt reason if halted.
- `/graph start <name>`: load, check, write `graph.start`, enter the start node.
- `/graph stop`: end the graph (`stopped`).
- `/graph goto <node>`: the user's jump to any node, recorded as `via: "goto"`. Going to a command node runs it.
- Footer status with a UI: `graph dev: build (2/3)`; the count is shown when the last edge taken has a `max`.

### 8. The two graphs (decisions 3, 12)

- `.pi/graphs/dev.js` in this repository: grill, spec, build, ci, review, merge. The review node's prompt tells the
  model to start a fresh-context Opus subagent with the `Agent` tool and to pick the edge from its findings. It is
  an example and the owner's own flow; xpi ships no graph.
- `.pi/graphs/release.js`: the release flow of `.pi/skills/release.md` up to the tag, as the second graph. If the
  engine needs a change to express it, the change is reported, not made silently: that is the test of whether the
  engine is general.

## Tests

- Package (`packages/xpi-graph/test`, vitest, offline): `parseGraph` on every field and every error; each check of 3
  with a failing and a passing graph, the `requires` examples above among them; the default `max`; `readState` on
  hand-written branches (start, moves, a loop count, a goto resetting counts, a halt, an end, a second start after
  an end, bad data); `exits`.
- Suite (`test/suite/graph.test.ts`, harness and faux provider, all models faux): start and the first
  `graph.enter`; `next` to a declared node changes the routed model; `next` to an undeclared node is refused with
  the list; a command node passing and failing; a loop reaching its `max` halts; approve, send back and no-UI;
  reminder then halt; `deny` and `readOnly` blocks, in a nested codemode call too; resume from a saved session at
  the same node and count; `/graph goto`; `/graph stop` restores the model; selecting another model ends the
  graph; with no graph started, the requests are the same as without the extension.
- Relay's tests pass unchanged.
- By hand, real Haiku 5.5 only (every node on Haiku, in a temp repository with a local stand-in for CI): the dev
  shape three times with a failing check each time, never reaching the last node on a red check; asked in the build
  node to run the denied command, the call is blocked and recorded; quit and reopen mid-graph; the release-shaped
  graph once. The cost of the node changes is read from the usage of these runs and reported (decision 10).

## Docs

New `docs/graph.md` (what it is and is not, the file format, the checks, the commands, the limits and their
honest boundary, the two example graphs); `docs/settings.md` (the built-in list), `docs/slash-commands.md`,
`docs/porting.md` (a row for the component and its host interface), `docs/environment-variables.md`,
`docs/virtual-models.md` (`graph/auto`), `docs/subagent.md` (limits in children), `docs/xin-pi.md`, both READMEs,
`docs.json`, and `packages/xpi-graph/README.md`.
