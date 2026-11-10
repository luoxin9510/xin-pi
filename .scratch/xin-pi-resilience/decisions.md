# Decisions

Three specs ported from the omp study (`~/Developer/omp-study/09-对比-xpi/xpi可借鉴清单.md`, tier 1):

- `01-stale-edit-guard.md`: edit/write refuse a file that changed since it was read.
- `02-prune-before-compaction.md`: drop old tool output before summarising.
- `03-error-kinds.md`: classify provider errors once; retry by kind, not by text.

Facts behind the drafts were checked against main `5b70c1f51` on 2026-11-10 (three read-only investigations plus
spot checks). Flow: Grill 1 → owner approves → tickets in `issues/` → implementation, one PR per spec.

## Grill 1 (2026-11-10): waiting for the owner

Each line is worded so "yes" accepts the proposal.

Order

1. Three separate PRs in the order 01 → 02 → 03 (smallest and most useful first; 03 is the largest and touches every
   provider).

Stale-edit guard (`01`)

2. Claude Code's rule: `edit`, and `write` over an existing file, fail when the file was not read in this session
   ("Read it first"), and fail when it changed since the last read or write. Nothing is persisted, so after resume or
   in a fresh subagent the first edit of a file needs a read (one extra tool call).
3. Line-end noise does not count: the fingerprint ignores trailing spaces/tabs and CR (omp does the same), so an editor
   trimming whitespace does not trigger the guard.
4. A paged read (`offset`/`limit`) counts as reading the file; an image read does not.
5. One top-level setting, `staleEditGuard` (boolean, default true, like `hideThinkingBlock`), turns the guard off.

Prune before compaction (`02`)

6. Prune only on the compaction path (threshold and overflow recovery), never as a per-turn step: it then never costs
   a warm cache on its own.
7. Defaults from omp: newest 40000 tokens of tool output protected, nothing pruned unless the total saving is at least
   20000 tokens, results under 50 tokens skipped. Settings `compaction.prune.enabled` (true),
   `compaction.prune.protectTokens`, `compaction.prune.minSavingsTokens`.
8. Results of reading a skill file (SKILL.md from any skill directory) are never pruned.
9. No new extension event: pruning shows up as appended `context_edit` entries; `session_before_compact` keeps its
   meaning and fires only when a summary is actually about to be made.

Error kinds (`03`)

10. Kinds: `transient`, `rate_limit`, `usage_limit`, `context_overflow`, `auth`, `invalid_request`, `unknown`; only
    `transient` and `rate_limit` are retried.
11. A provider's retry-after replaces the computed backoff; when it is longer than `retry.maxAgentDelayMs` the session
    stops at once with a message giving the wait (the provider layer already does this with its own cap).
12. Rollout inside spec 03: first PR adds the classifier, the fields and the session's use of them, and converts
    Anthropic and the OpenAI family; a second PR converts Google, Bedrock and Codex and deletes their special cases.
