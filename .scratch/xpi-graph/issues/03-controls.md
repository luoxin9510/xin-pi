# Tickets: milestone 3, strong control

Spec: `.scratch/xpi-graph/01-graph.md` (sections 5, 6, 7). One PR (branch `graph-controls`), after milestone 2:
`npm run check`, the suite tests, green CI, an independent Opus review, the docs.

- [x] G3.1 command nodes: run by the engine when a move is entered, in a turn or from `/graph start` and
      `/graph goto` outside one (`pi.exec`, cwd, timeout; the turn's abort signal, or outside a turn the
      extension's own controller, which `/graph stop` aborts; the running status; during such a run the rules
      of a halt on a command node, and the result entered at a boundary as a pending move),
      `graph.command` with the last 200 lines, the `pass` or `fail` edge, chains of command nodes, a result without
      an edge halts
      Done: `proceed` in `index.ts`, with the runner of `checks`; `commandText` keeps the last 200 lines. A stopped command halts.
- [x] G3.2 `approve` edges: the three-option `select`; send back ends the turn and keeps the node; no UI halts
      Done. Closing the question is Send back.
- [x] G3.3 loop limits at run time: an edge at its `max` halts, from `next` and from a command result
      Done (from `next` in milestone 2; from a command result here).
- [x] G3.4 a turn that ends without `next`: nothing in a node with an `approve` edge; otherwise one
      `graph.reminder`, then a halt; only a `completed` turn counts (not an abort, not a provider error)
      Done. A halted node is left alone too.
- [x] G3.5 halt: `graph.halt`, the notice, `next` refused while halted. On a model node the user's next message
      leaves it and the idle count starts again. On a command node the router uses the pre-graph model, the limits are the union of every node's
      `deny`, and only `/graph goto` and `/graph stop` leave it. `/graph goto <node>` is recorded, resets the
      counts and runs a command node
      Done: `haltNotice`, `/graph goto`. While a command runs, the limits are read from the running command (every node's `deny`), also at a turn's end, when the branch still shows the node before.
- [x] G3.6 limits: the `tool_call` handler for `deny` and `readOnly`; `match.ts` of `builtin:protect` reused; the
      graph directories and the session file read-only while a graph runs; the reason, the warning,
      `graph.blocked`; the `readOnly` patterns in `graph.enter` with the sentence about shell commands
      Done: `limits.ts`; `graph.blocked` records the tool, the rule and the node.
- [x] G3.7 subagents: `XPI_GRAPH_LIMITS` kept in the environment while a node is active and cleared at the end; a
      child installs only the handler; a test that a child does inherit it
      Done: `sync` keeps `XPI_GRAPH_LIMITS`; a child installs only the handler; tests for the variable in the parent and for a child that reads it (and one that cannot).
- [x] G3.8 the "not supported yet" refusal of milestone 2 is removed
      Done.
- [x] G3.9 suite tests: the remaining cases of the spec's Tests
      Done: `test/suite/graph-controls.test.ts` (25 tests, a fake command runner; two of them hold a command and stop it with `/graph stop`) and `test/graph-limits.test.ts` (14 tests of `limits.ts`). Not covered by a test: a command result that arrives while a turn runs (`mayWait`), which needs a command started outside a turn and a turn started during it.
- [x] G3.10 docs: `docs/graph.md` complete, with the boundary of the limits stated plainly (`readOnly` is not
      enforced on `bash`; a running child keeps the limits it started with; a child in a worktree matches against
      its own cwd);
      `environment-variables.md`, `subagent.md`, `slash-commands.md`, `porting.md`
      Done: `graph.md` rewritten for the whole feature, `environment-variables.md`, `subagent.md`, `slash-commands.md`, `porting.md`, `docs/xin-pi.md`, both READMEs.
