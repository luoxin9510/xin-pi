# Subagent prompt-cache layout: shared head, per-agent tail

Status: needs-owner-approval

Decisions behind this spec: `decisions.md`, "Grill 1" (2026-11-09), items 1-4. Measurements: branch `exp-cache`,
`.scratch/xin-pi/cache-experiments.md` (experiments E0-E4, Claude Haiku 5.5, about $0.05 total). Prototype diff:
`git diff main...exp-cache -- packages` (env-var gated, throwaway).

## Problem Statement

Every subagent child is a separate `xpi --mode rpc` process with its own system prompt. Anthropic's prompt cache reuses a
prefix only where an earlier request put a breakpoint, and today the whole system prompt is one text block with one
breakpoint. So the cache is wasted in three measured ways:

1. Two agent types in the same repo with the same tool set each write the project context (AGENTS.md etc., about 4.5k
   tokens in the experiment) again. The agent body comes first in the prompt, so any difference there invalidates
   everything after it (E1).
2. The agent's memory, the Environment block (cwd, date) and the agent body sit before the project context. A memory edit
   (agents write memory at the end of a run), a day rollover, or a worktree (different cwd) invalidates the project
   context too (E2). A worktree child also fails because `<project_instructions path="/abs/AGENTS.md">` embeds the checkout
   path even when the text is identical.
3. Siblings started in parallel all write the same prefix; sibling 2 and 3 find nothing because sibling 1 has not
   finished its first request (E3).

Cost, extrapolated from E1/E2/E3 at the 5-minute cache price ratios (write 1.25x, read 0.1x of input): every token moved from
write to read saves 1.15x the input price. Measured on haiku: -85% on the first request of each extra agent type, -85% on the
run after a memory edit, -95% on a worktree child's first request, -36% (4.3k prefix) to -52% (9.8k) on a 3-way fan-out.

## Solution

Lay the child's system prompt out as two cache regions and tell the provider where the boundary is:

- Head (shared across agent types): the codemode hint, then the project context, with context-file paths rendered
  relative to the project, so the text is the same in a worktree.
- Tail (per agent, volatile): agent body, skills, memory, and the Environment block (cwd, platform, date).

The head ends in a cache breakpoint and the tail ends in a second one. The split is a small generic capability of
`xpi-ai` (a system message may name sections after which a cache breakpoint is requested), not a subagent-only hack.
Providers that do not support breakpoints ignore the hint and get the same concatenated text as today. The main agent
sends no hint and its payload does not change.

Staggered start is a separate opt-in setting, `subagent.staggerStart` (default false): when several children with the
same cache key are started together, the first runs alone until its first request has started, then the rest follow, so
they read the prefix the first one wrote.

Background-result messages need no change (E4: the note is appended, the cache prefix is untouched).

## User Stories

1. As an owner running several agent types in one repo, I want the second type to read the project context from cache, so
   that fan-out over types costs close to one project-context write.
2. As an owner whose agents keep memory, I want a memory edit to invalidate only the tail, so that the next run does not
   rewrite the project context.
3. As an owner using worktree isolation, I want the worktree child to share the head with the main checkout's children,
   so that isolation does not cost a cold cache.
4. As an owner, I want the date and cwd in the tail, so that a day rollover does not invalidate the project context.
5. As an owner who fans out many siblings of one type with a large prefix, I want an opt-in stagger, so that siblings 2..N
   read what sibling 1 wrote; and I want it off by default, because it costs 2-3 s wall time.
6. As an owner on an OAuth login (Claude subscription) and on an API key, I want the layout to work on both, within
   Anthropic's limit of 4 cache breakpoints per request.
7. As a user of the main agent, I want my prompt, cache behaviour and `/` output unchanged, so that nothing regresses
   outside subagents.
8. As a user of OpenAI, Google or other providers, I want the same system text as today, so that nothing changes for me.
9. As a developer, I want to see the breakpoint positions in an offline test, so that a refactor of the prompt builder
   cannot silently remove sharing.
10. As the owner, I want a by-hand real-model check that reproduces the E1, E2 and E3 numbers with nonces, so that the
    claimed savings are re-measurable.
11. As a reader of `docs/subagent.md`, I want a "Prompt caching" section that says what is shared, what is not, and what the
    one setting does.
12. As the owner, I want no behaviour change in answer quality that I did not choose: the tail text keeps the same content,
    only its position changes, and the position change gets one eval pass.

## Implementation Decisions

