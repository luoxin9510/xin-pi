# Agent teams: decisions

The owner's answers to each grill, recorded with the recommendation they accepted. The spec is `01-agent-teams.md`.

## Grill 1 (2026-11-12)

The owner opened the spec ("可以开agents teams spec"). The owner also set a docs requirement: the docs must explain
clearly how to port xpi's features, organised so a user can pick parts for their own harness, with Linux as the
reference. The owner accepted all four recommendations ("好的可以开始吧").

1. **Where teammates run.** On the subagent system, in the lead's TUI, as Claude Code's default in-process mode does.
   Teammates as roost background sessions (like Claude's split panes) are left to a later spec.
2. **Turning it on.** Off by default and experimental. It is turned on by the `agentTeams` setting or by
   `XPI_EXPERIMENTAL_AGENT_TEAMS=1`, and only in interactive mode. With it off, named subagents behave exactly as today.
3. **pi-roost's cross-session collaboration** (`roost_send`, `roost_spawn`, watches, its task board) is not ported.
   It stays in roost's "Left out" list, with the reason that teams live inside one session as Claude Code's do.
4. **Porting guide.** There is one entry page, a component menu read like kernel configuration options, with Linux
   first. The existing guides fit its shape. The menu was done in its own PR first (#81). Agent teams get their entry
   when they are built. AGENTS.md carries the rule for every new feature.

## Grill 2 (2026-11-12)

The owner accepted all eight recommendations ("是").

5. **Team shape.** Teams follow Claude Code:
   - With teams on, an `Agent` call with `name` starts a teammate; a fork or an `isolation` call does not.
   - The team is implicit, named `session-<8>`.
   - The lead is fixed, and there is one team per session.
   - Teammates get no `Agent`.
6. **Teammates' tools.** Teammates always get `SendMessage` and the four Task tools, whatever their agent file says,
   with `codemode` exposure. The lead's `SendMessage` reaches teammates. Teammates reach `lead` and each other.
7. **Messages.** Messages go through files: `config.json` plus a mailbox per member. A send counts once it is written,
   and the reader validates the entries. The lead delivers: a steer to a running teammate, a new turn for an idle one.
   Idle notices carry the final answer or the error. The envelope says the message has no user authority. There is no
   broadcast. Files were preferred over an in-memory relay because they can be inspected and a roost-backed mode can
   reuse them later.
8. **Task list.** It follows Claude Code's semantics: `pending`, `in_progress` and `completed`, `blockedBy`, an owner,
   and file locks. It is stored in `<agent dir>/tasks/<team>/`, kept after the session, and cleaned up by age.
   Self-claiming is prompt guidance.
9. **UI.** It reuses the subagent panel and the full-screen subagent screen. Typing on the screen messages the
   teammate, Esc interrupts its turn, and `x` stops it. The task list opens with `/tasks` and a configurable
   `app.team.tasks` key with no default, because `Ctrl+T` is the thinking toggle.
10. **End and resume.** Shutdown is by request (approve or reject). At session end the config and the inboxes are
    removed and the tasks are kept. `/resume` does not restore teammates.
11. **Model, trust, hooks.**
    - Model: xpi's subagent rule (`subagent.defaultModel`, default haiku), not Claude's "follow the lead".
    - Trust: the lead's decision. There are no permission prompts.
    - Hooks: `teammate_idle`, `task_created` and `task_completed` are extension events that can block with feedback.
12. **Testing.** Offline tests with a fake model, and a real Haiku check before the last merge. The porting entry
    goes in the same PRs.

## Grill 3 (2026-11-12)

The owner accepted all four recommendations ("好的可以的").

13. A teammate call returns at once, like `run_in_background`.
14. The setting is `"agentTeams": { "enabled", "maxTeammates": 8, "taskRetentionDays": 30 }`, and
    `"agentTeams": true` is short for it. At most 8 teammates run at once.
15. Teammates get a roster and task-list instructions in their prompt. The lead gets a short team section. Both are
    added only with teams on.
16. Four PRs: core, tasks, UI, wrap-up. The spec lives in `.scratch/agent-teams/`.

## Grill 4 (2026-11-12)

An independent Opus review of the first draft found that some decisions could not be built as worded. The owner
accepted all nine recommendations ("好的可以").

17. **Team name (changes 5).** On disk the team is `session-<full session id>`; the UI shows the first 8. Session ids
    are uuidv7, whose first 8 hex characters are the time and repeat for about a minute, so two sessions started in
    the same minute would share a team.
18. **In-memory sessions.** With `--no-session` teams are off, as fork is, because nothing there can be continued.
    "Interactive" means `ctx.mode === "tui"`, because `hasUI` is true in rpc mode too.
19. **Teammate tools (extends 6).** In the teammate's process the five tools have codemode exposure when the child
    has codemode, and are direct tools when it has none. They are always added to an explicit `--tools` list and
    never excluded.
20. **When the setting is read (changes 2 and 14).**
    - At session start and on `/reload`, because the lead's tools are registered then and cannot be unregistered.
    - `XPI_EXPERIMENTAL_AGENT_TEAMS` only turns teams on.
    - `maxTeammates` counts members that are not stopped (running, queued, idle), so waking idle ones cannot exceed
      it.
21. **Loop cap.** A teammate woken 5 times in a row by other teammates' messages, with no lead or user message in
    between, is not woken again. The messages wait, and the lead is told.
22. **Esc and `x` (details 9).** Esc on a teammate's screen interrupts its turn without stopping it; a second Esc
    closes the screen. `x` stops a teammate in any state, idle included. Teammate rows that are not stopped never
    hide from the panel.
23. **Old names after `/resume` (details 10).** The team is not restored automatically. The round 2 review proposed,
    with the spec for the owner's approval, extending this to `/reload` and a crash, which also end the team. An `Agent` call or a
    `SendMessage` with an old teammate's name continues it as a member of the new team, with its history. Its tasks
    stay its own.
24. **Workflows.** A named `Agent` call from a workflow or workflow script is refused while teams are on.
    - The reason given in Grill 4 was that a relaunch answers calls from saved results. The round 2 review found
      this holds only for foreground calls.
    - Corrected reason: a teammate outlives the script and reports to the lead, not to the script, so a script
      cannot use its result. Refusing keeps workflows deterministic.
    - Proposed with the spec for the owner's approval.
25. **Async hooks (details 11).** Besides `block(feedback)`, a handler may `hold(promise)` for an async decision,
    awaited up to 5 minutes. On a timeout the step is allowed and a warning is logged.
