# 06: Workflows, second part

Spec: `../06-workflows-2.md`. Branch `subagent-workflows-2`.

**Status:** done (2026-11-10)

- [x] T1 `.claude/workflows/` (project) and `~/.claude/workflows/` are read, below the `.pi` ones of the same level
      (`workflows.ts`); `/workflows` shows the directory; saving still writes only under `.pi`
- [x] T2 `agent()` resolves to `null` for a failed or stopped agent and rejects only when a `schema` was never met
      (`script-helpers.ts`); `parallel()` takes at most 4096 tasks
- [x] T3 Restart (`registry.ts`, `exchange.ts`, `panel.ts`, `subagent-screen.ts`): `r` in the panel, `/restart` on the
      screen; the exchange starts the child again after shelving its session as `<id>.restart-<n>.jsonl.bak`; the waiting
      call gets the last start's result with turns, time and cost added up
- [x] Offline: `workflows.test.ts` (sources), `script-helpers.test.ts` (null, schema never met, cap),
      `restart.test.ts` (4)
- [x] Real, haiku: Claude Code's documented example under `.claude/workflows/` runs unchanged
      (`real/18-workflows.test.ts`); a real agent restarted (`real/21-restart.test.ts`); pty: `r` in the panel
      (`tui/12-workflows.test.ts`)
- [x] Docs: `docs/subagent.md` (helpers table, sources, panel and screen keys, Restart), `docs/subagent-porting.md`

## Comments

2026-11-10: **Only a first run can be restarted.** The spec said "only a running agent"; two more cases are refused,
with the reason shown: an agent that was continued (starting over would drop its earlier conversation, which the
restart shelves as a whole) and a fork (its start is a copy of main taken once).

**The shelved session must not end in `.jsonl`.** The real test caught it: a child finds its session by id among the
`.jsonl` files of the session dir, so a shelved `<id>.restart-1.jsonl` was picked up again and the "restarted" agent
continued its old conversation. The fake child does not look for a session, so the offline test passed. The file is
now `<id>.restart-<n>.jsonl.bak`, and the real test checks that a new live session exists.

**"Schema never met" is told apart by the error text** the runner sets (`structured output did not match the schema
...`, `the agent ended without structured output`); the host global marks such a result, so the prelude stays free of
those strings.
