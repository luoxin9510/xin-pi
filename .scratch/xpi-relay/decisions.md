# Decisions: the xpi-relay package

## Direction (owner, 2026-11-15)

- Graph control (a transition table bound to the agent core's seams) is not made a package of its own. It is built
  into relay first: a new workspace package `xpi-relay`, with the graph engine as an internal module. A general
  package can be split out when a second user exists.
- The agent core may get new seams where relay needs them.
- Relay's purpose stays: transparency, observability, saving money, in one session. Orchestrating several agents
  belongs to workflows.
- Cost questions (the lead's context threshold, warming the lead's cache during a worker phase, replacing the
  conversation at a hand back or appending the record to it) are not settled: measure first. They are step 2, a
  separate spec.

## Grill 1 (2026-11-15). Accepted by the owner on 2026-11-15 ("好的都同意")

1. The split: `packages/xpi-relay` holds the logic and imports nothing from the coding agent (the session-entry
   shape it needs is a minimal type of its own). `builtin:relay` in the coding agent only wires it to the agent
   core: entries, notifications, commands, the acceptance commands.
2. The graph engine lives in `xpi-relay/src/graph/`, an internal module: not exported, no stability promise. Relay's
   definition is written on it.
3. The definition is a TypeScript object: data first, a few guard functions. No JSON or YAML.
4. Two steps. Step 1 (this spec) moves relay into the package and expresses it on the engine with no change of
   behaviour: the existing relay tests pass unchanged, plus real Haiku runs. Step 2 is the cost work, after
   measurement, in its own spec.
5. Two new core seams, in the second half of step 1, each its own ticket after the move passes: a commit point at the
   start of a request, and a structured hand-off signal on tool results. After each, the tests and the real Haiku
   runs again.
6. The engine checks at load that every state and event has an answer and refuses to load otherwise. The state
   diagram in `docs/relay.md` is generated from the definition.
7. Compatibility: entry names `relay.*`, settings `relay.*`, the model `relay/auto` and the commands stay. Sessions
   from before the change continue.

Author's notes while writing the spec:

- The package cannot import the coding agent (the coding agent depends on it), so "only wires" needs an interface:
  the package defines a small host interface and the built-in implements it. Porting relay to another host is then
  implementing that interface.
- "Pass unchanged" means the assertions: the machine tests move with the code, so their import paths change and
  nothing else.

## Step 2: measured first (2026-11-15)

The owner asked for measurement before any cost decision. `measurements-2026-11-15.md` has the numbers. What they
settled: the money is in the worker's requests above its model's first price tier; the lead hands over after one or
two requests, so appending the record instead of replacing the conversation changes nothing and is not built;
warming the lead's cache is worth about 9 percent of the lead's cost and waits.

The owner on the scope (2026-11-15, "我觉得可以做，不着急发布"): do the worker's context limit with a stuck guard,
tell the lead the facts, and measure the record's diff size; no release yet.

## Grill 2 (2026-11-15). Accepted by the owner on 2026-11-15 ("上限可以用户在 settings 里面灵活配置，其他我觉得按照推荐就可以了")

1. The worker's limit comes from the catalog: a fraction (95 percent) of the worker model's first price tier; no tier,
   no limit. **The owner: the limit must be freely configurable in settings.** So every part is a setting: the limit
   as `"tier"`, a number or `"off"`, the fraction, the number of compactions, what happens when the worker is stuck,
   and the same limit forms for the lead (off by default).
2. A core seam: a route may carry a context limit for its request, and the core compacts by it. This also closes the
   gap found while measuring (the compaction override is looked up by the selected virtual model, not by the model
   that answers).
3. At the limit, prune old tool output first and write a summary only when pruning is not enough, as a physical
   model already does.
4. A stuck guard: after 4 limit-triggered compactions in one round the limit is lifted for the rest of the round
   (the default), with an entry, a notification and a line in the record. The other behaviour, asking the worker to
   hand back with a progress report, is a setting.
5. The lead is told facts, not rules: the worker's price tier and that its context starts again after a hand back;
   after each hand back the round's peak context, compactions and whether the limit was lifted.
6. The record's diff size is measured (20000, 5000, 0) before any change of the default.
7. Validation: the three most expensive tasks twice each with the new logic, plus the diff comparison; budget $10.
   Pass: all three pass, their total cost is below the unlimited runs, and `workflows` does not time out.

