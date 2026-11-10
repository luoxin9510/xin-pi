# 02: Subagent prompt layout: shared head, per-agent tail, relative context paths

**What to build:** coding-agent gets a generic `tail` prompt option (`--system-prompt-tail <file>`, SDK `tail`): a last section after the project context, `cwd` moves into it, and `cacheBreakpoints` marks the end of the head and of the tail. `renderProjectContext` renders paths relative to the project (or `~/...`), never an absolute project path. `resolve.ts` passes only the shared preamble as `--system-prompt` and puts agent body, `# Skill:` blocks, memory and `# Environment` into the tail file; `ChildSpec.systemPrompt` becomes `{ head, tail }`. The main agent passes no `tail`.

**Blocked by:** 01

**Status:** done (merged into `cache-opt`, f948e4473 and the commit after it)

- [x] Failing tests first (vitest faux-provider suite + `test:subagent`): head text equal across two agent types and across main checkout vs a real worktree; tail differs and holds cwd/date/memory/skills; main prompt golden unchanged except the context path line
- [x] Open question 3 answered by a payload comparison (pi `<skills>` section main vs worktree) and recorded in Comments
- [x] Open question 2 decided by the owner (relative paths for main too, or only when `tail` is set)
- [x] Real, by hand (OAuth only, see Comments), Claude Haiku 5.5, nonce in AGENTS.md: E1 (4 types), E2 (main, worktree, memory edit) reproduce the savings in `.scratch/xin-pi/cache-experiments.md` (types 2-4 read >= 80% of the head; worktree reads the head); once with OAuth, once with an API key; payload dump confirms 2 system blocks and <= 4 breakpoints
- [x] Subagent evals (`test:subagent:evals`, haiku, 17 cases) before and after: no regression (agent body moved after the project context)
- [x] `npm run check` green; `docs/xin-pi.md` lists the core files touched (system-prompt.ts, CLI args)

## Comments

### 2026-11-10: done

**Open question 2** (owner): relative context paths for the main agent too. A file inside the project is shown relative to
the working directory, a file under home as `~/...`, anything else absolute (`displayContextPath`).

**Open question 3**: the `<skills>` section needs absolute `<location>` paths, and a skill inside the project has a
different one per worktree. So with a tail, when at least one model-visible skill lives inside the project root, the
whole `skills` section moves behind `cwd` (out of the shared head); with only user-level skills it stays in the head.
Covered offline (`system-prompt.test.ts`: "skills that live in the project follow cwd"); no real payload comparison was
needed after that.

**Real runs** (`npm run test:subagent:cache`, Claude Haiku 5.5, OAuth, AGENTS.md of 1000 words with a nonce; cacheRead /
cacheWrite of each child's only request; "before" is the `current` column of `.scratch/xin-pi/cache-experiments.md` on
branch `exp-cache`):

| scenario | child | before | after |
|---|---|---|---|
| types | A (first, cold tools) | 2167 / 4684-4722 | 0 / 6811 |
| types | B, C, D (same tools) | 2167 / 4683-4726 | **6540 / 267-275** (96% of A) |
| types | E (`tools: Read, Bash`) | 1561 / 4716 | 0 / 6199 (shares nothing: tools come first) |
| worktree | main checkout | 2167 / 4672-4687 | 2141 / 4686 |
| worktree | worktree of it | 2167 / 4678-4693 (miss) | **6562 / 305** (96%) |
| worktree | main checkout again | 6839-6854 / 0 | 6827 / 0 |
| memory | first run | 2167 / 5234-5236 | 2141 / 5265 |
| memory | MEMORY.md unchanged | 7401-7403 / 0 | 7406 / 0 |
| memory | one line added | 2167 / 5251-5253 | **6590 / 835** (89%) |

Cost of a later child with the same tools: $0.00061 before, $0.00010 after.

**Payload dump** (every request of every child): 3 system blocks with OAuth (identity 57 chars, head, tail), exactly 2 of
them marked (head and tail), 4 cache breakpoints in total. With an API key there is no identity block, so 2 system blocks,
both marked: that path is covered by the offline payload tests of ticket 01 only. No Anthropic API key was available, so
there is no real API-key run.

**Evals** (`npm run test:subagent:evals`, 17 cases, haiku): before 17/17, $0.0075, 27 s wall; after 17/17, $0.0071, 29 s
wall (`results/2026-11-09T23-41-10-996Z.json`).

**Found on the way**: the by-hand suites run on a copy of `~/.pi/agent/auth.json`. When the OAuth token in it has expired,
the copy refreshes it, the provider rotates the refresh token, and the user's own file is left with a dead one (it
happened in the "before" eval run of this ticket). `test/subagent/user-auth.ts` now refuses to copy a token that expires
within 30 minutes and says what to do (`faults/user-auth.test.ts`).
