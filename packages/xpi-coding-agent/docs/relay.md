# Relay

Relay is a [virtual model](virtual-models.md), `relay/auto`, that runs one conversation on two models. A strong model,
the **lead**, explores, decides the plan and reviews the result. A cheap model, the **worker**, carries the plan out.
The lead's tokens go to judgement; file reads, test output and mechanical edits go to the worker.

```
xpi --model relay/auto
```

or `/model relay/auto` in a session. The footer shows which model answers. The built-in `relay` extension provides it;
`-builtin:relay` in `extensions` turns it off.

## How a task runs

```
lead explores → handover(plan, acceptance, findings)
             → worker builds
             → acceptance commands run; on failure their output goes back to the worker
             → the conversation is compacted to a hand-back record
             → lead reads the record → answers / fixes a small thing / hands over again
```

1. **The lead explores and plans.** It reads what the decision depends on. For a task of a few edits it does the work
   itself and nothing below happens.
2. **Handover.** The lead calls the `handover` tool. From the next request on the worker answers. It reads the whole
   conversation, once and uncached, so nothing is lost in a brief.
3. **The worker builds** and calls `handback` with a report, or simply stops.
4. **Acceptance.** xpi runs the handover's acceptance commands in the session's directory. If one fails, the output goes
   back to the worker and it continues, at most `maxRounds` times. A worker that hands back `blocked` skips this step.
5. **Hand back.** The conversation is compacted to the hand-back record, and the lead is asked to review. Nothing of the
   worker's transcript (the files it read, its failed attempts, its test runs) reaches the lead.

A user message during a worker phase goes to the worker: you are talking to the model that is doing the work. Use
`/handback` to reach the lead.

## The two tools

Both are in the tool list only while `relay/auto` is selected, and for both models, so a phase change does not change
the tool list. Each refuses the wrong caller.

**`handover`** (lead)

| Field | Meaning |
|---|---|
| `plan` | The steps, in order, specific enough to follow without the lead. |
| `acceptance` | Shell commands that must exit 0 when the work is done (tests, a type check, a grep). Optional. |
| `criteria` | What done means beyond the commands. The lead reviews the result against it. |
| `findings` | What the lead learned and must not lose: the files involved, constraints, traps. |
| `stopWhen` | When the worker must stop and hand back instead of pushing on. |

**`handback`** (worker): `status` (`done` or `blocked`) and `report`. A worker run that ends without the call counts as
done, with its last message as the report.

The acceptance commands are written by the model and run without asking, like the model's own `bash` calls.

## The hand-back record

The record replaces the conversation. It holds, in this order:

- the summary of an earlier ordinary compaction, if there was one;
- the user's messages and the lead's replies, as written, without tool activity (when they exceed 40,000 characters,
  the oldest lead replies are dropped first; the user's messages stay);
- one line per earlier round;
- the lead's handover note, word for word;
- the worker's report;
- the changes since the handover: `git diff --stat`, files git does not track, and the diff up to `diffChars`
  characters (beyond that the lead is told how to read the rest). Outside a git repository this part is empty;
- each acceptance command with its exit status and the end of its output.

The lead's own judgement is kept in its own words; the worker summarizes only its own work; the rest is output of
commands.

## What the lead pays for

| Step | Lead tokens |
|---|---|
| Exploring and planning | Its own reading and thinking. Wide searches can go to cheap scouts with the [`Agent`](subagent.md) tool. |
| `handover` | The note it writes. |
| Worker phase, acceptance rounds | None. |
| Hand back | The system prompt and tools from the prompt cache while it lasts (5 minutes by default), plus a cache write of the record. |

After a hand back every later lead request reads the record, not the conversation it replaced.

Measured on a small task (three functions, one acceptance command; Opus 5.5 as lead, Haiku 5.5 as worker): the lead's
request after the hand back read 3,093 tokens from the cache and wrote 1,086, the record. `/session` lists the cost of
each model.

## Commands

| Command | Description |
|---|---|
| `/handover [instructions]` | Give the work to the worker now, without a plan from the lead. |
| `/handback` | Wake the lead now: the worker is told to stop and report, and the acceptance commands are not run. |
| `/relay` | Show who has the work, the round and the two models. |

## Settings

```json
{
  "relay": {
    "lead": "anthropic/claude-opus-5-5",
    "worker": "anthropic/claude-haiku-5-5",
    "leadThinking": { "plan": "high", "review": "medium" },
    "workerThinking": "medium",
    "maxRounds": 3,
    "acceptanceTimeoutMs": 600000,
    "diffChars": 20000
  }
}
```

| Key | Default | Meaning |
|---|---|---|
| `lead` | `anthropic/claude-opus-5-5` | The model that explores, plans and reviews, as `provider/model`. |
| `worker` | `anthropic/claude-haiku-5-5` | The model that builds. It also writes the summary of an ordinary compaction. |
| `leadThinking.plan` | `high` | The lead's thinking level before the first handover. |
| `leadThinking.review` | `medium` | The lead's thinking level after a hand back. |
| `workerThinking` | `medium` | The worker's thinking level. |
| `maxRounds` | `3` | Times failed acceptance commands go back to the worker before the lead is woken regardless. `0`: never. |
| `acceptanceTimeoutMs` | `600000` | Time limit of one acceptance command. |
| `diffChars` | `20000` | How much of the diff goes into the record. `0`: the stat only. |

The values are read at each request, so a change applies to the next one. A wrong value ends the request with an
error that names the key. The thinking level selected for `relay/auto` itself is not used.

## Limits

- One worker at a time. The lead can start parallel agents with the `Agent` tool.
- The phase is router state on the session branch: a fork or a `/tree` jump sees the phase of its own branch.
- Esc during a worker phase leaves the work with the worker. The next message goes to it; `/handback` wakes the lead.
- A worker run that ends in a provider error is not handed back. Send a message to let the worker continue.
- Subagents do not get the relay model or its tools.
- Tests: `test/suite/relay.test.ts` (faux provider), `npm run test:relay:real` (real models; both roles are Haiku
  unless `RELAY_TEST_LEAD` names another model).
