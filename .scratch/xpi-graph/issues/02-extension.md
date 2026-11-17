# Tickets: milestone 2, the smallest runnable `builtin:graph`

Spec: `.scratch/xpi-graph/01-graph.md` (sections 1, 4, 5, 7). One PR (branch `graph-extension`), after milestone 1:
`npm run check`, the suite tests, green CI, an independent Opus review, the docs.

In this milestone a graph has model nodes and `model` edges only. A graph that uses a command node, an `approve`
edge, `deny` or `readOnly` is refused at `/graph start` with "not supported yet", so that no graph runs with a
control silently missing. Milestone 3 removes the refusal.

- [ ] G2.0 the coding agent takes the package: `xpi-graph` as an exact-version dependency in
      `packages/xpi-coding-agent/package.json`, `npm --prefix ../xpi-graph run build` in its `build:binary` chain,
      the lockfile refreshed (and the install lock checked with `npm run check`)
- [ ] G2.1 the literal parser moves out of `extensions/subagent/workflows.ts` to a shared file and reads
      `export default <literal>` as well as `export const meta = <literal>` (it already skips comments and refuses
      `${}`); the workflow tests pass unchanged
- [ ] G2.2 discovery: `.pi/graphs/` from the cwd up to the repository root (trusted projects only), then
      `<agent dir>/graphs/`; the agent directory through the helpers of `src/config.ts`
- [ ] G2.3 `builtin:graph` registered with the built-ins; the virtual model `graph/auto` (registered at load) and
      its router; selected by hand with no graph, the selection is put back; the fixed `graph` section of the
      system prompt, present only while a graph runs; a subagent child gets no command, tool or virtual model
- [ ] G2.4 `/graph`, `/graph start <name>` (enters the start node and starts the turn), `/graph stop`; the stored
      selection restored at the end; another model selected by `set` or `cycle` ends the graph, a `restore` does
      not; start refused when codemode is off, when a graph runs, or when a node without
      `model` meets a virtual selection
- [ ] G2.5 `next({ to, report })`, deferred exposure, inactive without a graph; the refusal that lists the
      targets; `graph.move` written by the tool; a second move in a visit and a move from a background script
      refused; the move entered at `agent_before_settle` or at the next request of the same run, whichever comes
      first (`graph.node`, `graph.enter`)
- [ ] G2.5b `graph.enter` sent again after `session_compact` on a running graph
- [ ] G2.6 resume and branches: the state is read from the branch at each use; `session_start` on a branch with a
      running graph activates the tool and the status
- [ ] G2.7 footer status
- [ ] G2.8 suite tests (`test/suite/graph.test.ts`, faux provider): the cases of the spec's Tests that this
      milestone covers, among them "no graph started: requests unchanged"; relay's tests pass unchanged
- [ ] G2.9 docs: `docs/graph.md` (first version, marked as incomplete until milestone 3), `settings.md`,
      `slash-commands.md`, `virtual-models.md`, `porting.md`, `xin-pi.md`, both READMEs, `docs.json`
- [ ] G2.10 by hand, real Haiku 5.5 (the lead runs it, after `npm run build`): a three-node graph on one model and
      a three-node graph on two models; the cache read and write tokens around each node change are recorded in the
      PR, with the conclusion for decision 10
