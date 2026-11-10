# 03: Agent names and `SendMessage`

Spec: `../03-names-and-messages.md`. Two tickets, branch `subagent-names-messages`.

**Status:** done (2026-11-10), branch `subagent-names-messages`

- [x] T1 `name`: validated (`[A-Za-z0-9_-]{1,64}`), stored in the meta file, `type(name) description` in the panel, the
      screen header and `/subagents`; unique per parent session (a claim taken before the first await, so two calls in
      one tick cannot both have it; given back when the call fails before it starts); `resume` takes a name or an id;
      a resume keeps the name, another name throws (`registry.ts`, `agent-tool.ts`, `exchange.ts`)
- [x] T2 `SendMessage({ to, message, summary? })` (`send-message-tool.ts`): steer to a running agent, returns at once
      with `delivered: "steer"` and no note to main; a finished one is continued through the Agent tool's own execute
      (same background rules); unknown target lists the session's agents
- [x] Offline: `test/subagent/faults/names.test.ts` (6), `send-message.test.ts` (4)
- [x] Real, haiku: `test/subagent/real/19-names-and-messages.test.ts` (continue by name keeps what it was told; a
      running agent takes the steer and its end message shows it)
- [x] Eval: "parent asks a named agent one more thing" (main uses `SendMessage` with the name), 3/3
- [x] `docs/subagent.md`: Names and SendMessage

## Comments

2026-11-10: **A name for an unnamed agent on resume throws** (the spec says a different name throws; "none" counts as
different). A name is given when an agent starts.

**Not done: the pty test of the panel and header text.** The label is one function (`label()` in `registry.ts`) used
by the panel, the header, `/subagents` and `/workflows`; it is covered by the offline test.
