# Ticket 02: the lead's work as a quote

Decisions 14-19 of `decisions.md` (Grill 4).

- [x] Q1 `quoteLeadWork(messages, round)` in `xpi-relay/src/quote.ts`: the quote, the folded system message, the
      worker's own messages after it; `undefined` without a handover in the context or nothing before it
- [x] Q2 `Relay.quoteLead(messages, call)`: only for relay, a worker phase, `relay.quoteLead` on; `section(call,
      quoted)` names the quote in the worker's sentence
- [x] Q3 the built-in's `context_with_system` quotes from `convertToLlm(messages)`, then sets the section
- [x] Q4 setting `relay.quoteLead` (config, settings schema, regenerated JSON schema)
- [x] Q5 tests: `xpi-relay/test/quote.test.ts`, `host.test.ts`; faux flow in `test/suite/relay.test.ts` (roles of the
      worker's requests; `quoteLead: false`)
- [x] Q6 docs: `relay.md` (worker's section, "The lead's work as a quote", settings), `settings.md`, `porting.md`,
      `xpi-relay/README.md`
- [ ] Q7 real run (needs a login): Haiku as the lead, 30 small tasks, no mix-up (`relay.mixup`, `relay.stall` reason
      `idle`), all pass, cost not above the run without the quote; recorded on the PR before merge
