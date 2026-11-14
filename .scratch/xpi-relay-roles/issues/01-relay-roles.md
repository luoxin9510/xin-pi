# Tickets: spec 01, relay roles

Spec: `.scratch/xpi-relay-roles/01-relay-roles.md`. One PR (branch `relay-roles`): independent Opus review, green CI,
the docs, the real Haiku runs before merge.

- [ ] R1 `machine.ts`: the transition table and `Effect`s; a test for every (state, event) pair
- [ ] R2 codemode seam B: a nested `terminate` ends the script and the codemode call; tests
- [ ] R3 codemode seam A: tools that stay out of codemode's listing and `searchTools()`, still callable; tests
- [ ] R4 core seam C: a direct call of a codemode-only tool runs as a nested call with a note; tests in the loop and a
      suite test
- [ ] R5 relay on the machine: markers instead of the `handover` tool result, codemode exposure with the direct
      fallback, entries for mixups/stalls/pause, `agent_before_settle` through the machine, commands through the
      machine
- [ ] R6 role prompts: the `context_with_system` handler and the `relay` section per role; neutral tool descriptions
- [ ] R7 suite tests of the spec's list
- [ ] R8 docs: `relay.md`, `codemode.md`, `extensions.md`, `porting.md`, `xin-pi.md`, READMEs
- [ ] R9 real runs (the lead runs them): `npm run test:relay:real`, and a Haiku-lead session across a handover and a
      hand back
