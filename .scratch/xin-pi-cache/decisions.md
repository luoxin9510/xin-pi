# xin-pi cache decisions

## Grill 1 (2026-11-09)

1. Do it properly: split the system prompt into a shared head and a per-agent tail with a cache breakpoint each (respect Anthropic's 4-breakpoint limit, incl. the OAuth identity block); project context before the agent-specific part; agent body, skills, memory and Environment (cwd, date) in the tail; render context-file paths so worktree children share the head (no absolute paths in the head).
2. Staggered start of sibling subagents as an opt-in setting, default off.
3. Background result messages need no change (measured: cache intact).
4. Test both OAuth and API-key auth paths.
