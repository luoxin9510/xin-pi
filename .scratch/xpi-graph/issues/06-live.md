# Tickets: observability milestone 2, live view and events

Spec: `.scratch/xpi-graph/02-observability.md` (sections 5, 7 events). One PR (branch `graph-live`), after
milestone 1: `npm run check`, the tests, green CI, an independent Opus review, the docs.

- [ ] O2.1 `onOutput(text)` in `RunOptions` of `extensions/checks/runner.ts`, called with each stdout and stderr
      chunk; the kept output unchanged; runner tests
- [ ] O2.2 while a command node runs, with a UI: footer `graph <name>: <node> <elapsed>` refreshed each second, and
      a `graph` widget with the command and the last 5 output lines; both cleared when the command ends, is aborted
      or the graph stops; the suite's fake runner calls `onOutput`
- [ ] O2.3 bus events `graph:start`, `graph:enter`, `graph:command`, `graph:asked`, `graph:blocked`,
      `graph:halt`, `graph:end`, each with `{ graph, node, visit }`, emitted as the entry is written; a suite test
      of the order for a short run
- [ ] O2.4 by hand, real Haiku 5.5: after the end-to-end `dev` run, `/graph` and `/graph --json`; the report's
      cost against the session's usage summed by hand; results in `decisions.md`
- [ ] O2.5 docs: `docs/graph.md` (live view, events), `docs/extensions.md` if it lists built-in events,
      `docs/porting.md` (the graph unit: widget and bus)