1. Generic API in `xpi-ai` (`packages/xpi-ai/src/types.ts`). `SystemMessage` gets an optional
   `cacheBreakpoints?: string[]`: names of sections (`"preamble"` counts as a section; `"content"` for the base text if
   there are no sections) after which the provider may place a cache breakpoint. Text rendering
   (`getSystemMessageText`) is unchanged, so every provider that ignores the field gets the identical concatenated
   prompt. Rejected: a marker string inside the text (the prototype): it leaks into the prompt for providers that do
   not strip it, and it is invisible to types and tests.
2. Anthropic provider (`anthropic-messages.ts`, `buildParams`): split the leading system message into one text block per
   region, each region ending at a named section; `cache_control` on the last block of each region. Block texts
   concatenated equal today's single block (same separator). Only the leading system message is split; later
   mid-conversation system messages keep today's handling.
3. Breakpoint budget (Anthropic allows 4 per request). Candidates, in priority order: last conversation message, last tool,
   system tail, system head, OAuth identity block. Rule: take candidates in priority order until 4 are used. With
   an API key that is last message + tools + tail + head = 4 and nothing is dropped. With OAuth the identity block is the
   fifth and loses its breakpoint (the head breakpoint already caches identity + head, since the identity block is first
   in the prefix; the prototype did this and E1/E2 showed the sharing). With three or more hints the lowest-priority
   (earliest) ones are dropped, never silently exceeding 4. `cacheRetention: "none"` sends no breakpoints, as today;
   `"long"` applies one TTL to all breakpoints (mixed TTLs have an ordering rule we avoid by using one).
