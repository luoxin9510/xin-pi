# Tickets: milestone 2, the smallest runnable `builtin:graph`

Spec: `.scratch/xpi-graph/01-graph.md` (sections 1, 4, 5, 7). One PR (branch `graph-extension`), after milestone 1:
`npm run check`, the suite tests, green CI, an independent Opus review, the docs.

In this milestone a graph has model nodes and `model` edges only. A graph that uses a command node, an `approve`
edge, `deny` or `readOnly` is refused at `/graph start` with "not supported yet", so that no graph runs with a
control silently missing. Milestone 3 removes the refusal.

- [x] G2.0 the coding agent takes the package: `xpi-graph` as an exact-version dependency in
      `packages/xpi-coding-agent/package.json`, `npm --prefix ../xpi-graph run build` in its `build:binary` chain,
      the lockfile refreshed (and the install lock checked with `npm run check`)
      Done: the dependency (exact version), `build:binary`, `tsconfig.build.json`, `examples/tsconfig.json`, the lockfile.
- [x] G2.1 the literal parser moves out of `extensions/subagent/workflows.ts` to a shared file and reads
      `export default <literal>` as well as `export const meta = <literal>` (it already skips comments and refuses
      `${}`); the workflow tests pass unchanged
      Done: `src/utils/literal.ts` (the parser, unchanged); `extensions/graph/files.ts` reads `export default <literal>` and refuses anything after it; the workflow tests pass unchanged (38).
- [x] G2.2 discovery: `.pi/graphs/` from the cwd up to the repository root (trusted projects only), then
      `<agent dir>/graphs/`; the agent directory through the helpers of `src/config.ts`
      Done: `discoverGraphs`, `graphDirs` in `files.ts`; `test/graph-files.test.ts`.
- [x] G2.3 `builtin:graph` registered with the built-ins; the virtual model `graph/auto` (registered at load) and
      its router; selected by hand with no graph, it answers with the last model and a notice; a stale selection
      after an ended graph is replaced at `session_start`; the fixed `graph` section of the
      system prompt, present only while a graph runs; a subagent child gets no command, tool or virtual model
      Done: `extensions/graph/index.ts`, registered in `extensions/index.ts`.
- [x] G2.4 `/graph`, `/graph start <name>` (enters the start node and starts the turn), `/graph stop`; the stored
      selection restored at the end; another model selected by `set` or `cycle` ends the graph, a `restore` does
      not; start refused when codemode is off, when a graph runs, or when the selected
      model is a virtual model
      Done.
- [x] G2.5 `next({ to, report })`, deferred exposure, inactive without a graph; the refusal that lists the
      targets; `graph.move` written by the tool; a second move in a visit and a move from a background script
      refused; the move entered at `agent_before_settle` or at the start of the next request, whatever starts it
      (`graph.node`, `graph.enter`); one more request only after a `completed` turn
      Done, with one change: a move is entered at the end of its turn or before the next run, never at a request inside a turn (see the spec, section 5).
- [x] G2.5b `graph.enter` sent again after `session_compact` on a running graph
      Done.
- [x] G2.6 resume and branches: the state is read from the branch at each use; `session_start` on a branch with a
      running graph activates the tool and the status
      Done.
- [x] G2.7 footer status
      Done: the status follows at each request, with the count of the edge that entered the node.
- [x] G2.8 suite tests (`test/suite/graph.test.ts`, faux provider): the cases of the spec's Tests that this
      milestone covers, among them "no graph started: requests unchanged"; relay's tests pass unchanged
      Done: `test/suite/graph.test.ts` (28 tests), `test/graph-files.test.ts` (11 tests); `test/suite/relay.test.ts` passes unchanged.
- [x] G2.9 docs: `docs/graph.md` (first version, marked as incomplete until milestone 3), `settings.md`,
      `slash-commands.md`, `virtual-models.md`, `porting.md`, `xin-pi.md`, both READMEs, `docs.json`
      Done: `graph.md` (new), `settings.md`, `slash-commands.md`, `virtual-models.md`, `porting.md`, `docs.json`, `docs/xin-pi.md`, both READMEs.
- [x] G2.10 by hand, real Haiku 5.5 (the lead runs it, after `npm run build`): a three-node graph on one model and
      a three-node graph on two models; the cache read and write tokens around each node change are recorded in the
      PR, with the conclusion for decision 10
      Done, one graph: three nodes on one model (Haiku 5.5), `xpi -p "/graph start one"` in a sandbox. The graph ran
      to its end and the file it was asked for was right. Usage per request (input / cache read / cache write):
      node 1: 4 / 0 / 6055, then 2 / 6055 / 321; node 2: 4 / 6376 / 202, then 2 / 6578 / 107; node 3: 4 / 6685 / 397,
      then 2 / 7082 / 108. Total cost $0.0016. Conclusion for decision 10: a move between two nodes on one model
      keeps the prompt cache (the first request of a new node reads everything before it and writes only the new
      messages), so the rule stays as it is. The two-model graph was not run: real-model runs are on Haiku only,
      and a change of model writes a new cache by the provider's design, whatever the graph does.
      Found by this run: in print mode the process ended when `/graph start` returned and cut the first turn off;
      the command now waits for the session to be idle when there is no UI.
