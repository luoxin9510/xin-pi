# Tickets: observability milestone 2, live view and events

Spec: `.scratch/xpi-graph/02-observability.md` (sections 5, 7 events). One PR (branch `graph-live`), after
milestone 1: `npm run check`, the tests, green CI, an independent Opus review, the docs.

- [x] O2.1 `onOutput(text)` in `RunOptions` of `extensions/checks/runner.ts`, called with each stdout and stderr
      chunk; the kept output unchanged; runner tests
      Done: one `StringDecoder` per stream (a character split between chunks comes whole), called past the 1 MiB cap
      too, an error it throws ignored; two tests in `test/checks-runner.test.ts`.
- [x] O2.2 while a command node runs, with a UI: footer `graph <name>: <node> <elapsed>` refreshed each second, and
      a `graph` widget with the command and the last 5 output lines; both cleared when the command ends, is aborted
      or the graph stops; the suite's fake runner calls `onOutput`
      Done: `liveView` in `extensions/graph/index.ts`; the widget is redrawn at most every 200 ms on output, colour
      codes are removed and a `\r` progress line shows its last state; the footer goes back to the plain status
      with the next `sync`.
- [x] O2.3 bus events `graph:start`, `graph:move`, `graph:enter`, `graph:command`, `graph:asked`,
      `graph:blocked`, `graph:halt`, `graph:end`, each with `{ graph, node, visit, at }`, emitted from the
      committed branch after the extension's own writes and at `agent_settled`, in order, never twice; none for
      dropped drafts; the mark set without emitting at `session_start` and `session_tree`, and when it is not on
      the branch; suite tests of the order, of a graph stopped while its command ran, of a resumed session and of
      `/tree`
      Done: `GRAPH_EVENTS`, `tell`, `markLatest`; tests in `graph-controls.test.ts` (order, dropped drafts) and
      `graph.test.ts` (resume, `/tree` there and back).
- [ ] O2.4 by hand, real Haiku 5.5: after the end-to-end `dev` run, `/graph` and `/graph --json`; the report's
      cost against the session's usage summed by hand; results in `decisions.md`
      Waiting for a fresh login (the Anthropic token on this machine expired on 2026-11-17).
- [x] O2.5 docs: `docs/graph.md` (live view, events), `docs/extensions.md` if it lists built-in events,
      `docs/porting.md` (the graph unit: widget and bus)
      Done, and `docs/checks.md` (`onOutput`).
