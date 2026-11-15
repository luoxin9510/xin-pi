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
