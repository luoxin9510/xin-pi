# 02: Subagent prompt layout: shared head, per-agent tail, relative context paths

**What to build:** coding-agent gets a generic `tail` prompt option (`--system-prompt-tail <file>`, SDK `tail`): a last section after the project context, `cwd` moves into it, and `cacheBreakpoints` marks the end of the head and of the tail. `renderProjectContext` renders paths relative to the project (or `~/...`), never an absolute project path. `resolve.ts` passes only the shared preamble as `--system-prompt` and puts agent body, `# Skill:` blocks, memory and `# Environment` into the tail file; `ChildSpec.systemPrompt` becomes `{ head, tail }`. The main agent passes no `tail`.

**Blocked by:** 01

**Status:** needs-owner-approval (spec `../spec.md`)

- [ ] Failing tests first (vitest faux-provider suite + `test:subagent`): head text equal across two agent types and across main checkout vs a real worktree; tail differs and holds cwd/date/memory/skills; main prompt golden unchanged except the context path line
- [ ] Open question 3 answered by a payload comparison (pi `<skills>` section main vs worktree) and recorded in Comments
- [ ] Open question 2 decided by the owner (relative paths for main too, or only when `tail` is set)
- [ ] Real, by hand, Claude Haiku 5.5, nonce in AGENTS.md: E1 (4 types), E2 (main, worktree, memory edit) reproduce the savings in `.scratch/xin-pi/cache-experiments.md` (types 2-4 read >= 80% of the head; worktree reads the head); once with OAuth, once with an API key; payload dump confirms 2 system blocks and <= 4 breakpoints
- [ ] Subagent evals (`test:subagent:evals`, haiku, 17 cases) before and after: no regression (agent body moved after the project context)
- [ ] `npm run check` green; `docs/xin-pi.md` lists the core files touched (system-prompt.ts, CLI args)

## Comments
