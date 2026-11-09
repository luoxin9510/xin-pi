# 04: Docs ("Prompt caching") and owner look

**What to build:** `packages/xpi-coding-agent/docs/subagent.md` gets a section "Prompt caching": what is in the shared head and in the tail, why paths are relative, the tool-set limit on sharing, the 4-breakpoint rule with OAuth, `subagent.staggerStart` in the Config block with the rule of thumb (prefix above about 8k tokens, 3+ siblings, expensive model, +2-3 s), and the by-hand check (`test:subagent:cache`). `docs/xin-pi.md` lists the touched core files and the new test script; root `AGENTS.md` mentions the script next to the other real-model suites.

**Blocked by:** 01, 02, 03

**Status:** needs-owner-approval (spec `../spec.md`)

- [ ] Docs written; numbers in the section cite the measured runs from tickets 02 and 03, not the first experiment
- [ ] `test:subagent:cache` script exists and is documented as by-hand, Haiku 5.5 only, never in CI
- [ ] `npm run check` green (docs formatting)
- [ ] Owner looks: runs a fan-out of two agent types and a worktree child in a real repo and compares `cacheRead` in the session files; decides whether to turn `staggerStart` on; owner merges

## Comments
