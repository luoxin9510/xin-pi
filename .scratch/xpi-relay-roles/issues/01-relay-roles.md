# Tickets: spec 01, relay roles

Spec: `.scratch/xpi-relay-roles/01-relay-roles.md`. One PR (branch `relay-roles`): independent Opus review, green CI,
the docs, the real Haiku runs before merge.

- [ ] R1 `machine.ts`: the transition table and `Effect`s; a test for every (state, event) pair
- [ ] R2 codemode seam B: a nested `terminate` ends the script and the codemode call; tests
- [ ] R3 codemode seam A: `listed: false` keeps a deferred tool out of `searchTools()`, `describeTool()` and `ALL_TOOLS`,
      still callable; tests
- [ ] R4 core seam C: a direct call of a codemode-only tool runs as a nested call with a note; tests in the loop and a
      suite test
- [ ] R5 relay on the machine: the marker as the last line of the tool result, the pending-hand-off view, codemode exposure with the direct
      fallback, entries for mixups/stalls/pause, `agent_before_settle` through the machine, commands through the
      machine
- [ ] R6 role prompts: the `context_with_system` handler and the `relay` section per role; neutral tool descriptions
- [ ] R6b observability: `relay.transition` entries, a visible line per transition and repair, `/relay` history and
      spend, repairs in the record
- [ ] R7 suite tests of the spec's list
- [ ] R8 docs: `relay.md`, `codemode.md`, `extensions.md`, `porting.md`, `xin-pi.md`, READMEs
- [ ] R9 real runs (the lead runs them): `npm run test:relay:real`, and a Haiku-lead session across a handover and a
      hand back
