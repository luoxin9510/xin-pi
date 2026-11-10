# xin-pi cache decisions

## Grill 1 (2026-11-09)

1. Do it properly: split the system prompt into a shared head and a per-agent tail with a cache breakpoint each (respect Anthropic's 4-breakpoint limit, incl. the OAuth identity block); project context before the agent-specific part; agent body, skills, memory and Environment (cwd, date) in the tail; render context-file paths so worktree children share the head (no absolute paths in the head).
2. Staggered start of sibling subagents as an opt-in setting, default off.
3. Background result messages need no change (measured: cache intact).
4. Test both OAuth and API-key auth paths.

## Grill 1 addendum (2026-11-09): open questions, all as recommended

5. Generic small API in xpi-ai (`cacheBreakpoints` on the system message), no text markers.
6. Context-file paths render relative to the project (also in the main agent's prompt); `AGENTS.md` and
   `~/.pi/agent/AGENTS.md` stay distinguishable.
7. pi's `<skills>` absolute paths stay in the head for now; ticket 2's payload comparison decides if they must move.
8. `subagent.staggerStart` is a plain boolean (default false), no sibling threshold.
9. Stagger gate opens on the first child's earliest "first request streaming" rpc event, with a 5 s timeout.
