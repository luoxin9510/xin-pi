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
compaction always writes a summary after pruning; whether pruning alone would have been enough in these runs was not
measured.

## Round 3: the worker's limit as shipped (after the limit and the stuck guard)

The build of the branch `relay-worker-context` at 9afaf5dcb, default settings (`workerContext.limit: "tier"`, 95,000
tokens for Haiku 5.5; four summaries, then the limit is lifted). Two runs per task, $2.95 together.

| Task | No limit (1 run) | Default limit (mean of 2) | The two runs | Limit summaries | Guard |
|---|---|---|---|---|---|
| fork agent type | $0.71, 590 s | $0.34, 598 s | $0.28 and $0.39 | 2 and 3 | not reached |
| relaunch and pause | $1.16, 778 s | $0.53, 1,208 s | $0.37 and $0.69 | 4 and 4 | lifted in both |
| workflows (2,600 lines) | $1.47, 1,014 s | $0.61, 1,433 s | $0.52 and $0.70 | 4 and 6, over 3 and 4 rounds | not reached |

- All six runs pass; `workflows` does not time out. The cost is 53, 54 and 58 percent lower, and the last two tasks
  take 40 to 55 percent longer.
- In `workflows` the lead split the work itself, into three and four handovers; no worker round passed 100,000
  tokens. With one handover (the two `diffChars` runs below) the guard lifts the limit, the worker grows to 228,000
  and 278,000 tokens and the run costs $1.12 and $1.27: 14 to 24 percent below the unlimited run, not 58.
- In `relaunch and pause` the limit was lifted after four summaries in both runs. In one the worker stayed below the
  tier afterwards ($0.37); in the other it grew to 153,000 tokens with 35 requests above the tier ($0.69).
- In the seven runs where the limit was never lifted (four of these six and three of the `diffChars` runs), no
  request went above the tier: the worker's peak was 93,000 to 99,000 tokens against a tier of 100,000 and a limit of
  95,000, so the estimate's error stayed inside the headroom there.
- One of the two `fork agent type` runs was flagged by the eval for reading this checkout's source; it is the dearer
  of the two ($0.39), and the other costs $0.28.

## Round 4: the diff in the record

`relay.diffChars` at 5000 and 0, one run per task, $4.01 together; the runs at 20000 are round 3.

| Task | `diffChars` 20000 (the two runs above) | 5000 (1 run) | 0 (1 run) |
|---|---|---|---|
| fork agent type: lead after the hand backs | $0.15 in 5 requests, $0.20 in 9 | $0.12 in 3 | $0.11 in 3 |
| relaunch and pause | $0.17 in 5, $0.12 in 1 | $0.12 in 3 | $0.15 in 6 |
| workflows | $0.25 in 3, $0.29 in 4 | $0.09 in 1 | $0.11 in 4 |
| Whole run: fork / relaunch / workflows | $0.34 / $0.53 / $0.61 (means) | $0.27 / $0.73 / $1.12 | $0.28 / $0.33 / $1.27 |

All six pass. The lead's cost after the hand backs follows the number of rounds and requests, not the size of the
diff: the `workflows` runs at 5000 and 0 had one round where the runs at 20000 had three and four. One run per cell
cannot separate a saving of a few cents from that, and the whole-run cost is decided by whether the lead splits the
work. The default stays 20000.

Rounds 3 and 4 together cost $6.96.

## Round 5: the lead's prefix kept warm

The build of the branch `relay-warm-lead` at df7f42c84, default settings (`relay.warmLead: true`, the worker's limit
as in round 3). `relaunch and pause` and `workflows` twice each, $2.67 together. All four pass.

Measured with Opus 5.5 as the lead and Haiku 5.5 as the worker, on four runs of two long tasks (all pass):

| Worker phase | Refreshes | Their cost | The lead's first request after the hand back |
|---|---|---|---|
| 251 s | 0 | $0 | reads 10,827 tokens from the cache |
| 560 s, then 900 s (two rounds) | 2, then 3 | $0.0114 | reads 10,828 tokens from the cache, both times |
| 1,397 s | 5 | $0.0115 | reads 10,915 tokens from the cache |
| 1,414 s | 5 | $0.0115 | reads 10,914 tokens from the cache |

- Every refresh was a cache read of the prefix (10,800 to 11,000 tokens, $0.0022 each); the first one of a hold also
  writes the 73 tokens of its short message.
- After each worker phase longer than five minutes the lead's first request read the prefix from the cache (and wrote
  2,500 to 12,700 tokens after it: the record).
