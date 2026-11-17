# Graph

A graph gives a flow hard rules. You write the flow as nodes and edges in a file; xpi runs it in one session. The model
works freely inside a node and can leave it only by an edge the file declares.

> **Not complete yet.** This version runs model nodes and the edges a model picks. Command nodes (a command the engine
> runs, such as the CI check or the merge), edges that need your approval, and the `deny` and `readOnly` limits of a
> node are read and checked, but a graph that uses one is refused at `/graph start` until they are built. See
> [What is not there yet](#what-is-not-there-yet).

## Why

A rule in a prompt ("merge only after CI is green") lowers the chance of a mistake; it does not remove it. The model
can forget the rule and still run the command.

In a graph the rule is the shape of the flow. With no edge from `build` to `merge`, going from one to the other is not
a choice the model has: the tool it leaves a node with offers only the declared targets.

What a graph guarantees is that steps are not skipped. It is not a sandbox: see
[What a graph does not guarantee](#what-a-graph-does-not-guarantee).

## A graph file

`.pi/graphs/review.js`:

```js
// Plan on a strong model, build on a cheap one, then check the result.
export default {
  name: "review",
  start: "plan",
  nodes: {
    plan:  { model: "anthropic/claude-opus-5-5", prompt: "Read the request and write a plan. Do not edit files." },
    build: { model: "anthropic/claude-haiku-5-5", prompt: "Build what the plan says." },
    check: { prompt: "Read the diff against the plan. List what is wrong, or say it is fine." },
  },
  edges: [
    { from: "plan",  to: "build", exit: "model" },
    { from: "build", to: "check", exit: "model" },
    { from: "check", to: "build", exit: "model", label: "problems to fix", max: 2 },
    { from: "check", to: "end",   exit: "model", label: "nothing to fix" },
  ],
};
```

- **Size.** A file larger than 1 MiB is refused.
- **Where.** `.pi/graphs/<name>.js` in the project, from the current directory up to the repository root (the closest
  wins; read only in a trusted project), then `~/.pi/agent/graphs/<name>.js`. The file name is the graph's `name`.
- **Data, not code.** The first statement is `export default` followed by a plain literal: strings in any quotes, bare
  keys, trailing commas and comments are fine; a function call, a variable or a template with `${}` is refused, and
  so is anything after the literal. The file is parsed, never run, so listing or starting a graph runs no code from
  the project.
- **A model node** has a `prompt` (its role) and may have a `model` (a `provider/model` reference to a physical model;
  without one the node uses the model you had selected when the graph started) and a `thinking` level.
- **An edge** has `from`, `to` and `exit`. `to` is a node or `end`, which finishes the graph. `label` says what the
  edge means; the model sees it when it chooses. `max` is how many times the edge may be taken in one run.
- An unknown key is an error, so a typo such as `promt` does not pass silently.

The other fields (`run` and `timeout` of a command node, `deny`, `readOnly`, `requires`, the exits `approve`, `pass`
and `fail`) are described in the package's
[README](https://github.com/luoxin9510/xin-pi/blob/main/packages/xpi-graph/README.md).

## What is checked when a graph starts

A graph that fails a check does not start. Every problem is reported at once, each with its place:

```
graph: .pi/graphs/review.js: graph review: 2 problems
  edges[1].to: no node "chek"
  nodes.check: cannot be reached from "plan"
```

- Every name resolves, every node has an edge out and can be reached, and the graph can reach `end`.
- An exit fits its node: a model node has `model` and `approve` edges, a command node `pass` and `fail`.
- An edge on a loop (its target leads back to its source) without a `max` gets `max: 3`.
- Each `requires` rule holds on every path. `{ before: "merge", passed: "ci", notAfter: ["build"] }` says: on every
  path to `merge`, after the last entry into `build`, `ci` passed. A graph with a path that breaks the rule is refused,
  and the message shows the path.
- A node's `model` exists and is a physical model; a `thinking` level is one xpi knows.

## Running a graph

| Command | What it does |
|---|---|
| `/graph` | With no graph running: the graph files found. With one running: the graph, the node, the nodes visited and the counts of the looping edges out of the node. |
| `/graph start <name>` | Check the graph and enter its first node. The first node starts working at once. Without a UI (`xpi -p "/graph start <name>"`) the command returns when the graph has ended or waits for you. |
| `/graph stop` | End the graph and give back the model you had selected. |

What happens while it runs:

- **The model.** `/graph start` selects the virtual model `graph/auto`. It sends each request to the model of the
  current node. The footer shows the graph and the node, `graph review: build`, and for a node entered by an edge with
  a `max`, how often that edge was taken: `graph review: build (1/2)`.
- **Entering a node.** The model gets a message with the node's name, the report of the node it comes from, the
  node's prompt and the nodes it may go to with their labels. The role is in this message, not in the system prompt;
  the system prompt has one fixed section about graphs, the same in every node, so two nodes on one model share the
  prompt cache.
- **Leaving a node.** The model calls `tools.next({ to, report })` from a codemode script, once, and ends its turn.
  `to` must be one of the node's edges; otherwise the call fails and lists the choices. `report` is what the next node
  is told.
- **When the move takes effect.** At the end of the turn, never in the middle of one: until then the old node's model
  answers. A second `next` in the same visit is refused. So is one from a script that outlived the request that
  started it, such as a background script: by the time it calls, the session may be in another turn or another
  node, and a move belongs to the request that asked for it.
- **A turn that ends without a move** is the node talking to you. Answer, and it goes on in the same node.
- **The end.** An edge to `end` finishes the graph and gives back the model and thinking level you had selected.

A graph needs codemode (the model reaches `next` only from a script), and a physical model selected when it starts:
with `relay/auto` or another virtual model selected, `/graph start` asks you to select a physical model first. One
graph runs per session. Relay takes no part while a graph runs.

### When the graph stops and waits for you

A **halt** is the graph saying it cannot decide. The graph stays on its node and the session stays usable.

- An edge at its `max`: the model's `next` is refused, the graph halts, and a notice says which edge. Your next message
  leaves the halt and the node goes on; `/graph stop` ends the graph.
- A state that cannot be read (the session's entries do not agree with each other): xpi says so and does not guess.
  `/graph stop` ends the graph.

### Resuming, branching, compaction

The state of a graph is not kept anywhere else than in the session: each entry into a node is an entry of the session
(see [The entries](#the-entries)).

- **Resume.** A resumed session is at the node its entries say, with the same counts. A move that was accepted before
  xpi quit, and whose turn never ended, is entered when you send the next message.
- **Branches.** Moving to another branch of the session tree moves the graph with it. To run a node again, branch from
  the entry that entered it.
- **An aborted turn** (Escape) after `next`: the move is not lost and gets no turn of its own; the next node starts
  with your next message.
- **Compaction** can summarise the node's role away, so after a compaction xpi sends the current node's message again.
  It starts no turn of its own.
- **The graph file is read once.** The whole graph is stored in the session when it starts. Editing the file changes
  the next start, not the graph that is running.
- **Selecting another model** while a graph runs ends the graph. Selecting `graph/auto` by hand with no graph running
  does nothing useful: xpi answers with the model that answered last and says to use `/graph start`.

## What a graph does not guarantee

- A graph stops a model from skipping a step. It does not stop a model that sets out to get around it: inside a node
  the model has its usual tools.
- In this version nothing limits what a node does. The `deny` and `readOnly` limits are not built yet, so a model in
  `build` can still run any command. Do not rely on a graph to keep a model away from a command yet.
- A review node in the same session sees the whole conversation. For an independent review, tell the node in its
  prompt to start a subagent with the `Agent` tool.

## What is not there yet

A graph that uses one of these is refused at `/graph start` with "not supported yet", so that no graph runs with a
control silently missing:

- command nodes (`run`), and with them the `pass` and `fail` edges and the `requires` rules that need them;
- `approve` edges;
- the `deny` and `readOnly` limits of a node;
- `/graph goto`.

A turn that ends without `next` is never reminded in this version.

## The entries

Custom entries in the session file, none of them sent to the model:

| Entry | Data | Written when |
|---|---|---|
| `graph.start` | the graph as its file's literal, the file path, the selection to give back | `/graph start` |
| `graph.node` | `node`, `via`, `edge`, `report` | a node is entered |
| `graph.move` | `edge`, `via`, `report` | `next` accepted a move that is not entered yet |
| `graph.halt` | `reason` | the graph halts |
| `graph.end` | `reason` (`done`, `stopped`, `model_changed`) | the graph is over |

The messages the model sees are custom messages of type `graph.enter`.

## Turning it off

`"-builtin:graph"` in `extensions` (see [Settings](settings.md)). Without `/graph start` the extension registers no
tool and changes no request.

## Implementation

- `packages/xpi-graph`: the file format (`parseGraph`), the checks (`checkGraph`) and the state folded from the
  session's entries (`readState`, `exits`). It imports nothing of the workspace.
- `src/extensions/graph/`: `files.ts` finds and reads graph files; `index.ts` registers `graph/auto`, the `next` tool
  and `/graph`, and enters a move at `agent_before_settle` or, for a move whose turn never settled, at
  `before_agent_start`.
- Tests: `packages/xpi-graph/test/`, `test/graph-files.test.ts`, `test/suite/graph.test.ts` (faux provider).
- Spec and decisions: `.scratch/xpi-graph/`.
