# 01: Agent teams

Status: draft for the owner's approval (Grill 1–4 in `decisions.md`, 2026-11-12). It had two independent reviews:
round 1 led to Grill 4, and round 2 found no blocking issue; its should-fix items are applied.

## Problem

xpi has subagents. Main starts them, can name them and send them messages (`SendMessage`, spec 03 of
`.scratch/xin-pi-workflows/`), and gets their results back. It lacks three things:

- Subagents cannot talk to each other.
- The user cannot hand work to a group that coordinates itself.
- There is no shared list of work.

Claude Code's agent teams do this. A lead session starts named teammates that message each other and the lead, share
a task list, and can be talked to by the user directly. This spec brings that to xpi, inside one session, built on the
subagent system.

## What Claude Code does (the reference)

From https://code.claude.com/docs/en/agent-teams (read 2026-11-12):

- **Status.** Experimental, off by default (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`), interactive sessions only.
- **The team.**
  - A team is the lead (the session) plus teammates.
  - An `Agent` call with a `name` starts a teammate, unless it is a fork or passes `isolation`.
  - The team is implicit, named `session-` plus the first eight characters of the session id (a random v4 id there).
  - The lead is fixed, there is one team per session, and teammates cannot start teammates.
- **Teammates' tools and context.** Teammates get `SendMessage` and `TaskCreate`, `TaskGet`, `TaskList`, `TaskUpdate`
  whatever their definition's `tools` or `disallowedTools` say. They load the project's context like any session,
  not the lead's history.
- **Messages.**
  - Direct only, no broadcast.
  - Each agent has a mailbox file (`~/.claude/teams/{team}/inboxes/{name}.json`).
  - A send counts only once it is written. Entries are validated on read.
  - Delivery is automatic.
  - A teammate that stops notifies the lead with its final answer, or with the error when its turn ended on an API
    error.
  - Messages between agents carry no user authority.
- **Task list** (`~/.claude/tasks/{team}/`).
  - States `pending`, `in progress`, `completed`.
  - Dependencies: a task is blocked until they complete.
  - The lead can assign tasks; teammates self-claim the next unblocked one.
  - Claims use file locking. The list persists after the session.
- **Display.**
  - In-process: a panel under the prompt. ↑↓ select; Enter opens a teammate's transcript to read and message it; Esc
    there interrupts its turn; `x` stops it; `Ctrl+T` toggles the task list.
  - Split panes (tmux, iTerm2) are the other mode.
- **Shutdown.** The lead asks, and the teammate approves (exits) or rejects with a reason. At session end the team
  config is removed and the tasks are kept. `/resume` does not restore teammates.
- **Hooks.** `TeammateIdle`, `TaskCreated`, `TaskCompleted`, which are shell commands; exit code 2 blocks the step
  and sends feedback.

## Facts this builds on

Paths are under `packages/xpi-coding-agent/src/` unless stated.

- **Registration.** `Agent` and `SendMessage` are registered with `exposure: "codemode"`
  (`extensions/subagent/agent-tool.ts`, `send-message-tool.ts`). A codemode-exposed tool is callable only from
  scripts (`core/agent-session.ts`).
- **The child process.**
  - A child runs as `xpi --mode rpc` (`resolve.ts`, `runner.ts`).
  - With a persisted parent, its session is in `<parent session dir>/subagents/<parent session id>/` with a meta file
    per agent (`sessions.ts`). An in-memory parent (`--no-session`) gives children `--no-session`, so nothing can be
    continued: `Agent({ resume })` throws there (`sessions.ts`), and a typed message starts an empty session.
  - The child loads the extensions xpi discovers plus its agent file's `extensions`, and gets the parent's trust
    decision (`--approve`/`--no-approve`).
  - An agent file with `tools:` (or `permissionMode: plan`) produces an explicit `--tools` list. Tools that extensions
    register are then not active unless listed (`resolve.ts`, `core/agent-session.ts`).
  - `childCodemode` and the agent's `codemode` decide whether the child has codemode (`resolve.ts`).
- **The subagent extension in a child.** In a child (`XPI_SUBAGENT_DEPTH` set) the extension registers only codemode
  in "only" mode and returns (`index.ts`). Children get neither `Agent` nor `SendMessage`.
- **Exchanges.** There is one exchange per subagent at a time (`exchange.ts`, `registry.ts`). The child process exits
  when its exchange ends. Continuing an agent (`resume`, or `SendMessage` to one not running, or the user typing on
  its screen through `talk.ts`) starts a new exchange from its session. A running child takes a steer over rpc. A
  process-wide `subagent.maxConcurrent` limits running children; the first session's config fixes it.
- **Names.** `[A-Za-z0-9_-]{1,64}`, unique per parent session (`registry.ts`). After `/resume` the registry rebuilds
  the old records, names included, from the meta files.
- **The system prompt.**
  - The head must be the same for every agent type and must not contain the agent's name, so children share the
    cache prefix (`resolve.ts`).
  - The tail is per agent and is computed again on each continue (`talk.ts`).
- **Background.**
  - `run_in_background` detaches an agent. Main gets an end message when a background agent ends (`agent-tool.ts`).
  - An exchange the user starts by typing ends with a note to main (`exchange.ts`).
  - Print mode runs nothing in the background.
  - A workflow relaunch answers foreground `Agent` calls from saved results without running them; background ones run
    again (`runs.ts`).
- **The panel.**
  - The panel (`panel.ts`) lists subagents under the editor.
  - A finished row hides after `subagent.panelLingerMs` (default 30 s, `registry.ts`).
  - Enter opens the subagent screen (`subagent-screen.ts`).
  - `x` stops a running agent (`registry.stop` returns false when there is no process).
- **Modes and settings.**
  - `ctx.hasUI` is true in TUI **and** rpc mode. `ctx.mode` tells them apart (`core/extensions/types.ts`).
  - Settings are cached and read again on `/reload` (`settings-manager.ts`). Tools cannot be unregistered.
- **Ids and buses.**
  - Session ids are uuidv7. Their first eight hex characters are the high bits of the time and repeat for about a
    minute (`session-manager.ts`, `xpi-ai/src/utils/uuid.ts`).
  - `pi.events` is an in-process bus. `emit` calls the handlers synchronously and does not await them
    (`core/event-bus.ts`).
- **Keys and permissions.** `Ctrl+T` is `app.thinking.toggle` (also `app.tree.filter.noTools`,
  `core/keybindings.ts`). xpi has no permission prompts, only project trust, and no shell hooks.

## Decisions (`decisions.md`)

Grills 1–4 settle 25 numbered decisions. The Solution follows them; each section names the ones it implements.

## Solution

### Turning it on (decisions 2, 14, 18, 20)

- **Setting.**
  - `"agentTeams": { "enabled": true, "maxTeammates": 8, "taskRetentionDays": 30 }`.
  - `"agentTeams": true` is short for `{ "enabled": true }` with the defaults.
  - `XPI_EXPERIMENTAL_AGENT_TEAMS=1` also turns it on. There is no off override.
  - The settings schema documents the block.
- **When it is read.** At session start (and on `/reload`), because the lead's tools and prompt section are set up
  then.
- **Where teams are on.** Only when all of these hold:
  - `ctx.mode` is `"tui"`. In print and rpc mode a named call is an ordinary subagent.
  - The session is persisted. With `--no-session` teams are off, as fork is.
  - It is not a child.
- **Docs.** The docs call it experimental.

### The team (decisions 5, 13, 14, 17, 20, 23, 24)

- **Starting a teammate.**
  - With teams on, an `Agent` call with `name` and without `resume` starts a teammate.
  - A fork or a call with `isolation` stays an ordinary subagent, as in Claude Code.
  - Refused with teams on: a `name` call with `schema`, with `run_in_background: false`, or from a workflow or
    workflow script (decision 24). Each refusal throws, saying why.
- **The team.**
  - The first teammate creates the team. On disk it is `session-<full session id>`; the UI shows `session-<first 8>`.
  - Members are `lead` (the session) and the teammates by name. `lead` is a reserved name.
  - One team per session, and the lead is fixed.
- **Nesting.** Teammates get no `Agent` or `Workflow`, so they start nothing; nesting stays one level.
- **The call's result.** It returns at once with `{ status: "started", agentId, name, team }` (or `"queued"` while
  waiting for a `subagent.maxConcurrent` slot), like `run_in_background`, and never waits for the teammate's work.
- **Team size.** At most `maxTeammates` members that are not stopped (running, queued or idle). A call over the cap
  throws, naming them. Stopping a teammate frees its place.
- **Former teammates.** After `/resume`, `/reload` or a crash, the session's old teammates (meta `teammate: true`) are
  in the registry but not in the current team.
  - An `Agent` call with an old teammate's name continues it as a member of the team, with its history. Its `prompt`
    is the first message.
  - `SendMessage` to such a name does the same with the message.
  - Its tasks keep it as owner.
  - A name already used by a non-teammate subagent of the session still throws (spec 03).

### Files (decisions 7, 8)

All under `<agent dir>/teams/<team>/` and `<agent dir>/tasks/<team>/`, with file mode 0600 and directory mode 0700.

- **`config.json`.**
  - Contents: the team, the lead's session id and pid (`leadPid`), and the members `{ name, agentId, agentType, status, since }`, where
    `status` is `running`, `queued`, `idle`, `stopping` or `stopped` (a teammate whose exchange failed is `idle`:
    still live, woken by messages, keeping its tasks; the panel shows it as failed), and the lead's entry has `agentType:
    "team-lead"`.
  - Only the lead writes it. Teammates read it to find each other and to know who is live.
- **`inboxes/<name>.json`.**
  - A JSON array of `{ id, from, to, text, summary?, kind, at }`, with `kind` one of `message`, `idle`,
    `shutdown_request`, `shutdown_response` or `held`.
  - Only agents write here. A message with the user's authority never goes through a file (see
    [UI](#ui-decisions-9-22)).
- **`tasks/<team>/<id>.json`.** One task per file ([Tasks](#tasks-decisions-8-25)), plus `next` (the id counter).
- **Locks.**
  - Every read-modify-write of one of these files takes `<file>.lock`, made with an exclusive create and holding
    `{ pid, at }`.
  - The appending sender and the lead removing delivered entries take the same lock.
  - A task file and `next` are locked the same way. Creating a task, or changing `blockedBy`, also takes the team
    lock `tasks/<team>/.lock`, so two writers cannot make a cycle.
  - A held lock is retried every 25 ms for up to 2 s, then the operation throws `busy`.
  - A lock whose `pid` is not alive, or older than 30 s, is taken over: the taker renames it to a unique name
    (only one rename can succeed), removes that, and then creates its own lock exclusively.
  - Locks only make writes exclusive. Claims are the `owner` field, not a held lock.
- **Writes.** Every write goes to a temporary file in the same directory and is then renamed.
- **Bad entries.** An inbox entry that fails validation is dropped. The drop is logged in the lead's session as a
  warning, naming the inbox and the reason, and the valid entries are delivered.

### Messages (decisions 6, 7, 21)

- **Reaching members.**
  - `SendMessage({ to, message, summary? })` reaches any member by name; `to: "lead"` is the session.
  - Teammates get `SendMessage` scoped to their team. An unknown `to` throws with the roster.
  - The lead's `SendMessage` to its non-teammate subagents is unchanged (spec 03).
  - No broadcast: one message per recipient.
- **Shutdown arguments.** With teams on, the lead's and teammates' `SendMessage` also accept `kind:
  "shutdown_request" | "shutdown_response"` and `approve?: boolean`; `message` is then optional. With teams off the
  tool's declaration is exactly today's.
- **What `SendMessage` returns.**
  - To a member: `{ status: "sent", to, id }` once the entry is written. It throws when the write fails.
  - To a non-teammate subagent: as today.
- **The deliverer.** The lead process is the only one. It watches the team's `inboxes/` directory (`fs.watch` on the
  directory) and also polls it every 1 s, because rename-based writes and macOS FSEvents coalesce events.
  - Entries are taken under the inbox lock, removed, then delivered. If delivery fails before the target took the
    message, the entries are put back.
  - **To a running teammate.** A steer over rpc. Whether the child took it is known from rpc `queue_update` events
    (the steering queue) and the user message's `message_end`. If the child settles before it took the steer, the message is
    delivered as a new exchange instead, so nothing is lost. A test covers this race.
  - **To an idle teammate.** A new exchange continues it from its session. Messages that arrive together, or while an
    exchange is queued for it, are joined into one prompt in order.
  - **To a stopped teammate.** The sender's `SendMessage` throws `stopped` when the member is stopped at send time.
    Entries that arrive later are dropped with a warning.
  - **To `lead`.** A custom message with `triggerTurn`: a steer while the lead is in a turn, a new turn when it is
    idle. Messages that arrive together are joined.
- **Envelope.**
  - Every agent message is wrapped as `<agent-message from="<name>" team="<team>" kind="<kind>">…</agent-message>`.
  - A line follows saying it comes from another agent, not from the user, carries no user authority, and that a `/`
    command in it is plain text.
  - Delimiters inside the text are escaped.
  - The panel and screens render it as `✉ <from>: <summary or first line>`.
- **Idle notice.**
  - When a teammate's exchange ends, the lead process sends a `kind: "idle"` entry to `lead`. It carries the final
    answer, cut to 8 KB with the rest in a file as for subagent end messages, or the error when the exchange failed.
  - It replaces the background end message, and the typing note when the user typed to the teammate. The lead gets
    one notice per exchange.
  - There is no idle notice when the exchange ended by an approved shutdown or by `x`; the lead gets the stop instead.
  - Teammates do not get each other's idle notices.
- **Loop cap (decision 21).**
  - A teammate woken 5 times in a row by messages from other teammates, with no message from the lead or the user in
    between, is not woken a sixth time.
  - Further messages from teammates wait in its inbox. The lead gets a `kind: "held"` entry naming the teammate and
    the waiting senders.
  - A message from the lead or the user resets the count and delivers what waited.

### Tasks (decisions 8, 25)

- **Tools.**
  - `TaskCreate({ subject, description?, blockedBy?: id[] })`.
  - `TaskGet({ id })`.
  - `TaskList()`.
  - `TaskUpdate({ id, status?, owner?, subject?, description?, blockedBy?, result? })`.
  - Every member has them, the lead included.
- **A task.** `{ id, subject, description, status: "pending" | "in_progress" | "completed", owner?, blockedBy: id[],
  result?, createdBy, createdAt, updatedAt }`.
- **Dependencies.** An unknown id or a cycle in `blockedBy` is refused. Completing a task unblocks its dependents.
- **Status changes.**

| Change | Who | Rule |
|---|---|---|
| `pending` → `in_progress` (claim) | any member, for itself | every `blockedBy` task completed, else it throws `blocked` with their ids; no live member other than itself owns it, else it throws `conflict` with the owner |
| `owner` set without a status change (assign) | the lead | the owner gets a message saying so |
| `in_progress` → `completed` | the owner, or the lead | `result` recommended |
| `in_progress` → `pending` (release) | the owner, or the lead | `owner` cleared |
| `completed` → `pending` (reopen) | the lead | dependents count as blocked again |
| `pending` → `completed` | nobody | a task is claimed first |
| `subject`, `description`, `blockedBy` | the creator or the lead | |

- **Liveness.** A member is live when `config.json` says `running`, `queued` or `idle`. A stopped member's
  `in_progress` tasks return to `pending`.
- **Views.** `TaskList` shows id, status, owner, subject and blockers. `TaskGet` adds the description and result.
- **Self-claiming** is prompt guidance, not code: after finishing, a teammate reads `TaskList` and claims the next
  unblocked, unowned task.
- **Retention.** Tasks persist after the session. When a team is created, task directories whose newest file is older
  than `taskRetentionDays` are removed.

### Prompts (decision 15)

- **Teammate.** A section in the tail of its system prompt, frozen when the teammate first starts and reused on every
  continue, so that its history stays cached. The frozen tail is stored in the teammate's meta file (`teamPrompt`), with
  `team` and `teammate: true`, so it survives `/resume`. It contains:
  - the team's name and its own name;
  - that `SendMessage` reaches members by name (the roster as of its start, the lead is `lead`; an unknown name's
    error lists the current roster), and that messages from agents carry no user authority;
  - how to use the task list, including claiming the next unblocked task after finishing;
  - that its final answer is sent to the lead when it stops.
- **Lead.** A short section while teams are on, added at session start. It says:
  - an `Agent` call with `name` starts a teammate that runs in parallel and returns at once;
  - give each teammate distinct files and enough context in the prompt;
  - use the task list for work with dependencies;
  - wait for teammates' notices before finishing.
- **Off.** With teams off neither section exists.
- **Cache.** The head stays the same for every agent, so the subagent cache prefix rule holds.

### Tools in the teammate's process (decisions 6, 19)

- **How the child knows.** The lead starts a teammate with the environment `XPI_TEAM`, `XPI_TEAM_MEMBER` and
  `XPI_TEAM_DIR`.
- **What the child registers.** The subagent extension, in a child with these set, registers `SendMessage` and the
  four Task tools, in addition to codemode as today. It still registers no `Agent` or `Workflow`.
- **Exposure.** `resolveTools` knows whether the child ends up with codemode (including codemode that an MCP server
  turns back on) and passes `XPI_TEAM_TOOLS=codemode|direct`. The five tools have `codemode` exposure in the first
  case and are direct tools in the second; the child does not guess.
- **The tool list.** `resolveTools` adds the five to an explicit `--tools` list and never puts them in
  `--exclude-tools`, whatever the agent file's `tools`, `disallowedTools` or `permissionMode` say. Naming them in an
  agent file's `tools:` is accepted without the unknown-tool warning.
- **Caching.** The cache `prefixKey` includes the team tool set.
- **The lead.** It gets the four Task tools registered at session start while teams are on (codemode exposure, like
  `Agent`).

### Shutdown and the end of a team (decisions 10, 22)

- **Shutdown request.**
  - Only the lead may send one: `SendMessage({ to, kind: "shutdown_request", message? })`.
  - The teammate answers `SendMessage({ to: "lead", kind: "shutdown_response", approve, message? })`.
  - A response without a pending request throws.
  - **Approval.** The teammate's status becomes `stopping`. Its exchange ends after the current tool call: the child
    writes the response, then aborts its run. When an exchange ends, the lead first checks `lead`'s inbox, under its
    lock, for that member's `shutdown_response` and decides the state from the file, so an approved shutdown is never
    taken for a failure. It then becomes `stopped`, with no idle notice and no `teammate_idle` event.
  - **Rejection.** It keeps working, and the lead gets the reason.
- **`x` on its panel row.** Stops a teammate in any state.
  - Running: as for a subagent today.
  - Idle or queued: it is marked `stopped` without a process to kill.
  - A stopped teammate is not woken, and its tasks return to `pending`.
- **Session end** (also `/reload`, which ends the session runtime):
  - running teammates are stopped;
  - `config.json` and the inboxes are removed;
  - the tasks are kept.
  - If the process dies first, the next team created in this agent dir removes `teams/` directories whose lead
    session is not live (no live pid in its `config.json` `leadPid`).
- **`/resume`.** It does not restore the team (decision 23 covers using the old names).

### UI (decisions 9, 22)

- **Panel.**
  - Teammates are rows in the subagent panel with name, state (running, queued, idle, stopping, stopped, failed) and
    the subject of the task they own.
  - `idle` and `stopping` get an icon and a color.
  - Teammate rows that are not stopped never hide (no `panelLingerMs`).
  - ↑↓ selects a row, Enter opens the screen, and `x` stops the teammate.
- **Screen.**
  - **Typing** sends the user's text to the teammate with the user's authority. It goes straight to the deliverer in
    the lead process, never through an inbox file: a steer while it runs, a new exchange when it is idle. It resets
    the loop count.
  - **Esc** interrupts the teammate's current turn without stopping it: a new interrupt path (not `registry.stop`,
    whose abort ends as failed) aborts the run, and the teammate becomes `idle`, still woken by messages. An
    interrupted exchange sends no idle notice and fires no `teammate_idle`, so a hook cannot wake it again at once. A second Esc, or Esc while it is idle, closes the screen.
  - Agent messages show inline as `✉` lines.
- **Task list.** `/tasks` opens an overlay of the task list (id, status, owner, subject, blockers), which refreshes as
  the files change. A keybinding `app.team.tasks` has no default key, because `Ctrl+T` is taken.

### Hooks (extension events) (decisions 11, 25)

- **Events.** They go through `pi.events`, named `agent-teams:<event>`:
  - `teammate_idle` `{ team, name, agentId, result | error }`: in the lead process, before the idle notice is sent.
  - `task_created` `{ team, task, by }`: in the process that runs `TaskCreate`, before the file is written.
  - `task_completed` `{ team, task, by }`: in the process that runs `TaskUpdate` to `completed`, before the write.
- **Order.** Events, and any `hold`, run before a lock is taken. Once the step is allowed, the writer takes its locks
  and checks again (blocked, conflict, cycle), so a slow hook never holds a lock. `task_created` carries the task
  without an id: the id is taken from `next` after the hook allows it.
- **Answering.** Each payload has `block(feedback: string)` and `hold(promise: Promise<string | undefined>)`.
  - A handler calls either one during `emit` (before its first `await`).
  - `hold` lets a handler decide asynchronously: a string blocks with that feedback, and `undefined` allows.
  - Held promises are awaited up to 5 minutes. On a timeout the step is allowed and a warning is logged.
- **Blocking.**
  - A blocked `task_created` or `task_completed` throws the feedback back to the calling agent, and the step does
    not happen.
  - A blocked `teammate_idle` sends the feedback to the teammate as a message instead of the idle notice, so it keeps
    working. This happens at most 3 times in a row per teammate; the fourth idle notice goes to the lead whatever the
    hooks say.
- **Where task events fire.** In the teammate's own process, which loads the extensions xpi discovers, as any subagent
  does.

### Porting (decision 4)

- **The menu.** `packages/xpi-coding-agent/docs/porting.md` gets an "agent teams" option of the subagents unit:
  - what it gives;
  - depends on: the subagents unit (names, `SendMessage`, panel and screen), `pi.events`, `ctx.mode`, and a file
    system with exclusive create and atomic rename in one directory;
  - the files;
  - turning it off: the setting, or its wiring lines in `index.ts`;
  - Linux notes: `fs.watch` on a directory uses inotify, kept with the 1 s poll; locks are lock files, not `flock`;
    pid liveness uses `kill(pid, 0)`;
  - then macOS differences: FSEvents coalescing.
- **The detailed guide.** A section goes in `subagent-porting.md`.

## Out of scope

- Teammates as roost background sessions, and split panes (a later spec).
- Messages between sessions and watches (decision 3).
- Broadcast.
- Nested teams.
- Per-teammate permission modes (xpi has none).
- Plan mode and plan approval (xpi has none).
- Automatic restore of a team on `/resume`.
- More than one team per session.
- Project-level team config files.
- The same session resumed in two terminals at once (two leads of one team).
- Teammates in workflows (decision 24).

## Testing

- **Offline**, with the fake model the subagent tests use. Each new guard is checked to fail when removed. The tests
  cover:
  - **Where teams are on.** On only in TUI mode. Named calls stay subagents in print mode, in rpc mode (where `hasUI`
    is true), with `--no-session`, with teams off, and from workflows.
  - **Team names and files.** Two sessions started in the same minute get distinct team dirs.
  - **Teammate tools.** An agent with a `tools:` list, with `codemode: false`, or with `permissionMode: plan` still
    has the five tools, as direct tools without codemode.
  - **Mailboxes.**
    - append and delete under concurrent writers;
    - lock timeout and takeover of a stale lock;
    - invalid entries.
  - **Delivery.**
    - a running teammate (steer), including the race where the child settles first;
    - an idle one (a new exchange, with joined messages);
    - `lead`, and a stopped teammate.
  - **Messages.**
    - the envelope and its escaping;
    - one idle notice per exchange, including typing;
    - the loop cap: an A↔B ping-pong stops at 5, and a lead message releases it (the cap counts wakes; steers
      between two running teammates are bounded by `maxTurns`).
  - **The team.**
    - the cap counts idle members;
    - `/resume` with an old teammate's name;
    - shutdown request, approval, rejection, and a response without a request.
  - **Tasks.**
    - create, claim, conflict, blocked, unblock, reopen;
    - a cycle made by two concurrent writers is refused;
    - who may change what, release on stop, retention.
  - **Ending.** Session end and `/reload` cleanup; stale team dirs after a crash.
  - **Hooks.** `block`, `hold` (allow, block, timeout, no lock held meanwhile), and the 3-in-a-row idle limit.
  - **Locks.** Two processes taking over one stale lock at once: one wins.
  - **States.** Esc sends no idle notice; a failed exchange leaves the teammate idle; an approved shutdown racing the
    exchange's end is not a failure; `/reload` then an old teammate's name.
  - **UI** (pty tests in the existing style):
    - teammate rows that never hide;
    - Esc interrupting without stopping;
    - `x` on an idle teammate;
    - typing on the screen;
    - the `/tasks` overlay.
  - **macOS.** The poll path (FSEvents coalescing).
- **Real check** before the last merge:
  - Setup: Haiku, a temporary agent dir and HOME with a copy of the auth file whose expiry is checked first, and the
    real `~/.pi/agent` untouched.
  - Flow: a lead with two teammates on a three-task list where task 3 depends on 1 and 2. The teammates message each
    other once and claim tasks. The lead gets both idle notices and finishes. A shutdown request is approved.
  - End state: the team files are removed at session end and the tasks are kept.

## PRs (after approval)

1. **Core.**
   - Code: the setting and where teams are on; the team and `config.json`; mailboxes, locks and the deliverer;
     `SendMessage` between members and its shutdown arguments; the envelope, idle notices and the loop cap; the cap,
     shutdown, end-of-session and crash cleanup; `/resume` names; the teammate's process wiring and tools list (with
     `SendMessage` only); prompts.
   - Docs: `subagent.md` "Agent teams", `settings.md`, the porting entry for what exists.
2. **Tasks.**
   - Code: the four tools in the lead and teammates, locks and the team lock, dependencies, permissions, retention;
     the three `agent-teams:` events with `block` and `hold`.
   - Docs: the user docs, and the porting entry updated.
3. **UI.**
   - Code: teammate rows; typing as a user message; Esc; `x` on idle teammates; `/tasks` and `app.team.tasks`.
   - Docs: `keybindings.md`, `subagent.md`.
4. **Wrap-up.**
   - The detailed porting section and the menu entry complete, and `docs/xin-pi.md`.
   - The real Haiku check.
   - A release.
