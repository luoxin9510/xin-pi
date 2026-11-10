# 04: Docs ("Prompt caching") and owner look

**What to build:** `packages/xpi-coding-agent/docs/subagent.md` gets a section "Prompt caching": what is in the shared head and in the tail, why paths are relative, the tool-set limit on sharing, the 4-breakpoint rule with OAuth, `subagent.staggerStart` in the Config block with the rule of thumb (prefix above about 8k tokens, 3+ siblings, expensive model, +2-3 s), and the by-hand check (`test:subagent:cache`). `docs/xin-pi.md` lists the touched core files and the new test script; root `AGENTS.md` mentions the script next to the other real-model suites.

**Blocked by:** 01, 02, 03

**Status:** docs done (2026-11-10); the owner look is open

- [x] Docs written; numbers in the section cite the measured runs from tickets 02 and 03, not the first experiment
- [x] `test:subagent:cache` script exists and is documented as by-hand, Haiku 5.5 only, never in CI
- [x] `npm run check` green (docs formatting)
- [ ] Owner looks: runs a fan-out of two agent types and a worktree child in a real repo and compares `cacheRead` in the session files; decides whether to turn `staggerStart` on; owner merges

## Comments

2026-11-10: docs written.

- `packages/xpi-coding-agent/docs/subagent.md`: new section "Prompt caching" (head and tail, what sharing depends on,
  the four breakpoints, "Siblings started at the same moment" with the table from ticket 03), `staggerStart` in the
  Config block, `test:subagent:cache` in the Development list.
- `docs/xin-pi.md`: the stagger files and test in "Core changes: prompt cache layout", the script row in Testing.
- Root `AGENTS.md`: `cache` added to both lists of by-hand real-model scripts.
- Numbers come from the runs recorded in tickets 02 and 03. The whole script was run once more at the end
  (types 96%, worktree 96%, memory 89%, stagger -50% / -58%; all checks passed, $0.0096).
- No changelog entry: this fork has not recorded its own features in `CHANGELOG.md` so far.
- The rule of thumb says "about 2 s per cold batch", as measured (the ticket text said +2-3 s).

Open: the owner look (last checkbox) and the merge.
