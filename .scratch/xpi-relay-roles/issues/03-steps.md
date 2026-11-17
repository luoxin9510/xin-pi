# Ticket 03: a step list for a round

Decisions 20-30 of `decisions.md` (Grill 5).

- [x] T1 `xpi-relay/src/steps.ts`: `cleanSteps`, `readSteps` (the handover's `steps` and `relay.step` entries),
      `applyStep`, `renderSteps`, `stepsWidget`
- [x] T2 `handover` takes `steps`; the tool `step` (worker only, relay model only, no phase change); the worker's
      section, the record, `/relay`; `Relay.stepsWidget`
- [x] T3 setting `relay.steps` (config, settings schema, regenerated JSON schema); the direct fallback declares
      `step` only while it is on
- [x] T4 the built-in sets the widget at `request_start`, `tool_execution_end`, `agent_end`, `session_start`,
      `model_select`
- [x] T5 tests: `xpi-relay/test/steps.test.ts`, `host.test.ts`; the faux flow in `test/suite/relay.test.ts`
- [x] T6 docs: `relay.md` ("The step list", the record, settings), `settings.md`, `porting.md`, `xpi-relay/README.md`
- [ ] T7 real runs (decision 30), recorded on the PR before merge