- What a refresh saves is what would have been written again without it. That was not measured side by side. The
  upper bound is the whole prefix, 10,900 tokens at the difference between the cache write and the cache read price
  of Opus 5.5: $0.052. The earlier runs without refreshes showed about 6,000 tokens written again after a long
  worker phase: $0.029. Five refreshes cost $0.011, so a hand back after 23 minutes keeps between $0.018 and $0.04.
- The lead's cost shows no difference at two runs per task: with the refreshes included it was $0.199 for `relaunch
  and pause` and $0.274 for `workflows`, against $0.20 and $0.34 without them, and the lead handed over fewer times
  in `workflows` this time (1.5 against 3.5 on average), so that pair is not comparable.

`warmLead` stays on by default: the refreshes are cache reads, the prefix is read from the cache after every long
worker phase, and the lead's cost with the refreshes shows no increase (the criterion of the spec; two runs per task
cannot show a saving of a few cents).

The worker's side in these runs, for the record of step 2:

| Task | Run | Cost | Handovers | Worker peak context | Limit |
|---|---|---|---|---|---|
| relaunch and pause | 1 | $0.84, 1,419 s | 1 | 194,493 (43 requests above the tier) | lifted after 4 summaries |
| relaunch and pause | 2 | $0.93, 1,492 s | 1 | 182,920 (48 requests above the tier) | lifted after 4 summaries |
| workflows | 1 | $0.20, 297 s | 1 | 93,469 | in force, 1 summary |
| workflows | 2 | $0.70, 1,636 s | 2 | 94,965 | lifted in round 1 after 4 summaries, 7 in all |

`relaunch and pause` cost $0.37 and $0.69 in round 3 and $0.84 and $0.93 here (mean worker peak 188,700 tokens, 45.5
requests above the tier on average): once the guard lifts the limit the worker grows as before. Over the four runs
the mean is $0.71, 39 percent below the unlimited run ($1.16), not the 54 percent of round 3 alone. Whether asking
the worker to hand back (`whenStuck: "handback"`) does better on this task is not measured.

## Round 6 (2026-11-17): asking the worker to hand back (`whenStuck: "handback"`)

The question round 5 left open. Opus 5.5 as the lead, Haiku 5.5 as the worker, the build of #133 (so the worker reads
the lead's work as a quote, which the earlier rounds did not have), `relay.workerContext.whenStuck: "handback"`,
`relaunch and pause` and `workflows` twice each, $2.75 together. All four pass.

| Task | Run | Cost | Time | Handovers | Guard |
|---|---|---|---|---|---|
| relaunch and pause | 1 | $0.58 | 1,522 s | 4 | asked in round 1 after 4 summaries |
| relaunch and pause | 2 | $0.78 | 1,546 s | 3 | asked in round 1 after 4 summaries |
| workflows | 1 | $0.72 | 1,740 s | 5 | asked in round 1 after 4 summaries |
| workflows | 2 | $0.67 | 1,763 s | 4 | asked in round 1 after 4 summaries |

In all four runs the worker handed back when asked, the lead split the rest into further handovers, and the limit was
never lifted: the worker's peak context stayed at about 94,000 tokens and no request was above the tier (with `"lift"`
the worker of `relaunch and pause` grew to 183,000 to 194,000 tokens in two of four runs).

Against the four `"lift"` runs of rounds 3 and 5:

| Task | `"lift"`, 4 runs | `"handback"`, 2 runs |
|---|---|---|
| relaunch and pause | $0.37, $0.69, $0.84, $0.93: mean $0.71 | $0.58, $0.78: mean $0.68 |
| workflows | $0.52, $0.70, $0.20, $0.70: mean $0.53 | $0.72, $0.67: mean $0.70 |

- `relaunch and pause`: the same cost within the spread (4 percent lower), and about as long as the slower `"lift"`
  runs. What the worker saves by staying under the tier, the lead spends on reading more records and writing more
  handovers ($0.42 of the $0.68 is the lead's).
- `workflows`: no saving; the mean is higher, though the `"lift"` mean includes one $0.20 run with a single handover.
- The spread of `"handback"` is narrower ($0.58 to $0.78 over both tasks, against $0.20 to $0.93).

Decision: the default stays `"lift"`. `"handback"` is not clearly cheaper and is not faster; it is the setting for a
user who wants the worker kept under its price tier and a steadier cost. Two runs per task cannot show more.
