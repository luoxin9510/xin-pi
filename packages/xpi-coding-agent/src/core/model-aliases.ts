/**
 * Built-in model aliases (the Claude Code names), shared by `ctx.complete()` and the subagent extension. The `models`
 * setting overrides them per alias.
 */
export const DEFAULT_MODEL_ALIASES: Record<string, string> = {
	opus: "anthropic/claude-opus-5-5",
	sonnet: "anthropic/claude-sonnet-5-5",
	haiku: "anthropic/claude-haiku-5-5",
	fable: "anthropic/claude-fable-5-2",
};
