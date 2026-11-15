# Tickets: spec 01, the xpi-relay package

Spec: `.scratch/xpi-relay/01-package.md`. Three PRs, each with an independent Opus review, green CI, the docs and the
real Haiku runs (the lead runs them) before merge.

## PR A: the move (no change of behaviour)

- [ ] A1 the package skeleton, registered wherever a workspace package is (the `xpi-shadow-git` commit is the list)
- [ ] A2 the graph engine in `src/graph/`: `defineGraph` with its refusals, `transition`, `toMermaid`, `pairs`; tests
- [ ] A3 relay's definition as rows; `transition` re-exported; the 33 machine tests moved (import paths only); the
      exhaustive test against the reference copy of `machine.ts`
- [ ] A4 the pure modules moved (`view`, `router`, `prompts`, `record`, `facts`, `config`, `workspace`) on
      `RelayEntry`
- [ ] A5 `RelayHost` and `createRelay`; the built-in as the adapter; `host.test.ts`; the 29 suite tests unchanged
- [ ] A6 the generated diagram and table in `docs/relay.md`, with the staleness test
- [ ] A7 docs: the package README, `relay.md`, `porting.md`, `xin-pi.md`, the READMEs
- [ ] A8 real Haiku runs

## PR B: the commit point

- [ ] B1 core: the `request_start` event; tests; `docs/extensions.md`
- [ ] B2 relay records committed transitions there; `route()` without side effects; suite tests unchanged
- [ ] B3 docs (`relay.md`, `porting.md`) and real Haiku runs

## PR C: the hand-off signal

- [ ] C1 core: `signal` on tool results (session only, not sent to the provider); codemode copies the ending call's
      signal; the direct-call repair keeps it; tests
- [ ] C2 relay: `nextState()` reads the signal and still accepts the marker line of older sessions; the handover
      result drops the marker line; the changed suite assertions listed here
- [ ] C3 docs (`extensions.md`, `codemode.md`, `relay.md`, `porting.md`) and real Haiku runs
