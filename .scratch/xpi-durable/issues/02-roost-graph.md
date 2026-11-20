# Tickets: spec 01 milestone 2, roost and graphs

Spec: `.scratch/xpi-durable/01-interrupted-turn.md` (sections 6–7). One PR (branch `durable-roost`), after
milestone 1: the tests, green CI, an independent Opus review, the docs.

- [x] R2.1 roost's restart prompt is `/continue` (DM-5, both restarts while working, a resume of a failed row), one
      constant; `/bg` and the hub's `continue` command keep their text, `/bg`'s header says why; a row with nothing to continue ends as done; tests
- [x] R2.2 graph tests: a model node cut off mid-tool then `/continue` stays on the node's model; `next` before the
      crash; the core's recovery and a command node's recovery in one action, core first
- [x] R2.3 docs: roost (DM-5, `foreground.ts`'s header), `docs/graph.md`, `docs/porting.md`
- [x] R2.4 by hand (in `decisions.md`), Haiku 5.5, sandbox: a roost worker killed during a tool call restarts with
      `/continue` and finishes
