# Graph

A graph gives a flow hard rules. You write the flow as nodes and edges in a file; xpi runs it in one session. The model
works freely inside a node and can leave it only by an edge the file declares.

## Why

A rule in a prompt ("merge only after CI is green") lowers the chance of a mistake; it does not remove it. The model
can forget the rule and still run the command.

In a graph the rule is the shape of the flow. With no edge from `build` to `merge`, going from one to the other is not
a choice the model has: the tool it leaves a node with offers only the declared targets. The check and the merge are
commands that xpi runs itself, so the model cannot report a check as passed or run the merge early.

What a graph guarantees is that steps are not skipped. It is not a sandbox: see
[What a graph does not guarantee](#what-a-graph-does-not-guarantee).

## A graph file

`.pi/graphs/ship.js`:

```js
// Build on a cheap model, let CI decide, review on a strong one, merge after your approval.
export default {
  name: "ship",
  start: "build",
  nodes: {
    build:  { model: "anthropic/claude-haiku-5-5", prompt: "Build what the spec says and open a pull request.",
              deny: ["gh pr merge", "git push origin main"] },
    ci:     { run: "gh pr checks --watch", timeout: "30m" },
    review: { model: "anthropic/claude-opus-5-5", prompt: "Review the diff. List what is wrong, or say it is fine.",
              deny: ["gh pr merge", "git push origin main"], readOnly: ["**"] },
    merge:  { run: "gh pr merge --merge --delete-branch" },
  },
  edges: [
    { from: "build",  to: "ci",     exit: "model" },
    { from: "ci",     to: "review", exit: "pass" },
    { from: "ci",     to: "build",  exit: "fail", max: 3 },
    { from: "review", to: "merge",  exit: "approve", label: "nothing to fix" },
    { from: "review", to: "build",  exit: "model",   label: "problems to fix", max: 2 },
    { from: "merge",  to: "end",    exit: "pass" },
  ],
  requires: [{ before: "merge", passed: "ci", notAfter: ["build"] }],
};
```

- **Where.** `.pi/graphs/<name>.js` in the project, from the current directory up to the repository root (the closest
  wins; read only in a trusted project), then `~/.pi/agent/graphs/<name>.js`. The file name is the graph's `name`.
- **Data, not code.** The first statement is `export default` followed by a plain literal: strings in any quotes, bare
  keys, trailing commas and comments are fine; a function call, a variable or a template with `${}` is refused, and
  so is anything after the literal. The file is parsed, never run, so listing or starting a graph runs no code from
  the project. A file larger than 1 MiB is refused.
- An unknown key is an error, so a typo such as `promt` does not pass silently.

### Nodes

| Kind | Fields | What it is |
|---|---|---|
| Model node | `prompt` (required), `model`, `thinking`, `deny`, `readOnly` | A stretch of work by a model. `prompt` is its role. `model` is a `provider/model` reference to a physical model; without one the node uses the model you had selected when the graph started. |
| Command node | `run` (required), `timeout` | One shell command that xpi runs. Its exit code picks the edge. `timeout` is `"30s"`, `"10m"` or `"1h"`; the default is 10 minutes, and a timeout counts as a failure. |

`deny` and `readOnly` are the [limits of a node](#the-limits-of-a-node).

### Edges

An edge has `from`, `to` and `exit`. `to` is a node or `end`, which finishes the graph.

| `exit` | From | Taken when |
|---|---|---|
| `model` | a model node | the model chooses it |
| `approve` | a model node | the model chooses it and you approve |
| `pass` | a command node | the command exits with 0 |
| `fail` | a command node | the command exits with anything else, or times out |

`label` says what the edge means; the model sees it when it chooses. `max` is how many times the edge may be taken in
one run of the graph.

## What is checked when a graph starts

A graph that fails a check does not start. Every problem is reported at once, each with its place:

```
graph: .pi/graphs/ship.js: graph ship: 2 problems
  edges[1].to: no node "reveiw"
  requires[0]: "merge" can be reached without a pass of "ci": build -> merge
```

- Every name resolves, every node has an edge out and can be reached, and the graph can reach `end`.
- An exit fits its node, a model node has at most one edge to each node, a command node at most one `pass` and one
  `fail` edge. A command node may lack one of the two: that result halts the graph.
- An edge on a loop (its target leads back to its source) without a `max` gets `max: 3`.
- A node's `model` exists and is a physical model; a `thinking` level is one xpi knows.
- Each `requires` rule holds on every path.

**`requires`.** `{ before: "merge", passed: "ci", notAfter: ["build"] }` says: on every path to `merge`, after the last
entry into `build`, `ci` passed. Two things are checked on the graph without `ci`'s `pass` edge:

1. `merge` cannot be reached from the start. Otherwise some path reaches it without a pass of `ci`.
2. `merge` cannot be reached from `build`. Otherwise some path changes the code and merges it with no pass after the
   change.

Example for 2: add a node `patch` that only `review` reaches, for small fixes, with an edge `patch -> merge`. Every
path to `merge` still passes `ci`, so the first check is silent, but `ci -> review -> patch -> merge` merges code that
changed after the check. With `notAfter: ["patch"]` the graph is refused, and the message shows that path.

## Running a graph

| Command | What it does |
|---|---|
| `/graph` | With no graph running: the graph files found. With one running: the graph, the node, the nodes visited and the counts of the looping edges out of the node. |
| `/graph start <name>` | Check the graph and enter its first node, which starts working at once. Without a UI (`xpi -p "/graph start <name>"`) the command returns when the graph has ended or waits for you. |
| `/graph goto <node>` | Your own jump to any node, whatever the edges say. Recorded as a jump; the loop counts start again. Going to a command node runs its command. Not while a turn or a command runs. |
| `/graph stop` | End the graph, stop a command it is running, and give back the model you had selected. |

What happens while it runs:

- **The model.** `/graph start` selects the virtual model `graph/auto`. It sends each request to the model of the
  current node. The footer shows the graph and the node, `graph ship: build`, and for a node entered by an edge with a
  `max`, how often that edge was taken: `graph ship: build (1/3)`. While a command runs it shows `(running)`.
- **Entering a model node.** The model gets a message with the node's name, the report of the node it comes from, the
  node's prompt, the paths it must not write, and the nodes it may go to with their labels. The role is in this
  message, not in the system prompt; the system prompt has one fixed section about graphs, the same in every node, so
  two nodes on one model share the prompt cache.
- **Leaving a model node.** The model calls `tools.next({ to, report })` from a codemode script, once, and ends its
  turn. `to` must be one of the node's edges; otherwise the call fails and lists the choices. `report` is what the
  next node is told.
- **When a move takes effect.** At the end of the turn, never in the middle of one: until then the old node's model
  answers and its limits hold. A second `next` in the same visit is refused. So is one from a script that outlived the
  request that started it, such as a background script: by the time it calls, the session may be in another turn or
  another node, and a move belongs to the request that asked for it.
- **A command node** is run by xpi in the session's directory when the graph enters it. The model is not asked and
  cannot report a result of its own. The command, how it ended and the last 200 lines of its output go into the
  session, so the next node reads them. Then the `pass` or `fail` edge is taken; several command nodes in a row run
  one after the other.
- **An approval.** When the model chooses an `approve` edge you are asked: **Approve**, **Send back** or **Stop the
  graph**. After "Send back" the model stays in the node and your next message is the comment. Closing the question
  is not an approval. Without a UI nobody can approve, and the graph halts.
- **A turn that ends without a move.** In a node with an `approve` edge that is the node talking to you, and nothing
  happens. In any other model node the model is reminded once; if the next turn also ends without a move, the graph
  halts.
- **The end.** An edge to `end` finishes the graph and gives back the model and thinking level you had selected.

A graph needs codemode (the model reaches `next` only from a script), and a physical model selected when it starts:
with `relay/auto` or another virtual model selected, `/graph start` asks you to select a physical model first. One
graph runs per session. Relay takes no part while a graph runs.

### When the graph stops and waits for you

A **halt** is the graph saying it cannot decide. The graph stays on its node and the session stays usable; the model
cannot move the graph while it is halted.

| Halted because | On | How to go on |
|---|---|---|
| an edge is at its `max` | the model node that asked | answer (the node goes on), `/graph goto`, `/graph stop` |
| two turns ended without a move | that model node | the same |
| an approval is needed and there is no UI | that model node | the same |
| a command's result has no edge, or its edge is at `max` | the command node | `/graph goto <node>` (the same node runs the command again), `/graph stop` |
| a command was stopped while it ran | the command node | the same |
| the state cannot be read | | `/graph stop` |

On a model node your next message leaves the halt. On a command node it does not: there is no node at work there. If
you talk to the session while it is halted on a command node (or while a command started by `/graph goto` runs), the
model you had selected before the graph answers, the `deny` lists of all nodes hold, and `next` is refused.

Example: `ci` fails a fourth time and `ci -> build` has `max: 3`. The graph halts on `ci`. You say "look at the log";
the model selected before the graph answers, and `gh pr merge` stays denied because `build` and `review` deny it.
Then you run `/graph goto build`.

### The limits of a node

A model node can carry two lists:

- `deny`: text that a shell command of the node may not contain. A `bash` or `powershell` call whose command contains
  one of the strings is blocked.
- `readOnly`: gitignore patterns of paths the node may not write. A file tool call that writes a matching path is
  blocked. The matching is that of [protected paths](protect.md).

While any graph runs, the graph directories and the session's own file are read-only as well.

A blocked call tells the model why, shows a warning, and is recorded in the session (`graph.blocked`). Calls a codemode
script makes are checked too. The limits are those of the node the session is in when the call is made.

A subagent started in a node gets the limits the node has at that moment (the environment variable
`XPI_GRAPH_LIMITS`), and keeps them: a subagent still running after the graph moved on has the old node's limits. A
subagent in its own worktree matches `readOnly` patterns against its own directory. A subagent gets none of the rest:
no `/graph`, no `next`.

Put the commands that must not be run early (the merge, the release, the push to the main branch) in a command node,
and in the `deny` list of the model nodes before it. The command node is the control; the `deny` list is the backstop.

### Resuming, branching, compaction

The state of a graph is not kept anywhere else than in the session: each entry into a node is an entry of the session
(see [The entries](#the-entries)).

- **Resume.** A resumed session is at the node its entries say, with the same counts. A move that was accepted before
  xpi quit, and whose turn never ended, is entered when you send the next message.
- **Branches.** Moving to another branch of the session tree moves the graph with it. To run a node again, branch from
  the entry that entered it. What a command node did (a merge) is not undone by branching.
- **An aborted turn** (Escape) after `next`: the move is not lost and gets no turn of its own; the next node starts
  with your next message.
- **Compaction** can summarise the node's role away, so after a compaction xpi sends the current node's message again.
  It starts no turn of its own.
- **The graph file is read once.** The whole graph is stored in the session when it starts. Editing the file changes
  the next start, not the graph that is running.
- **Selecting another model** while a graph runs ends the graph. Selecting `graph/auto` by hand with no graph running
  does nothing useful: xpi says to use `/graph start`, and the request is answered by the model that was selected
  before the session's last graph, or, in a session that ran no graph, by the model that answered last.

## What a graph does not guarantee

A graph stops a model from skipping a step by mistake or by taking a shortcut. It does not stop a model that sets out
to get around it.

- `deny` matches the text of a command. It does not parse the shell: a command written into a script file and run
  from there is not seen.
- `readOnly` sees the file tools only. A shell command that writes a file (`cat > spec.md`) is not blocked. A model
  can do that out of habit, not only on purpose, so the message that enters a node names the node's read-only paths
  and says they hold for shell commands too. That is an instruction, not an enforcement.
- A model can change a test so that it passes. The check then passes honestly. An independent review finds that, the
  graph does not.
- A review node in the same session sees the whole conversation. For an independent review, tell the node in its
  prompt to start a subagent with the `Agent` tool.
- `/graph goto` is yours and obeys no rule of the graph, `requires` included.
- An extension loaded after the built-ins can change a call after it was checked.

Real isolation (a token that exists only in the merge node, a sandbox) is not part of this.

## The entries

Custom entries in the session file, none of them sent to the model:

| Entry | Data | Written when |
|---|---|---|
| `graph.start` | the graph as its file's literal, the file path, the selection to give back | `/graph start` |
| `graph.node` | `node`, `via`, `edge`, `report` | a node is entered |
| `graph.move` | `edge`, `via`, `report` | a move is accepted and not entered yet: from `next`, or a command's result |
| `graph.halt` | `reason` | the graph halts |
| `graph.blocked` | `tool`, `rule`, `node` | a limit blocked a call |
| `graph.end` | `reason` (`done`, `stopped`, `model_changed`) | the graph is over |

The messages the model sees are custom messages: `graph.enter` (a node's entry message), `graph.command` (a command
node's result) and `graph.reminder`.

## Turning it off

`"-builtin:graph"` in `extensions` (see [Settings](settings.md)). Without `/graph start` the extension registers no
tool and changes no request.

## Implementation

- `packages/xpi-graph`: the file format (`parseGraph`), the checks (`checkGraph`) and the state folded from the
  session's entries (`readState`, `exits`). It imports nothing of the workspace.
- `src/extensions/graph/`: `files.ts` finds and reads graph files; `limits.ts` holds the limits of a node;
  `index.ts` registers `graph/auto`, the `next` tool and `/graph`, enters a move at `agent_before_settle` or, for a
  move whose turn did not enter it, at `before_agent_start`, and runs command nodes with the runner of
  [checks](checks.md) (its own process group, killed on timeout or abort).
- Tests: `packages/xpi-graph/test/`, `test/graph-files.test.ts`, `test/suite/graph.test.ts` and
  `test/suite/graph-controls.test.ts` (faux provider, a fake command runner).
- Spec and decisions: `.scratch/xpi-graph/`.
