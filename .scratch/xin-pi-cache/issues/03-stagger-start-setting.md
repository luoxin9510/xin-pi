# 03: Opt-in staggered start of sibling subagents (`subagent.staggerStart`)

**What to build:** `subagent.staggerStart: boolean`, default false, in `config.ts` (boundary check naming the key). In `exchange.ts` a process-wide per-key gate: the first child with a given key (model + tool args + head preamble + project root) runs alone until its first request has started streaming, or 5 s pass; later same-key children wait, honouring abort/stop. Different keys never wait. Look in the rpc event stream for an event earlier than the first assistant event; fall back to that event if none exists.

**Blocked by:** 02 (the key uses the head layout; stagger without a shared head still helps same-type siblings, so it can start in parallel if needed)

**Status:** done (2026-11-10)

- [x] Failing `node:test` first (fake child, fake clock): leader opens the gate on the signal, on the timeout, and on abort; different key does not wait; default off behaves exactly as today; stop on a waiting sibling cancels it
- [x] `readConfig` tests: true/false accepted, anything else throws `subagent.staggerStart must be true or false`
- [x] Open question 5 answered (which rpc event) and recorded in Comments
- [x] Real, by hand, Claude Haiku 5.5, nonce: E3 (3 siblings, prefix about 4.3k and about 9.8k tokens), parallel vs staggered; expect about -36% and -52% cost and +2-3 s wall; with OAuth (no API key was available: not measured with one)
- [x] `npm run check` green

## Comments

2026-11-10: done.

**Open question 5 (which rpc event).** `message_start` with `message.role === "assistant"`. The Anthropic provider
pushes its `start` event once the HTTP response has arrived (`xpi-ai/src/api/anthropic-messages.ts`, right after
`onResponse`), the agent loop turns it into `message_start` (`xpi-agent-core/src/agent-loop.ts`), and rpc mode prints
every event. It comes before the first token, so it is earlier than the `message_end` the experiment used. Measured:
followers released on it read 94% and 97% of the leader's prompt, so the entry is readable by then. No fallback to
`message_update` was needed.

**What was built.**

- `subagent.staggerStart` (boolean, default false) in `config.ts`.
- `stagger.ts`: `stagger(key, signal)` and `responded(key)`. The first child with a key gets the gate and leads; later
  ones wait for a response to that key, the 5 s timeout, or the leader's end. Abort rejects `aborted`, like a slot wait.
- `ChildSpec.prefixKey` (`resolve.ts`): model, the `--tools` / `--exclude-tools` args, the `--no-context-files` flag,
  the head preamble, and the git root of the parent's cwd (so a worktree child has the key of its siblings).
- `exchange.ts`: the wait comes right after the slot and before the worktree and the registry record, so a sibling
  stopped while it waits leaves nothing behind (same path as a stop during a slot wait). The leader's gate opens in
  `finally`.

**Two things beyond the spec text** (decision 8), both small:

1. Any child's response opens the gate of its key, not only the leader's. A follower released by the timeout that gets
   its response first has cached the prefix just as well.
2. After a response the key counts as cached for 4 minutes (`WARM_MS`; the provider keeps an entry 5 minutes after its
   last use). In that time nobody leads or waits. Without this, every later batch would pay the wait again for nothing:
   the measured second batch reads 100% and takes as long as an unstaggered one. If the entry is gone after all (the
   project context changed), that one batch writes in parallel, as without the setting.

The 5 s start when the leader takes the gate, so they include its worktree creation and process start. This keeps the
bound simple: no follower waits longer than 5 s, whatever the leader does.

**Measured** (`npm run test:subagent:cache -- --only stagger`, Haiku 5.5, OAuth, three agent types with the same tools
started at the same moment, fresh repository per batch, tools block warmed first for both sides):

| prefix | at once | staggered | cost | wall | second batch |
|---|---|---|---|---|---|
| 4278 tokens | 3 x write 2257, $0.00091, 2.8 s | 1 x write 2250, 2 x read 4003, $0.00046, 4.8 s | -50% | +1.9 s | 3 x read 4274, $0.00014, 2.0 s |
| 9814 tokens | 3 x write 7796, $0.00299, 2.3 s | 1 x write 7786, 2 x read 9539, $0.00126, 4.6 s | -58% | +2.3 s | 3 x read 9810, $0.00030, 2.9 s |

Better than the expected -36% / -52%: with ticket 02 the followers of another agent type write only their tail (about
270 tokens). With cold tools (first batch of a process) the saving was larger still (-76% at 3.0k tokens), because
the tools are then written three times as well.

**Tests.** `test/subagent/faults/stagger.test.ts`: 7 gate tests on a fake clock (signal, timeout, leader's end, other
key, abort, warm time, late leader), the `readConfig` test, 5 wiring tests with the fake child (off, on, other tool
set, leader ends without a response, stop of a waiting sibling by signal and by `registry.stopAll`). The fake child
got `logFile` and `hold` so the order of events across siblings does not depend on process start speed. Mutation
check: with the signal disabled the "on" test fails, with the gate forced on the "off" test fails.
