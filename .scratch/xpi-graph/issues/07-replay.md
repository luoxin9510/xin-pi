# Tickets: spec 03 milestone 1, replay

Spec: `.scratch/xpi-graph/03-replay.md` (sections 1–6). One PR (branch `graph-replay`), after the spec PR:
`npm run check`, the package and suite tests, green CI, an independent Opus review, the docs.

- [ ] R1.1 `replay: "safe" | "unsafe"` on command nodes in `parseGraph` (default `"unsafe"`; other values and
      `replay` on a model node rejected), in the package's types and README
- [ ] R1.2 `readState`: a command visit's runs (`startedAt`, `finished`) and condition (halted, finished,
      interrupted, not started); finished only by an entry carrying the run's `startedAt` (the `graph.command`
      details, `runStartedAt` on the move or halt it wrote); an old session without `graph.run` reads as before
- [ ] R1.3 `graph.run { at, node, run, replay, startedAt }` written before each command; `runStartedAt` on the
      move and the halt a run writes; `interrupted: startedAt` on the halt for an interruption
- [ ] R1.4 a core API for an extension to have the session written to disk now; the graph calls it before the first
      `graph.run`
- [ ] R1.5 commands run outside the turn: `agent_before_settle` writes a command node's `graph.node`, notes the visit
      and does not continue; `agent_settled` (not aborted, the noted visit, may start) syncs the footer and starts
      `proceed` with direct writes and `mayWait`, not awaited; never on a halted or finished visit or while
      `commandRun` is set
- [ ] R1.6 without a UI: `/graph start|goto` wait in a loop for idle and no pending command run; `session_shutdown`
      with reason `quit` waits for a running command, writes its result and starts no turn; other reasons and any
      shutdown with a UI abort as now
- [ ] R1.7 after a crash: `session_start` tells and writes nothing; at `before_agent_start` (started, not awaited:
      R12) and `/graph goto` a visit noted by this process, or a safe run with fewer than 3 interruptions
      (a not-started visit found at `session_start` counts as interrupted), starts; otherwise
      `graph.halt` with the reason, then the halt rules on a command node
- [ ] R1.8 `/graph` shows `interrupted ×N`; `--json` command visits have `runs: [{ startedAt, finished }]`;
      `graph:run` on the bus with `{ graph, node, visit, at, run, replay }`
- [ ] R1.9 `.pi/graphs/dev.js` and `release.js`: `replay` on every command node (section 6); `repo-graphs.test.ts`
      asserts it
- [ ] R1.10 docs: `docs/graph.md`, `docs/extensions.md` (persist API), `docs/porting.md`, READMEs where they
      describe graphs
- [ ] R1.11 by hand (in `decisions.md`): a command-only graph started first in a new session, killed with `kill -9`
      during `sleep`, reopened, safe and unsafe; the same with a Haiku 5.5 model node before the command node; one
      `xpi -p "/graph start …"` through a command node
