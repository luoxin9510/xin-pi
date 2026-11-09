# 03: Opt-in staggered start of sibling subagents (`subagent.staggerStart`)

**What to build:** `subagent.staggerStart: boolean`, default false, in `config.ts` (boundary check naming the key). In `exchange.ts` a process-wide per-key gate: the first child with a given key (model + tool args + head preamble + project root) runs alone until its first request has started streaming, or 5 s pass; later same-key children wait, honouring abort/stop. Different keys never wait. Look in the rpc event stream for an event earlier than the first assistant event; fall back to that event if none exists.

**Blocked by:** 02 (the key uses the head layout; stagger without a shared head still helps same-type siblings, so it can start in parallel if needed)

**Status:** needs-owner-approval (spec `../spec.md`)

- [ ] Failing `node:test` first (fake child, fake clock): leader opens the gate on the signal, on the timeout, and on abort; different key does not wait; default off behaves exactly as today; stop on a waiting sibling cancels it
- [ ] `readConfig` tests: true/false accepted, anything else throws `subagent.staggerStart must be true or false`
- [ ] Open question 5 answered (which rpc event) and recorded in Comments
- [ ] Real, by hand, Claude Haiku 5.5, nonce: E3 (3 siblings, prefix about 4.3k and about 9.8k tokens), parallel vs staggered; expect about -36% and -52% cost and +2-3 s wall; with OAuth and with an API key
- [ ] `npm run check` green

## Comments
