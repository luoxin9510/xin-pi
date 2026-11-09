# 01: System message cache breakpoints in xpi-ai (Anthropic split, payload tests)

**What to build:** `SystemMessage.cacheBreakpoints?: string[]` (section names after which a breakpoint is requested) in `xpi-ai`, and the Anthropic provider splits the leading system message into blocks at those sections, each with `cache_control`. Text rendering is unchanged, so other providers get the same text. Breakpoint budget (max 4 per request) allocates by priority: last message, last tool, system tail, system head, OAuth identity block. An opt-in payload dump goes through `onPayload`, not an env var in the provider.

**Blocked by:** none

**Status:** closed (done 2026-11-09)

- [x] Failing vitest first (`packages/xpi-ai/test/anthropic-system-cache-breakpoints.test.ts`): matrix {API key, OAuth} x {no hint, head+tail hint, `cacheRetention: "none"`, `"long"`}
- [x] Blocks concatenate to the unsplit text; `cache_control` on the last block of each region; total breakpoints <= 4 in every cell; OAuth identity block loses its breakpoint only when over budget; API key keeps all four
- [x] A system message without hints produces a payload byte-identical to today's (golden)
- [x] Non-Anthropic provider test: same text with and without hints (no marker leaks)
- [x] Hint naming a section that does not exist is ignored (or throws at the trust boundary; pick one, document it)
- [x] `npm run check` green; vitest for the new file passes (`npx vitest --run test/anthropic-system-cache-breakpoints.test.ts` in packages/xpi-ai)

## Comments

- API as built: `SystemMessage.cacheBreakpoints?: string[]` (types.ts). Names are `"content"` (base text) or a key of `sections`. Only the leading message is read; `getCurrentSystemMessage` (collapse path, used by the Anthropic provider) carries it over from the leading message. `getSystemMessageRegions(message)` (utils/text.ts, exported from xpi-ai) splits the rendered text into regions ending at hinted parts; joined, they equal `getSystemMessageText`. The `\n\n` separator opens the next block. Unknown names are ignored (no throw); empty or null parts never count.
- Breakpoint budget (`buildParams`): max 4 `cache_control` per request. The last message and the last tool are marked first (as before); the system fills the remainder: last hinted region, earlier hinted regions (last to first), then the OAuth identity block. No hint: the whole prompt is one region (same bytes as before, golden test). So API key + 2 hints = msg + tools + tail + head = 4; OAuth + 2 hints drops the identity breakpoint; 3 hints drops the earliest hint. A remainder after the last hint is a block without a breakpoint. `cacheRetention: "none"` sends none; `"long"` puts one TTL on all. The count scans system, tools and messages, so it also respects any other marked block.
- Payload dump: no env var in the provider; use `onPayload` (existing seam) to log `system` blocks.
- Tests: `packages/xpi-ai/test/anthropic-system-cache-breakpoints.test.ts` (17 cases; the matrix, golden, OpenAI text identity). Red first: 7 failed (hint cases) before the provider change, then 17 pass.
- For ticket 02: hint names must match section keys of the system message the coding agent builds (check the real keys in `system-prompt.ts`; `"content"` is the base text). The prompt must reach the provider as a leading `SystemMessage` with `cacheBreakpoints` set; any code that rebuilds the system message (not via `getCurrentSystemMessage`) must copy the field.
