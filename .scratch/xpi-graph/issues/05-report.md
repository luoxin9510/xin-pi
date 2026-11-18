# Tickets: observability milestone 1, the report

Spec: `.scratch/xpi-graph/02-observability.md` (sections 1–4, 6, 7 `--json`). One PR (branch `graph-report`), after
the spec PR: `npm run check`, the package and suite tests, green CI, an independent Opus review, the docs.

- [x] O1.1 `at` in the data of every graph entry the extension writes (`graph.start`, `graph.node`, `graph.move`,
      `graph.halt`, `graph.blocked`, `graph.asked`, `graph.end`), taken when the entry is made, draft or not;
      `duringRun` in `graph.end`
      Done: `stamp`/`append` in `extensions/graph/index.ts`; `proceed`'s `write` stamps once for the local fold and
      the sink; `endData(ctx, reason)` sets `duringRun: !ctx.isIdle()`.
- [x] O1.2 `report(entries, now)` in `xpi-graph` (`src/report.ts`, exported): the last run on the branch; visits
      with node, kind, the models that answered or the command, `startedAt`, `durationMs`, `waitMs`, usage in
      `own` / `tools` / `other`, how each was left or `pending`; `asked`, `blocked`, `halts`; totals and per-model
      totals (virtual-model usage under the visit's model); `status: "error"` with the visits read so far;
      `schemaVersion: 1`; times from `at`, else `timestamp`
      Done, with one choice: in `byModel` a script's tool-result usage goes under `nested calls`, not the visit's
      model, because the session does not record which model a nested call (a subagent) used.
- [x] O1.3 a visit's entries: to the next `graph.node`; for the last visit of an ended run, after `graph.end` only
      `own` and `tools` up to the first assistant message with no tool call, never past a user message; a
      `graph.command` matched to its visit by `details.node` and `startedAt`
      Done.
- [x] O1.4 `mermaid(graph, report)`: `flowchart LR`, the current node and the edges taken marked
      Done: node ids `n0…` (graph ids may hold `-`), `end` as `n_end`, command nodes as subroutine shapes, `max` on
      the edge label, `classDef visited/current`, `linkStyle` for the edges taken.
- [x] O1.5 `graph.command` messages carry `details` (`node`, `run`, `code`, `timedOut`, `startedAt`,
      `durationMs`, `lines`, `outcome`) through a third argument of `Sink.message`; the text is unchanged;
      `report` reads a message without `details`
      Done.
- [x] O1.6 `graph.asked` written for every answer of the approval question (`approve`, `send_back`, `stop`,
      `dismissed`, with `askedAt`), before the move or the end it causes; `readState` ignores it, with a test
      Done (`readState`'s `step` already passes over it; test in `report.test.ts`).
- [x] O1.7 `/graph` shows the report when the branch has a run, running or ended, then the Mermaid text; with no
      run, the graph files as today; `/graph --json` with no prefix (a notice with a UI, one stdout line
      without); the usage line in `/graph`'s help and the roost command table
      Done: `formatReport` in the package; the loop counts of the current node's edges kept under the table.
- [x] O1.8 tests: package (report, mermaid, readState), suite (end-of-turn timing, stop inside a script,
      details, asked, `/graph` after the end, `--json` as an RPC client gets it, total against the session's
      usage)
      Done: `packages/xpi-graph/test/report.test.ts` (19), six suite tests in `test/suite/graph-controls.test.ts`
      ("what a run shows"), the `/graph` test of `graph.test.ts` on the new text.
- [x] O1.9 docs: `docs/graph.md` "What a run shows" (report, counted and not counted, `--json`),
      `docs/slash-commands.md`, `docs/porting.md` (the graph unit: `report`, `mermaid`), `docs/xin-pi.md` if it
      describes `/graph`, `packages/xpi-graph/README.md`
      Done, and both READMEs.
