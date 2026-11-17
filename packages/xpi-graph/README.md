# xpi-graph

Flow control by a graph, for xpi. Private; not published.

## What it is for

The hard rules of a flow ("merge only after CI is green") usually live in a prompt. A model that forgets the rule can
still do the thing. A graph makes the rule a structure:

- A **node** is a stretch of work in one session: a model node (a role prompt, a model, limits) or a command node (a
  command the engine runs).
- An **edge** says where a node may go next and what lets it go.

The model can only leave a node by a declared edge. With no edge from `build` to `merge`, "merge without CI" is not
a choice the model has. Inside a node the model works as it does without a graph.

This package is the pure part. It answers three questions and changes nothing: is this a valid graph, where is the
session now, and where may it go next. Running a graph (switching models, the tool the model moves with, running
commands) is the host's job; in xpi that is the built-in `builtin:graph` of the coding agent, which is not written
yet. The package imports nothing of the workspace.

Spec: `.scratch/xpi-graph/01-graph.md`. Decisions: `.scratch/xpi-graph/decisions.md`.

## The graph file

A graph is plain data. The host reads the literal of a file and hands it to `parseGraph`:

```js
export default {
  name: "dev",
  start: "grill",
  nodes: {
    grill:  { model: "anthropic/claude-opus-5-5", prompt: "Grill the request...", readOnly: ["**"] },
    build:  { model: "anthropic/claude-haiku-5-5", prompt: "Build what the spec says.",
              deny: ["gh pr merge", "git push origin main"] },
    ci:     { run: "gh pr checks --watch", timeout: "30m" },
    review: { prompt: "Have a fresh subagent review the change...", deny: ["gh pr merge"] },
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

| Field | Meaning |
|---|---|
| `name` | Lower-case letters, digits and dashes. |
| `start` | The node the graph begins in. |
| `nodes.<id>` with `prompt` | A model node. `model` (`provider/model`; absent: the model selected at the start), `thinking`, `deny` (command text the node may not run), `readOnly` (gitignore patterns of paths it may not write). |
| `nodes.<id>` with `run` | A command node: one shell command and a `timeout` (`"30s"`, `"10m"`, `"1h"`; default 10 minutes). |
| `edges[]` | `from`, `to` (a node, or `end`), `exit`, optional `label` and `max`. |
| `requires[]` | `{ before, passed, notAfter? }`, see the checks. |

An edge's `exit` says what lets it be taken. From a model node: `model` (the model picks it) or `approve` (the model
asks, the user decides). From a command node: `pass` (exit code 0) or `fail` (anything else, a timeout included).
`end` is a reserved target that ends the graph; it is not a node.

An unknown key is an error, so a typo (`promt`) does not pass silently.

## The checks

`parseGraph(value)` checks the form of every field. `checkGraph(graph)` checks how the parts fit. Each throws one
`GraphError` whose `problems` list every problem with its place (`edges[3].to: no node "revieww"`).

`checkGraph` refuses a graph when:

- `start`, or an edge's `from` or `to`, names no node;
- an edge's exit does not fit the node it leaves, a model node has two edges to the same node, or a command node has
  two `pass` or two `fail` edges;
- a node has no edge out, a node cannot be reached from `start`, or `end` cannot be reached;
- a `requires` entry does not hold.

A command node may lack a `pass` or a `fail` edge: that result has nowhere to go and the host halts the graph.

**Loops.** An edge is on a loop when its target leads back to its source. `checkGraph` returns the graph with
`max: 3` on every such edge that sets none. `max` is how many times the edge may be taken in one run.

**`requires`.** `{ before: A, passed: B, notAfter: [C] }`, B a command node, says: on every path to A, after the last
entry into C, B passed. Two checks on the graph without B's `pass` edge:

1. A cannot be reached from `start`. Otherwise some path reaches A without passing B. A that is the start node
   always fails: the graph is in it before anything passed.
2. A cannot be reached from C. Otherwise some path changes things in C and reaches A with no pass of B after it.

Example for 2: add a node `patch` that only `review` reaches, with `patch -> merge`. Every path to `merge` passes
`ci`, so check 1 is silent, but `ci -> review -> patch -> merge` merges code that changed after the check.
`notAfter: ["patch"]` makes the graph fail with that path.

## The state is the session branch

The package stores nothing. The host writes custom entries to the session; `readState(entries)` folds the entries of
the current branch into the state. Resuming a session, or moving to another branch of it, moves the graph with it.

| Entry | Data | Written when |
|---|---|---|
| `graph.start` | the graph's literal, the file path, the selection to restore | a graph starts |
| `graph.node` | `node`, `via`, `edge`, `report` | a node is entered |
| `graph.move` | `edge`, `via`, `report` | a move is accepted and not entered yet |
| `graph.halt` | `reason` | the graph stops and waits for the user |
| `graph.blocked` | the call and the rule | a limit blocked a call (a record; the state ignores it) |
| `graph.end` | `reason` | the graph is over |

`readState` returns one of:

- `none`: no graph runs. After a graph ended, `ended` holds the selection it should have restored.
- `running`: the graph (checked again from the stored literal), the current `node`, `visited`, `counts` per edge,
  `lastEdge` (the edge that entered the node), a `pending` move, the `halted` reason, and `reminded`.
- `error`: the entries cannot be read as a graph, or do not agree with each other. The host must halt and tell
  the user, never guess. The cases: a stored graph that fails the checks; a node the graph does not have; a first
  entry that is not the start node, or a start entry later on; an edge that does not join the two nodes, or is not
  taken by its own exit (`via: "pass"` on an `approve` edge); a node entered by another edge than the pending
  move; a second pending move; an end without a known reason.

Rules of the fold:

- The count of an edge is the number of `graph.node` entries that took it since the start or since the last entry
  with `via: "goto"`. A goto is the user taking over, so the counts start again.
- A `graph.move` with no `graph.node` after it is `pending`. It survives a quit or an aborted turn, so the host can
  enter it later and a node is never stuck.
- A user message leaves a halt on a model node, and clears `reminded`. A halt on a command node is left only by a
  goto or the end.
- Custom entries of other extensions are ignored.

`exits(state)` lists the edges out of the current node, each with its index, its count, and `open: false` when it is
at its `max`.

## Tests

```bash
cd packages/xpi-graph
node ../../node_modules/vitest/dist/cli.js --run
```

`test/parse.test.ts` covers every field and every error, `test/check.test.ts` each structural check with a failing
and a passing graph, `test/state.test.ts` the fold on hand-written branches.
