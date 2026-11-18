# Tickets: observability milestone 1, the report

Spec: `.scratch/xpi-graph/02-observability.md` (sections 1–4, 6, 7 `--json`). One PR (branch `graph-report`), after
the spec PR: `npm run check`, the package and suite tests, green CI, an independent Opus review, the docs.

- [ ] O1.1 `report(entries, now)` in `xpi-graph` (`src/report.ts`, exported): the last run on the branch; visits
      with node, kind, model or command, `startedAt`, `durationMs`, usage (own and `tools`), how each was left;
      `asked`, `blocked`, `halts`; totals and per-model totals; `schemaVersion: 1`
- [ ] O1.2 usage per visit from assistant `message` entries, `toolResult` messages with `usage`, and `usage`
      entries of kind `nested_tool_calls`; nothing before `graph.start` or after `graph.end`
- [ ] O1.3 `mermaid(graph, report)`: `flowchart LR`, the current node and the edges taken marked
- [ ] O1.4 `graph.command` messages carry `details` (`node`, `run`, `code`, `timedOut`, `durationMs`, `lines`,
      `outcome`); the text is unchanged; `report` reads a message without `details`
- [ ] O1.5 `graph.asked` written for every answer of the approval question (`approve`, `send_back`, `stop`,
      `dismissed`); `readState` ignores it, with a test
- [ ] O1.6 `/graph` shows the report when the branch has a run, running or ended, then the Mermaid text; with no
      run, the graph files as today; `/graph --json`; usage line in `/graph`'s help and the roost command table
- [ ] O1.7 tests: package (report, mermaid, readState), suite (details, asked, `/graph` after the end, `--json`)
- [ ] O1.8 docs: `docs/graph.md` "What a run shows" (report, counted and not counted, `--json`),
      `docs/slash-commands.md`, `packages/xpi-graph/README.md`
