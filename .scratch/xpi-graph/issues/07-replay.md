# Tickets: spec 03 milestone 1, replay

Spec: `.scratch/xpi-graph/03-replay.md` (sections 1–6). One PR (branch `graph-replay`), after the spec PR:
`npm run check`, the package and suite tests, green CI, an independent Opus review, the docs.

- [ ] R1.1 `replay: "safe" | "unsafe"` on command nodes in `parseGraph` (default `"unsafe"`; other values and
      `replay` on a model node rejected), in the package's types and README
- [ ] R1.2 commands run outside the turn: `agent_before_settle` writes a command node's `graph.node` and does not
      continue; `agent_settled` starts `proceed` with direct writes and `mayWait`, not awaited; `before_agent_start`
      unchanged in what it does, with direct writes
- [ ] R1.3 `graph.run { at, node, run, replay, startedAt }` written before each command; `startedAt` shared with the
      command details
- [ ] R1.4 `readState`: a visit's runs and whether its last run is interrupted (finished = the matching
      `graph.command` message anywhere, or a later `graph.node`, `graph.move`, `graph.halt`, `graph.end`); an old
      session without `graph.run` reads as before
- [ ] R1.5 after a crash: `session_start` tells and writes nothing; at `before_agent_start` and `/graph goto` a safe
      run with fewer than 3 interruptions runs again; otherwise `graph.halt` with the reason, then the halt rules on
      a command node
- [ ] R1.6 `/graph` shows `interrupted ×N`; `--json` command visits have `runs: [{ startedAt, finished }]`;
      `graph:run` on the bus with `{ graph, node, visit, at, run, replay }`
- [ ] R1.7 `.pi/graphs/dev.js` and `release.js`: `replay` on every command node; `repo-graphs.test.ts` asserts it
- [ ] R1.8 docs: `docs/graph.md`, `docs/porting.md`, READMEs where they describe graphs
- [ ] R1.9 by hand (in `decisions.md`): a command-only graph killed with `kill -9` during `sleep`, reopened, safe and
      unsafe; the same with a Haiku 5.5 model node before the command node
