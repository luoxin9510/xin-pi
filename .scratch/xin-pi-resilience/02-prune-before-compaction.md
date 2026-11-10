# 02: Prune old tool output before compaction

Status: approved (Grill 1, `decisions.md`, 2026-11-10). Tickets in `issues/`.

Origin: the omp study (`~/Developer/omp-study/09-对比-xpi/xpi可借鉴清单.md`, item 2). omp replaces old tool results
with a placeholder (newest 40k tokens protected, nothing pruned unless it saves at least 20k) as a maintenance step on
every turn, with extra rules to protect the prompt cache.

## Problem Statement

When a session crosses the compaction threshold, xpi always summarises: one extra model call, and everything before
the cut point is reduced to prose, including the model's own reasoning and the user's words. Most of the tokens are
usually old tool output (file reads, command output) that the model no longer needs verbatim. Dropping those first
would often bring the context back under the threshold without losing the conversation itself.

## Solution

When compaction is about to run, xpi first replaces the content of old tool results with a short placeholder, keeping
the newest ones intact. If the context is now under the threshold, no summary is made. Otherwise compaction runs as
today on the pruned context. Pruning is recorded with the existing `context_edit` entries, so the session file stays
append-only, the original output stays in the file, and branches keep their own state.

## User Stories

1. As the owner, I want old tool output dropped before any summary is made, so that the conversation itself survives
   longer.
2. As the owner, I want pruning to skip the summary when it is enough, so that I save the summary call.
3. As the owner, I want the most recent tool results kept whole, so that the model still has what it is working on.
4. As the owner, I want pruning to happen only when compaction would happen anyway, so that it never breaks a warm
   prompt cache on its own.
5. As the owner, I want the placeholder to say what was removed and how big it was, so that the model knows to re-run
   a tool if it needs the output again.
6. As the owner, I want pruning to skip results too small to matter, so that the session is not filled with tiny
   edits.
7. As the owner, I want pruning to do nothing unless it saves a meaningful amount, so that it does not run for little
   gain.
8. As the owner, I want the original output to stay in the session file, so that `/tree`, fork and export still show
   it.
9. As the owner, I want pruning to follow the branch it happened on, so that other branches are not affected.
10. As the owner, I want overflow recovery (the provider rejected the request as too long) to prune first too, so that
    recovery is cheaper.
11. As the owner, I want settings for the protected window and the minimum saving, and a switch to turn pruning off,
    so that I can tune or disable it.
12. As an extension author, I want `session_before_compact` to still see and control compaction, so that existing
    extensions keep working.
13. As the owner, I want results of tools whose output is instructions (skills loaded through read) to be kept, so
    that pruning does not remove guidance the model still follows. (Grill question.)

## Implementation Decisions

- Placement: a step at the start of the compaction path in the agent session, used by both the threshold path and the
  overflow-recovery path. Not a per-turn step (omp's per-turn pruning and its cache rules are out of scope).
- Selection: walk tool results on the current branch from newest to oldest; the newest N tokens of tool output are
  protected; results under a small size are skipped; already pruned results count toward the window but are not
  pruned again; entries before the latest compaction are ignored (they are not sent).
- Gate: if the total saving is under the minimum, prune nothing.
- Recording: one `context_edit` per pruned result, replacing its content with a single text block:
  `[Tool output removed to save context: about N tokens. Run the tool again if you need it.]`. Images in a pruned
  result go too.
- After pruning, re-estimate the context with the existing projection estimate (it already distrusts stale usage when
  a `context_edit` is newer). Under the threshold → stop. Else continue into the existing compaction.
- Extensions: `session_before_compact` fires only when summarising actually runs. Whether pruning gets its own event
  is a Grill question.
- Settings under `compaction`: a switch, the protected window and the minimum saving (names and defaults in the Grill;
  proposed defaults 40000 and 20000 tokens, omp's numbers).

## Testing Decisions

- Good tests build sessions through `SessionManager`, run the session's compaction path, and assert on the projected
  context and on which entries were appended, not on internal helpers.
- Prior art: `test/session-context-edit.test.ts` (context_edit projection, branches, interaction with compaction,
  usage estimate), `test/compaction.test.ts` with `fixtures/large-session.jsonl`,
  `test/agent-session-auto-compaction-queue.test.ts`, `test/suite/agent-session-compaction.test.ts`.
- Cases: pruning alone gets under threshold → no summary call; not enough → summary runs on pruned context; saving
  under minimum → nothing appended; newest window untouched; branch isolation; overflow path prunes first; switch off
  restores today's behaviour.

## Out of Scope

- Per-turn pruning and omp's cache-protection heuristics.
- "Superseded by a newer read" and "uneventful result" elision.
- Changing the summary prompt or the cut-point rules.

## Further Notes

`docs/compaction.md` says a replacing `context_edit` stops the cut point from moving forward past it. That interaction
must be tested: pruning many old results must not prevent a later compaction from cutting.
