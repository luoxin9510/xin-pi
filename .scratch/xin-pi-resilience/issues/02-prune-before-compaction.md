# 02: Prune old tool output before compaction

Spec: `../02-prune-before-compaction.md`, decisions 6-9 in `../decisions.md`.

**What to build:** when the session is about to compact (threshold reached, or overflow recovery), it first replaces
the content of old tool results with a placeholder by appending `context_edit` entries. The newest tool output is kept.
If the re-estimated context is then under the threshold, no summary is made; otherwise compaction runs as today on the
pruned context.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] Selection on the current branch, newest to oldest: the newest `protectTokens` (default 40000) of tool output are
      kept; results under 50 tokens skipped; already pruned results count toward the window and are not pruned again;
      entries before the latest compaction ignored; results of reading a skill file (SKILL.md) never pruned
- [ ] Gate: total saving under `minSavingsTokens` (default 20000) → nothing appended
- [ ] Each pruned result gets one `context_edit` whose replacement is one text block:
      `[Tool output removed to save context: about N tokens. Run the tool again if you need it.]` (images go too)
- [ ] Runs at the start of both compaction paths (threshold and overflow recovery); after pruning, re-estimate with the
      existing projection estimate; under the threshold → stop, no summary, no `session_before_compact`
- [ ] Settings `compaction.prune.enabled` (true), `compaction.prune.protectTokens`, `compaction.prune.minSavingsTokens`
      in schema, defaults and settings manager; disabled restores today's behaviour exactly
- [ ] No new extension event; `session_before_compact` fires only when a summary is about to be made
- [ ] Tests: pruning alone gets under threshold → no summary call; not enough → summary on pruned context; saving under
      minimum → nothing appended; newest window untouched; skill read kept; branch isolation; overflow path prunes
      first; disabled; a later compaction can still cut past pruned entries (see the note in `docs/compaction.md`
      about replacing edits and the cut point)
- [ ] Docs: `packages/xpi-coding-agent/docs/compaction.md`, `docs/settings.md`
