# 01: System message cache breakpoints in xpi-ai (Anthropic split, payload tests)

**What to build:** `SystemMessage.cacheBreakpoints?: string[]` (section names after which a breakpoint is requested) in `xpi-ai`, and the Anthropic provider splits the leading system message into blocks at those sections, each with `cache_control`. Text rendering is unchanged, so other providers get the same text. Breakpoint budget (max 4 per request) allocates by priority: last message, last tool, system tail, system head, OAuth identity block. An opt-in payload dump goes through `onPayload`, not an env var in the provider.

**Blocked by:** none

**Status:** needs-owner-approval (spec `../spec.md`)

- [ ] Failing vitest first (`packages/xpi-ai/test/anthropic-system-cache-breakpoints.test.ts`): matrix {API key, OAuth} x {no hint, head+tail hint, `cacheRetention: "none"`, `"long"`}
- [ ] Blocks concatenate to the unsplit text; `cache_control` on the last block of each region; total breakpoints <= 4 in every cell; OAuth identity block loses its breakpoint only when over budget; API key keeps all four
- [ ] A system message without hints produces a payload byte-identical to today's (golden)
- [ ] Non-Anthropic provider test: same text with and without hints (no marker leaks)
- [ ] Hint naming a section that does not exist is ignored (or throws at the trust boundary; pick one, document it)
- [ ] `npm run check` green; `./test.sh` for the new file passes

## Comments
