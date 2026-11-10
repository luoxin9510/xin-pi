# 07: Relaunch with saved results, pause and resume

Spec: `../07-relaunch-and-pause.md`. Branch `subagent-relaunch-pause`.

**Status:** built and tested offline (2026-11-10); the real-model checks are written and NOT yet run

- [x] T1 Run files (`runs.ts`): every run of a saved workflow records its `Agent` calls in call order with what each
      asked and returned, in `subagents/<session id>/runs/R<n>.json` (in memory for an in-memory session); the run id
      is on the script row, in the start text and in the end message
- [x] T2 Relaunch: the `Agent` tool answers a call from the relaunched run's saved results while every earlier call
      was answered and it asks the same thing and completed; `/workflows` (Enter on a run) and
      `Workflow({ name, relaunch })`; refusals; a rerun call takes over a name its earlier agent holds; the end message
      of a stopped or failed run says how to relaunch
- [x] T3 Pause and resume (`background.ts`): `p` on a script row, and from `/workflows`; a paused script's `Agent`
      calls wait in order; a stop or the script's end releases them with an error
- [x] Offline: `relaunch.test.ts` (7), `pause.test.ts` (4)
- [ ] Real, haiku: `real/22-relaunch.test.ts` (a run stopped while its third agent works; the relaunch answers the
      first two from saved results and runs the third); pty: pause and resume in a real terminal
      (`tui/12-workflows.test.ts`). Both are written and have not run: the owner's Anthropic OAuth token expired during
      the work, and a copy of an expired token must not be used (it would log the owner's own xpi out). The full haiku
      regression (real, parent, tui, evals) is owed for the same reason.
- [x] Docs: `docs/subagent.md` (Runs, saved results and relaunch; Pause and resume; panel keys; `/workflows`),
      `docs/slash-commands.md`, `docs/subagent-porting.md`, both READMEs

## Comments

2026-11-10: **`/workflows` has no `p` key.** The spec said `p` works there too; the list is pi's `select` dialog, which
takes no extra keys. Enter on a run that is going opens a second list: its agents, Pause or Resume, Stop.

**A run whose script completed can still be relaunched when a call did not.** Since spec 06 `agent()` gives `null`
for a failed agent, so a script can finish "completed" with failed agents in it. The refusal "completed: nothing to
relaunch" applies only when every compared call completed.

**The name takeover had to clear the claim too.** A name is held by the agent's record and by the claim it started
under; dropping only the record's name left the claim, and the rerun call still failed on "name already used".

2026-11-10, from the repo audit: **the run file is no longer rewritten for every call.** It holds every result, and it
was written whole twice per `Agent` call: 2,000 writes of a growing file for a run of 1,000 agents. Changes within
250 ms now go out together; the run's start and end are written at once. A process killed in between loses at most
that much of the record, and a relaunch runs those calls again.