4. Coding-agent side. A generic prompt option, not a subagent special case: `BuildSystemPromptOptions.tail?: string`
   (CLI: `--system-prompt-tail <file>`; SDK: same option name). When present: a section `tail` (tag `<tail>`... name
   decided in the ticket) is added as the last section, `cwd` moves into the tail region (after the breakpoint), and
   `cacheBreakpoints` is `["project_context"-or-last-head-section, "tail"]`. When absent, the section order, text and
   hints are exactly as today. The section order for the head is today's: preamble, addendum, project_context, skills
   (pi's discovered skills), custom sections.
5. Subagent side (`resolve.ts`): `--system-prompt` carries only the shared head preamble (the codemode hint, or a fixed
   one-line role when codemode is off); the agent body, `# Skill:` blocks, memory and `# Environment` go into the tail
   file passed with `--system-prompt-tail`, in today's order. The rpc child, session files and the `systemPrompt` field in
   `ChildSpec` keep working: `ChildSpec.systemPrompt` becomes `{ head, tail }`.
6. Path rendering (`renderProjectContext`): a path is rendered relative to the context file's project root when it lies
   inside the session cwd or its worktree origin; files outside (e.g. `~/.pi/agent/AGENTS.md`) render as `~/...`. No
   absolute path from the project may remain in the head. This changes the main agent's `<project_instructions path=...>`
   text too (a visible, accepted change: the main agent also gets worktree-independent text); flagged in Open
   questions. Rejected: file-name-only (the prototype): two files named `AGENTS.md` (global and project) would be
   indistinguishable.
7. The tool block comes before the system prompt in Anthropic's prefix, so cross-type sharing still requires the same tool
   set (E1: type D with other tools shared only its tools block). Not changed here; children with `tools:` lists keep their
   own prefix. This is stated in the docs.
8. Stagger (`subagent.staggerStart`, default false; `config.ts` boolean boundary check like `backgroundScripts`). In
   `exchange.ts`, after the concurrency slot is taken, a per-key gate: key = model + the `--tools` / `--exclude-tools`
   args + head preamble + cwd-independent project root. The first child with a key opens the gate when it signals that
   its first request has started streaming (the earliest rpc event the experiment can observe; E3 used the first assistant
   event, 1.7-2.8 s after start), or after a timeout of 5 s, whichever comes first; later children with the same key wait at
   the gate. A different key never waits. The gate is process-wide like the semaphore, and honours abort/stop like a slot
   wait. No threshold setting (see Open questions).
9. Main agent unaffected: no `tail` option, so no hints, no section moves. The only main-visible change is decision 6
   (relative context-file paths). Verified by a payload snapshot that is byte-identical to main's today except for that
   one path.
10. Non-Anthropic providers: `cacheBreakpoints` is ignored; `getSystemMessageText` output equals today's text with the
    sections in the new order for children only. Providers with their own caching (OpenAI automatic prefix caching) benefit
    from the stable-head ordering for free.

## Testing Decisions

- Offline, free, in CI (`packages/xpi-ai/test`, vitest like the other `anthropic-*.test.ts`): request payload snapshots built
  with `buildParams` (or the existing `onPayload` seam) for the matrix {API key, OAuth} x {no hint, head+tail hint,
  hint + `cacheRetention: "none"`, hint + `"long"`}. Assertions on structure: block count, texts concatenate to the
  unsplit text, `cache_control` positions, total breakpoints <= 4, identity block keeps no breakpoint only when over
  budget. A non-Anthropic provider test: the same system message gives the same text with and without hints.
- Offline, coding-agent (`test/suite` faux provider and `test:subagent`): system prompt sections for a child spec: head
  equal across two agent types and across main checkout vs worktree (same AGENTS.md text, different absolute path), tail
  differs and contains cwd/date/memory; main agent prompt unchanged (golden compare apart from the context-path line);
  `readConfig` accepts `staggerStart` booleans and throws naming the key otherwise; stagger gate unit test with a fake
  clock: leader opens on first-request signal, on timeout, on abort; different key never waits; default off changes
  nothing.
- Real, by hand, never in CI, Claude Haiku 5.5 only, temp `XPI_CODING_AGENT_DIR` with a copy of the auth file and a temp
  HOME (as in `AGENTS.md`). The experiment harness (`exp-cache:.scratch/xin-pi/exp/`) is re-created as a `test/subagent/cache/`
  script run by `npm run test:subagent:cache`: nonce on the first line of AGENTS.md per repetition, then E1 (4 agent types:
  cacheRead on types 2-4 is at least 80% of the head), E2 (main checkout, worktree, memory edit), E3 (3 siblings parallel vs
  staggered). Asserts on token ratios from the child session files (`usage.cacheRead/cacheWrite`), with a wide tolerance
  (the first request of a run also reads a constant tools block). Run once with an OAuth login and once with an API key
  (`ANTHROPIC_API_KEY` from the owner); the report lists both. Not run for the main agent beyond one regression request.
- Prior art: `anthropic-cache-write-1h-cost.test.ts`, `anthropic-oauth.test.ts`, and the E0-E4 harness.
- No test starts a test runner (past fork bomb).

## Out of Scope

- Any change to the main agent's prompt layout beyond the relative path rendering.
- Sharing across different tool sets or across `omitClaudeMd` agents (nothing big to share).
- 1-hour cache retention policy for subagents; the 5-minute default is used (not measured).
- A tokenizer-based estimate of when stagger pays off; the setting is opt-in and the docs give the rule of thumb (prefix
  above about 8k tokens, 3+ siblings, expensive model).
- Background result messages (E4: no change).
- OpenAI/Gemini explicit cache APIs.

## Further Notes

- The experiment found no minimum cacheable length on haiku 5.5 down to about 630 tokens; the head is always large enough
  when it holds a project context, but a project without AGENTS.md has a small head (the codemode hint) and gains little.
  Expected, not a bug.
- Prototype gotcha worth repeating in the ticket: a worktree resolved `xpi-ai` through the main checkout's `node_modules`
  symlinks, so a first run silently used an unmodified provider. Real runs must confirm the payload dump shows 2 system
  blocks (ticket 1 adds a permanent opt-in debug hook through `onPayload`, not an env var in the provider).
- Quality risk: the agent body moves from the top of the prompt to after the project context. Models weigh early text
  more; ticket 2 runs the existing subagent evals (haiku, 17 cases) before and after.
- Date in the tail: a day rollover is only an expected invalidation of the tail now; it was not forced in E2.

## Resolved questions

Answered by the owner on 2026-11-09: every recommendation below is accepted as the decision.

1. Generic API or subagent-only? Decided: generic and small (`cacheBreakpoints` on `SystemMessage`, decision 1).
   A subagent-only hack would need a marker in the text or a provider fork; the generic form costs about the same code, is
   testable by type, and lets the main agent use it later (for example project context vs volatile `cwd`).
2. Relative path rendering changes the main agent's prompt text. Decided: accept, because main also benefits when
   it runs in worktrees and the path is still unique (`AGENTS.md` vs `~/.pi/agent/AGENTS.md`). Alternative: render the
   relative form only when `tail` is set, which keeps main byte-identical; costs one branch. Decide in review.
3. pi's own `<skills>` section lists skill files with absolute paths; project-level skills in a worktree differ. Decided:
   keep it in the head, and let ticket 2's payload comparison (main checkout vs worktree) decide; if it differs, put skills
   with the worktree-dependent paths in the tail.
4. Stagger threshold (minimum siblings, minimum prefix size). Decided: none; boolean only. N >= 2 is the
   only case where it can matter, and the docs state when to enable it. Add `staggerMinSiblings` only if the owner
   finds the 2-3 s cost bites for pairs.
5. Stagger release signal. Decided: release on the earliest rpc event showing the first request has started
   streaming, with a 5 s timeout; ticket 3 checks which event exists and falls back to the first assistant event
   (E3's measured +1.8-3.1 s) if none does.
