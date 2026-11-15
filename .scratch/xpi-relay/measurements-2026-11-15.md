# Measurements for step 2 (2026-11-15)

`npm run eval:delegation -- --long --arms relay`, the lead on Opus 5.5 and the worker on Haiku 5.5, the build of main
at fe201799e. One run per task, so differences of 10 to 20 percent mean nothing; the differences below are 50 percent
and more. Both rounds together cost $6.00.

## Round 1: eight long tasks, settings as shipped

All eight pass. Total $4.59 in 3,752 s.

| | Cost | Share |
|---|---|---|
| Lead (Opus) | $1.33 | 29% |
| Worker (Haiku) | $3.25 | 71% |
| Worker requests with more than 100,000 prompt tokens (203 of 345) | $3.00 | 92% of the worker's cost |

Haiku 5.5 costs five times as much per token above 100,000 prompt tokens. No compaction happened in any worker
phase. Per task (from the session files):

| Task | Lead context at the handover | Worker phase | Worker requests above 100k / all | Worker cost below / above 100k | Worker peak context |
|---|---|---|---|---|---|
| fork agent type | 11,161 | 496 s | 38 / 55 | $0.03 / $0.45 | 179,879 |
| workflows | 10,969 | 996 s | 73 / 90 | $0.03 / $1.28 | 294,308 |
| relaunch and pause | 11,759 | 709 s | 56 / 70 | $0.03 / $0.94 | 263,795 |
| agent file fields | 11,158 | 387 s | 25 / 49 | $0.04 / $0.21 | 134,558 |
| structured output | 10,972 | 295 s | 8 / 31 | $0.04 / $0.08 | 128,886 |
| names and SendMessage | 10,970 | 279 s | 3 / 21 | $0.04 / $0.03 | 104,532 |
| audit three packages | 7,255 | 109 s | 0 / 21 | $0.02 / $0.00 | 47,833 |
| three libraries from specs | 6,929 | 126 s | 0 / 8 | $0.02 / $0.00 | 46,824 |

The lead:

- It hands over after one or two requests; its context at the handover is the system prompt and the task, 7,000 to
  12,000 tokens. After the hand back it re-reads 0 to 1,700 tokens. So appending the record to the lead's
  conversation instead of replacing the conversation would change nothing on these tasks.
- The first request after a hand back writes 8,000 to 19,000 tokens to the cache (the record): $0.04 to $0.065 per
  task, 30 to 40 percent of the lead's cost.
- In the four tasks whose worker phase is longer than five minutes, about 6,000 tokens of the lead's prefix have
  expired and are written again: about $0.03 each, 9 percent of the lead's cost.
- No stall and no wrong-role call in these runs or in round 2.

## Round 2: the worker's context limited to 95,000 tokens

The three most expensive tasks again, with `compaction.modelOverrides["relay/auto"].reserveTokens` = 905000 (the
override is looked up by the selected model, so the worker alone cannot be limited today; the lead never comes near
the limit).

| Task | No limit | Limit 95,000 | Compactions | Result |
|---|---|---|---|---|
| fork agent type | $0.71, 590 s | $0.33, 523 s | 2 | passes, 53% cheaper |
| relaunch and pause | $1.16, 778 s | $0.42, 1,165 s | 6 | passes, 64% cheaper, 50% slower |
| workflows (2,600 lines) | $1.47, 1,014 s, passes | $0.66, 2,700 s | 6 in round 1, 10 in round 2 | times out |

In the failing task a compaction happened every two to three minutes: each keeps the latest 20,000 tokens and a
summary, the worker reads its way back to the limit, and it does not finish. Under a virtual model a threshold
compaction always writes a summary, even when pruning old tool output would have been enough.
