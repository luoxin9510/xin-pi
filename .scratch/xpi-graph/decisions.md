# Decisions: xpi-graph

## Before the grills (2026-11-17, in conversation with the owner)

- Nodes are in-session nodes: the same session with another role, model and limits, as relay does.
- xpi is codemode only; the tool that moves between nodes exists only in codemode.
- Edges are hard, the inside of a node is free.
- Ideas are borrowed from LangGraph and from upstream's durable and chord packages; no code is ported and chord is
  not brought in.
- The first version is small and has to work; features come later.
- Strong control in the first version is three things: sensitive actions are command nodes run by the engine (a deny
  list on model nodes as a backstop); rules of the form "A only after B passed" are checked when the graph loads;
  anything unclear stops the graph. The aim is that steps cannot be skipped, not that a determined model cannot get
  around a limit.

## Grill 1 (2026-11-17). Accepted by the owner on 2026-11-17 ("全是")

1. Graph files are JS (`export default { ... }`) in `.pi/graphs/` (trusted projects only) and
   `~/.pi/agent/graphs/`, project first: the rules of saved workflows.
2. The engine is not relay's `graph.ts`. `xpi-graph` has its own small interpreter of nodes and edges; relay is not
   touched.
3. Independent review: no subagent node in the first version. The review node's prompt tells the model to start a
   fresh-context Opus subagent with the `Agent` tool; the node sums up and picks the edge.
4. Approval is a `select` with three options: approve, send back, stop the graph. After "send back" the user's next
   message is the comment and the model stays in the node. Without a UI it counts as sent back and the graph stops.
5. A turn that ends without a move: a node that has an approval exit is waiting for the user, which is normal; any
   other node gets one reminder, then the graph stops and asks the user.
6. Command nodes: fixed command text, a timeout of 10 minutes by default (`timeout` on the node changes it), a
   timeout is a failure, the last 200 lines of output go into the session. No graph variables.
7. The deny list matches by substring on the command text. The shell is not parsed; the docs say it can be got
   around.
8. An edge on a loop without `max` gets 3. Counts are per edge, read from the node entries. At the limit the graph
   stops and asks the user.
9. One graph per session. While it runs the nodes decide the model and relay takes no part; a node whose `model` is
   `relay/auto` is a load error; a node without `model` uses the model selected at the start. At the end or on
   `/graph stop` the earlier model and tools are restored.
10. Cache: not measured before the spec. Rule: between two nodes on the same model the role prompt goes in a
    message, not in the system prompt. Measured with Haiku after the first runnable milestone.
11. Names: the package `packages/xpi-graph`, the built-in `builtin:graph` in `src/extensions/graph/`, loaded by
    default. Without `/graph start` it registers no tool and changes no request.
12. The risk that only one flow is ever used is accepted. The dev graph is not shipped with xpi: it lives in this
    repository as `.pi/graphs/dev.js`, the example and the test graph. A second graph (the release flow) is part of
    "done", to test that the engine is general.

## Grill 2 (2026-11-17). Accepted by the owner on 2026-11-17 ("全是")

13. The tool is `next({ to, report })`: `to` a node name, `report` required and stored in the node entry. On
    entering a node the engine sends a message with the node, its role prompt and where it can go. A `to` that is
    not an edge of the current node is an error that lists the choices.
14. No combined exit ("the model picks, then a command verifies"). A check is a command node between the two.
15. A node has two limits: `deny` (command text) and `readOnly` (paths the node cannot write, matched as
    `builtin:protect` matches). No tool allow-list.
16. `requires: [{ before, passed, notAfter? }]`: on every path to `before`, after the last entry into a node of
    `notAfter` there is a pass of `passed`. Without `notAfter` the check is only that every path passes it.
17. A graph is plain data. `/graph start` writes the whole graph into the session's start entry; running, resuming
    and branching read that copy, never the file again.
18. The engine protects only the graph directories and the session file by itself. Files a check depends on
    (`package.json`, CI configuration) are the graph author's to list in a node's `readOnly`. A model that edits a
    test to make it pass is found by the review, not by the engine.
19. Four milestones, one PR each: the package; the smallest runnable `builtin:graph`; strong control; the two
    graphs and the docs.
20. Delivery: spec and tickets in `.scratch/xpi-graph/`, one PR for the owner to approve. After the approval each
    milestone is a branch, a PR, green CI and an independent fresh-context Opus review, then merged by the agent
    without asking at each step. Real-model tests on Haiku only. No release, no npm.

## Facts found while writing the spec (author)

- A workflow's `meta` is read by a literal parser that never runs the file (`LiteralParser`,
  `extensions/subagent/workflows.ts`). The graph file is read the same way, so decision 17 ("plain data") needs no
  check of its own, and listing or starting a graph runs no project code. The first statement is
  `export default <literal>`.
- Relay switches models with a virtual model whose router reads the session branch. The graph does the same with
  `graph/auto`; a resumed session then restores the selection without code. Consequence, not asked in the grills:
  selecting another model while a graph runs ends the graph.
- Decision 10 is met more simply than worded: the role prompt is always in the entry message and never in the
  system prompt, whatever the models of the two nodes.
- A graph needs a way to end. `end` is a reserved target of an edge; it is not a node.
- "Stops and asks the user" is one state, a halt: the graph stays on its node, the session stays usable, and the
  user answers, runs `/graph goto` or runs `/graph stop`. `/graph goto` resets the loop counts.
- `tool_call` fires for calls a codemode script makes and carries the tool's effect, so `deny` and `readOnly` need
  no change in codemode or in the core.
- Subagents are child processes. The node's limits reach them through an environment variable
  (`XPI_GRAPH_LIMITS`); ticket 03 checks that the child inherits it.
- Workflows are also read from `.claude/workflows/` and from a built-in directory. Graphs are not: neither exists
  for graphs.

## Review round 1 (independent Opus, commit 383314267, 2026-11-17)

One blocking finding, six should-fix, six nits; all taken. None changes a decision of the grills. What the spec
now says, and was not asked in the grills:

- A halt on a command node has no node model and no node limits. The router then uses the model selected before
  the graph, the limits are the union of every node's `deny`, and `next` is refused: only `/graph goto` and
  `/graph stop` leave it. A halt on a model node is left by the user's next message.
- One move per visit: `next` writes `graph.move`; a second `next`, or one from a background script, is refused;
  the move is entered at the next request boundary.
- `graph.enter` is sent again after a compaction.
- `graph/auto` is registered at load (a resumed session needs it); selected by hand with no graph, the selection
  is put back. Only a `set` or `cycle` selection ends a running graph, not a `restore`.
- `/graph start` and `/graph goto` enter the node at once and start the turn.
- `readOnly` does not see shell writes. The entry message tells the model the patterns hold for the shell too,
  and the docs say the engine does not enforce it there.
- `notAfter` cannot contain `before`. The two `requires` checks were reviewed and no counter-example was found.
