# The roost protocol

How the processes of xpi-roost talk: a session (an xpi in a PTY) to its daemon, and a
controller (the hub, the command line, a test) to the daemon. Version 1, as pi-roost
spoke it, reduced to phase 1's ops plus phase 2's schedule ops: there are no messages
between sessions, no task board and no concierge (see `port-inventory.md`).

## Where a roost is

Each agent directory has its own roost. Its state is in `<agent dir>/xpi-roost/` and its
sockets are in a runtime directory keyed by the agent directory:
`$XDG_RUNTIME_DIR/xpi-roost-<key>`, or `/tmp/xpi-roost-<uid>/<key>`, where `<key>` is the
first 12 hex digits of the SHA-256 of the agent directory's real path (made absolute
first). `ROOST_HOME` and `ROOST_RUNTIME_DIR` override both, unless `ROOST_AGENT_DIR` names another
agent directory than the one asked for: a session carries its roost's three variables, and a
process inside it that asks for another agent directory gets that directory's roost, never
its session's. Set without `ROOST_AGENT_DIR`, they are the user's own overrides. The daemon's socket is `daemon.sock` in the runtime directory; each
host's is `host-<id>.sock`.

Before connecting, a client checks each level of the runtime directory that exists (both
under `/tmp`): a directory, not a link, owned by the user; otherwise it refuses. The daemon
holds two locks: `daemon.lock` in the runtime directory and `state.lock` in the state
directory, so two clients of one agent directory that work out different runtime
directories (one with `XDG_RUNTIME_DIR`, one without) never start two daemons over one
state; the second client is told where the running daemon is.

The client that starts the daemon gives it its location in the environment:
`ROOST_AGENT_DIR`, `ROOST_HOME`, `ROOST_RUNTIME_DIR` (always, as the client worked them out) and `ROOST_HOST_ENTRY`,
the host's entry file. The daemon passes them to each host, and a host to its session,
with `XPI_CODING_AGENT_DIR` set to the same agent directory, whatever the session's
environment lists allow or deny. A session's own `/agents` therefore reaches the daemon
that runs it.

## A session's identity

Set by the host in the session's environment at start, for the job's whole life:

| Variable | |
|---|---|
| `ROOST_JOB_ID` | the job |
| `ROOST_JOB_TOKEN` | its secret: every request about the job carries it |
| `ROOST_SOCKET` | the daemon's unix socket |
| `ROOST_JOB_DIR` | the job's directory |

None of them is passed on to another job. `jobIdentity` in `src/lib/agent-client.ts` reads
them (and keeps them across a `/reload`, since the token is removed from the environment
once read). A shell job has no identity: it does not report.

## The wire

A unix stream socket (owner-only). Each message is one line of JSON (UTF-8, `\n`).

- Request, client to daemon: `{"id": 1, "op": "report", "args": {...}}`. `id` is the
  client's number for matching the response.
- Response: `{"id": 1, "ok": true, "result": {...}}` or
  `{"id": 1, "ok": false, "error": "text", "code": "unauthorized"}`.
- Event, daemon to client, unasked: `{"event": "deliver", ...}` (no `id`).

Unknown fields are ignored on both sides. Requests on one connection are answered in
order. A request line is at most 4 MiB (a longer one ends the connection); at most 1024
connections; at most 256 requests in flight on one connection (it is not read
meanwhile); a client that leaves 16 MiB of answers and events unread is dropped.

Error codes: `bad_request` (malformed, or an unknown op), `unauthorized` (wrong token:
stop speaking for this job), `not_found` (no such job), `full` (50 replies already
waiting), `busy` (try again shortly), `unsupported` (not for this caller or this kind of
job), and others for controllers (`locked`, `no_host`, ...).

## Callers

The daemon judges each connection once per request (`src/lib/callers.ts`):

- **Person**: a connection that never said it is an agent (the hub, the command line).
- **Session**: a connection whose `report` the daemon accepted; it is bound to that job.
- **Unregistered agent**: a connection that said `hello` or `report` without being known.

Identifying and reading (`hello`, `report`, `ack`, `ping`, `list`, `resolve`, `status`)
are anyone's. Everything that starts, stops or changes jobs, `subscribe` and `events` are
the Person's; a session that needs them opens a connection of its own. The op reference
below gives each op's row.

## A session's ops

### `hello`

```json
{"op": "hello", "args": {"protocol": 1, "agent": {"name": "xpi", "version": "<xpi version>"}, "capabilities": ["report", "replies"]}}
-> {"protocol": 1, "daemon": {"name": "roost", "version": "<roost version>"}, "capabilities": ["replies", "steer", "events"]}
```

On every new connection, before the first report. Each side's `version` is its package
version (xpi's and xpi-roost's are the same in a release). The daemon keeps the capabilities
with the job (rows show them) and answers with its own.

### `report`

A full snapshot every time (`WorkerReport` below): what is left out is null. Send one
whenever the state changes; the row text at most every few seconds. The connection a
report goes through becomes the job's: replies come on it. `Reporter` in
`src/lib/agent-client.ts` does this: it coalesces, reconnects with backoff after a
daemon restart, and resends the latest report.

### Replies: the `deliver` event and `ack`

```json
<- {"event": "deliver", "id": "<job>", "seq": 3, "text": "also fix the docs", "mode": "steer"}
-> {"op": "ack", "args": {"id": "<job>", "token": "<token>", "seq": 3}}
```

- Replies are numbered per job (`seq`, from 1, never reused, continued across restarts).
- Each stays pending until acked; on every new reporting connection all pending ones
  are sent again. Drop a `seq` already handled (and ack it again).
- An ack covers every reply up to that `seq`: ack a reply only once it and every one
  before it are handled.
- `mode`: `steer` (join the work under way) or absent (after it).
- A reply of `/stop` is never delivered: the daemon stops the job. A reply starting
  with `/` is not kept while the session is not connected (a command means something
  live only). A reply to a session that has ended starts it again, and the new worker
  picks the reply up.

## A controller's ops

`dispatch` starts a job (an xpi session or a shell command); `stop`, `rm`, `respawn`,
`pin`, `rename`, `reorder` and `reply` act on one; `list`, `resolve` and `status` read;
`subscribe` turns the connection into a feed of `job` and `removed` events; `events`
reads the last 1000 things that happened (starts, state changes, replies, restarts,
removals, schedules' runs and skips); `shutdown` stops the daemon (and its sessions, unless
`keepWorkers`).

### Schedules

`schedules`, `schedule-add`, `schedule-edit`, `schedule-rm`, `schedule-pause` and
`schedule-run` are the Person's. A schedule is a name, a time rule (local time: `every
<n>m|h|d`, `daily HH:MM`, `weekdays HH:MM`, `weekly <mon..sun> HH:MM`, `cron "<5
fields>"`, `manual`; two slots never under 5 minutes apart), the task as typed, and a
`launch`: the `DispatchArgs` of an xpi session whose `sessionFile` (absolute) holds
`{{run}}` and whose `command` names it. The caller builds the launch, environment
included, as for any new session (`buildLaunch`); the daemon stores it in
`<roost home>/schedules.json` (0600) and every run starts with it, `{{run}}` replaced by a
new `<time>_<uuid>`. At most 50 schedules; a task at most 64 KiB; a missing directory is
refused at `schedule-add`, and `schedule-edit` cannot change it.

The daemon looks every 15 s (`ROOST_SCHEDULE_TICK_MS`). A run is a new job named after
the schedule (`nightly`, `nightly (2)`) whose record and row carry `schedule`; the feed
records it as a `schedule` event (`who`: the schedule, `why`: `due`, `catch-up` or `now`),
not as a `dispatch`. A slot missed by more than two ticks (the daemon was off, the machine
slept) runs once as a `catch-up` if one fell within the last 7 days; `nextAt` then moves
to the first slot after now. A slot is skipped while the schedule's last run is working,
starting (also a `schedule-run` still starting) or waiting to restart after a crash (not while it waits for an
answer); a
directory, executable or entry that is gone, or a start that fails, skips it too. A skip
is kept in the schedule's `lastSkip` and recorded as a `schedule` event with `why: "skip"`
and the reason in `text`. `schedule-run` starts a run at once, also for a paused or
`manual` schedule, without moving `nextAt`; while the last run works it answers `busy`.
The daemon keeps 3 ended, unpinned runs per schedule and removes older ones' records as
`rm` does. A run that ended on a question counts as ended once it has no process, unless it
is the schedule's last run; one with a reply or a restart waiting does not. Runs belong to a
schedule by its id (a job record's `scheduleId`), so a schedule removed and added again
under its name does not take the old runs. A rule that never matches a date is refused, and
a launch whose task (the argument after `--`) is not the schedule's task is refused.

When `schedules.json` cannot be read, the daemon moves it to `schedules.json.bad-<time>`,
starts with none and says so in the `problem` of `schedules`. Entries it cannot run are kept
in the file as they are (`unread` counts them).

An older daemon answers these ops with `bad_request: unknown op` (the protocol version
stays 1).

`reply` and `dispatch` take an optional `requestId` (1-64 of `A-Z a-z 0-9 _ . : -`). Sent
again with the same id because the answer was lost, the request is taken once: a reply
answers `{"duplicate": true, "saved": true}` and is not queued again; a dispatch answers
with the job the first one made. `requestOnce` in `src/lib/client.ts` resends on a new
connection when the answer was lost, never after a refusal.

## Op reference

<!-- op-reference:start -->

Generated from `src/lib/protocol-schema.ts`, `src/lib/callers.ts` and `src/lib/protocol.ts` by `npm run docs:protocol`; do not edit between the markers.

Protocol version 1. Types: `string`, `number`, `integer`, `boolean`, `null`, `T[]`, `Record<string, T>`, `{ field?: T }` (`?`: optional), a quoted value. A type named after another module's interface (`RoostEvent`, `UsageInfo`) is described there. A limit is what the daemon does with the value today: some are refused (`bad_request`, `too_long`), some cut.

### Capabilities

Daemon (`hello` answers with these, in this order):

| Capability | |
|---|---|
| `replies` | takes the user's replies for the session (`deliver`, `ack`) |
| `steer` | honours `mode: "steer"` on a reply |
| `events` | `events` |

Session (named in its `hello`):

| Capability | The session ... |
|---|---|
| `report` | sends reports (every session of this protocol) |
| `replies` | takes replies and acks them |
| `steer` | honours `mode: "steer"` on a reply |
| `usage` | fills `usage` in its reports |
| `context` | fills `context` in its reports |
| `model-switch` | takes `/model` and `/thinking` replies |
| `transcript` | has a transcript roost can show |

### Shared shapes

#### `DispatchArgs`

A session to start.

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `kind` | `"pi" \| "shell"` | no |  | DI-6: "shell" runs `command` without xpi (no session file). |
| `cwd` | `string` | yes |  |  |
| `sessionFile` | `string` | yes |  |  |
| `command` | `string[]` | yes |  |  |
| `env` | `Record<string, string>` | yes |  |  |
| `name` | `string` | yes |  |  |
| `model` | `string` | no |  |  |
| `thinking` | `string` | no |  |  |
| `workspaceEnv` | `"shell" \| "direnv" \| "off"` | no |  | M20: how the worker's environment follows its workspace (absent: as carried). |
| `envDeny` | `string[]` | no |  | M20: names (or `PREFIX*`) a workspace's environment may not set. |
| `envForce` | `string[]` | no |  | M20: names that pass envDeny (envAllowList). |
| `origin` | `"bg" \| "dispatch" \| "adopt" \| "fork"` | yes |  |  |
| `piVersion` | `string` | no |  |  |
| `requestId` | `string` | no |  | M36: a resend with the same id returns the job the first one made (one not of this form is refused). |

#### `HelloArgs`

M31: an agent says which protocol and capabilities it has, before it reports.

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `protocol` | `integer` | yes |  | The highest protocol version the agent speaks. |
| `agent` | `{ name: string, version?: string, build?: string }` | no |  |  |
| `capabilities` | `string[]` | no |  | What the agent can do (AGENT_CAPABILITIES); unknown ones are ignored (and what is not a string). |

#### `HelloResult`

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `protocol` | `integer` | yes |  |  |
| `daemon` | `{ name: "roost", version: string }` | yes |  |  |
| `capabilities` | `string[]` | yes |  | What the daemon offers agents (the ops beyond report, ack and hello): DAEMON_CAPABILITIES. |

#### `WorkerReport`

What a worker reports about itself (full snapshot every time).

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `state` | `"working" \| "blocked" \| "done" \| "failed"` | yes |  |  |
| `status` | `"busy" \| "waiting" \| "idle"` | yes |  |  |
| `waitingFor` | `"dialog" \| "question" \| "first-prompt" \| null` | yes |  |  |
| `summary` | `string \| null` | yes |  |  |
| `question` | `string \| null` | yes |  |  |
| `choices` | `string[]` | yes |  |  |
| `tool` | `string \| null` | yes |  |  |
| `error` | `string \| null` | yes |  |  |
| `name` | `string \| null` | yes |  |  |
| `model` | `string \| null` | yes |  |  |
| `thinking` | `string \| null` | no |  | M8; absent from workers before 0.1.5. |
| `context` | `ContextInfo \| null` | no |  | M8: how full the session's context window is (xpi's ctx.getContextUsage()). |
| `usage` | `UsageInfo \| null` | no |  | M24: absent from workers before 0.1.11. |
| `attachSignal` | `boolean` | no |  | The worker reacts to the host's SIGUSR2 attach signal (AT-5). |

#### `JobRow`

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `id` | `string` | yes |  |  |
| `cwd` | `string` | yes |  |  |
| `kind` | `"pi" \| "shell"` | yes |  |  |
| `startedAt` | `number` | yes |  |  |
| `state` | `"working" \| "blocked" \| "done" \| "failed" \| "stopped"` | yes |  |  |
| `pid` | `number \| null` | yes |  |  |
| `status` | `"busy" \| "waiting" \| "idle" \| null` | yes |  |  |
| `waitingFor` | `"dialog" \| "question" \| "first-prompt" \| null` | yes |  |  |
| `sessionFile` | `string` | yes |  |  |
| `name` | `string` | yes |  |  |
| `endedAt` | `number \| null` | yes |  |  |
| `summary` | `string \| null` | yes |  | Row text: a status sentence while working, the result or question after. |
| `question` | `string \| null` | yes |  |  |
| `choices` | `string[]` | yes |  |  |
| `model` | `string \| null` | yes |  |  |
| `thinking` | `string \| null` | yes |  | M8: the worker's thinking level (or the one it was started with). |
| `context` | `ContextInfo \| null` | yes |  | M8: context window use as last reported; null for shell jobs and before the first report. |
| `usage` | `UsageInfo \| null` | no |  | M24: what the session spent, as last reported (absent before it reports, or from older workers). |
| `error` | `string \| null` | yes |  |  |
| `stateSince` | `number` | yes |  | When the job entered its current state (for "waiting 3m"). |
| `reaped` | `boolean` | yes |  | DM-4: stopped for idleness; attaching or replying starts it again. |
| `pinned` | `boolean` | yes |  | AV-K7: listed first and never reaped. |
| `order` | `number \| null` | yes |  | AV-K13: the user's position within its group, or null when never moved. |
| `orderKey` | `string \| null` | yes |  | The section the order belongs to (a state group or `dir:<cwd>`); stale elsewhere. |
| `capabilities` | `string[]` | no |  | M31: what its agent said it can do in its hello (absent: it never said). |
| `build` | `string` | no |  | Spec 03: the build id of the code its process runs, from its hello (absent: not running, or its agent did not say). |
| `task` | `string \| null` | no |  | M48: the task it was started on (one line, at most 200 characters). |
| `queued` | `number` | no |  | M48: user replies waiting for it. |
| `schedule` | `string \| null` | no |  | Phase 2: the schedule that started it (absent or null: none). |

#### `DaemonStatus`

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `pid` | `number` | yes |  |  |
| `version` | `string` | yes |  |  |
| `socketDir` | `string` | yes |  |  |
| `liveJobs` | `number` | yes |  |  |
| `totalJobs` | `number` | yes |  |  |
| `build` | `string` | no |  | Spec 03: the build id of the code this daemon runs (absent: unknown, as from sources). |
| `ptyError` | `string \| null` | yes |  |  |
| `startedAt` | `number` | yes |  |  |

#### `ContextInfo`

M8: how full the session's context window is (xpi's ctx.getContextUsage()).

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `tokens` | `number \| null` | yes |  | Estimated tokens in context; null right after a compaction, until the next reply. |
| `window` | `number` | yes |  |  |
| `percent` | `number \| null` | yes |  | 0-100; null when tokens is unknown. |

#### `ScheduleRow`

Phase 2: a schedule, as the hub and `xpi roost schedule list` show it.

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `name` | `string` | yes |  |  |
| `when` | `string` | yes |  | The rule as written: `every 2h`, `daily 09:00`, `weekdays 09:00`, `weekly mon 09:00`, `cron "..."`, `manual`. |
| `task` | `string \| null` | yes |  |  |
| `cwd` | `string` | yes |  |  |
| `model` | `string \| null` | yes |  |  |
| `thinking` | `string \| null` | yes |  |  |
| `paused` | `boolean` | yes |  |  |
| `nextAt` | `number \| null` | yes |  | The next run (ms epoch); null while paused and for `manual`. |
| `lastRunAt` | `number \| null` | yes |  |  |
| `lastJob` | `string \| null` | yes |  | The job of its last run. |
| `lastRunWhy` | `"due" \| "catch-up" \| "now" \| null` | yes |  | Why its last run started: on its slot, a missed slot, or asked. |
| `lastSkip` | `{ at: number, why: string } \| null` | yes |  | Why its last slot or run-now did not start (the previous run still working, a missing directory, an error). |

### Ops

### `ping`

Callers: Person, Session, Unregistered agent. Refused: none.

Args:

No fields.

Result:

| Field | Type | Required | |
|---|---|---|---|
| `pid` | `number` | yes |  |
| `version` | `string` | yes |  |

### `hello`

M31: an agent says which protocol and capabilities it has, before it reports.

Callers: Person, Session, Unregistered agent. Refused: none.

Args:

`HelloArgs` (see shared shapes).

Result:

`HelloResult` (see shared shapes).

### `list`

Callers: Person, Session, Unregistered agent. Refused: none.

Args:

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `all` | `boolean` | no |  |  |
| `cwd` | `string` | no |  |  |

Result:

| Field | Type | Required | |
|---|---|---|---|
| `jobs` | `JobRow[]` | yes |  |

### `dispatch`

A session to start.

Callers: Person. Refused: Session (`unsupported`), Unregistered agent (`unsupported`).

Args:

`DispatchArgs` (see shared shapes).

Result:

| Field | Type | Required | |
|---|---|---|---|
| `id` | `string` | yes |  |
| `name` | `string` | yes |  |

### `stop`

Callers: Person. Refused: Session (`unsupported`), Unregistered agent (`unsupported`).

Args:

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `id` | `string` | yes | >= 1 chars |  |

Result:

| Field | Type | Required | |
|---|---|---|---|
| `id` | `string` | yes |  |

### `rm`

Callers: Person. Refused: Session (`unsupported`), Unregistered agent (`unsupported`).

Args:

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `id` | `string` | yes | >= 1 chars |  |

Result:

| Field | Type | Required | |
|---|---|---|---|
| `id` | `string` | yes |  |

### `resolve`

Callers: Person, Session, Unregistered agent. Refused: none.

Args:

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `query` | `string` | yes | >= 1 chars |  |

Result:

| Field | Type | Required | |
|---|---|---|---|
| `id` | `string` | yes |  |

### `status`

Callers: Person, Session, Unregistered agent. Refused: none.

Args:

No fields.

Result:

`DaemonStatus` (see shared shapes).

### `shutdown`

Callers: Person. Refused: Session (`unsupported`), Unregistered agent (`unsupported`).

Args:

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `keepWorkers` | `boolean` | no |  |  |

Result:

No fields.

### `subscribe`

Callers: Person. Refused: Session (`unsupported`), Unregistered agent (`unsupported`).

Args:

No fields.

Result:

No fields.

### `report`

Callers: Person, Session, Unregistered agent. Refused: none.

Args:

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `id` | `string` | yes |  |  |
| `token` | `string` | yes |  |  |
| `report` | `WorkerReport` | yes |  | What a worker reports about itself (full snapshot every time). |

Result:

No fields.

### `reply`

M28: a reply to a working session steers into its current work (xpi's Enter) or waits for it to finish (Alt+Enter); absent: waits.

Callers: Person. Refused: Session (`unsupported`), Unregistered agent (`unsupported`).

Args:

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `id` | `string` | yes | >= 1 chars |  |
| `text` | `string` | yes | >= 1 chars (trimmed) |  |
| `mode` | `"steer" \| "followUp"` | no |  | "steer" joins the work under way, after its current tool calls; "followUp" waits until it is done |
| `requestId` | `string` | no |  | M36: makes a resend safe: the same id is taken once (the first answer is given again). |

Result:

| Field | Type | Required | |
|---|---|---|---|
| `delivered` | `boolean` | yes | handed to the live worker |
| `saved` | `boolean` | yes | kept for its next start (PK-5) |
| `stopped` | `boolean` | no |  |
| `respawned` | `boolean` | no |  |
| `error` | `string` | no |  |
| `duplicate` | `boolean` | no |  |

### `ack`

Worker to daemon: the replies up to this seq were handed to the session.

Callers: Person, Session, Unregistered agent. Refused: none.

Args:

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `id` | `string` | yes |  |  |
| `token` | `string` | yes |  |  |
| `seq` | `integer` | yes |  |  |

Result:

No fields.

### `respawn`

Start an ended job again from its session file; `restart` also restarts a live one.

Callers: Person. Refused: Session (`unsupported`), Unregistered agent (`unsupported`).

Args:

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `id` | `string` | no |  | Required unless `all`. |
| `all` | `boolean` | no |  |  |
| `restart` | `boolean` | no |  |  |
| `prompt` | `string` | no |  |  |

Result:

| Field | Type | Required | |
|---|---|---|---|
| `results` | `{ id: string, started: boolean, error?: string }[]` | yes |  |

### `pin`

Callers: Person. Refused: Session (`unsupported`), Unregistered agent (`unsupported`).

Args:

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `id` | `string` | yes | >= 1 chars |  |
| `pinned` | `boolean` | yes |  |  |

Result:

| Field | Type | Required | |
|---|---|---|---|
| `id` | `string` | yes |  |
| `pinned` | `boolean` | yes |  |

### `rename`

Callers: Person. Refused: Session (`unsupported`), Unregistered agent (`unsupported`).

Args:

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `id` | `string` | yes | >= 1 chars |  |
| `name` | `string` | yes | >= 1 chars (trimmed) | Spaces folded; cut at 200 characters. |

Result:

| Field | Type | Required | |
|---|---|---|---|
| `id` | `string` | yes |  |
| `name` | `string` | yes |  |

### `reorder`

AV-K13: these jobs, in this order (the rest of their group keeps its place).

Callers: Person. Refused: Session (`unsupported`), Unregistered agent (`unsupported`).

Args:

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `ids` | `string[]` | yes |  |  |
| `key` | `string` | yes | >= 1 chars |  |

Result:

No fields.

### `events`

M43: the event feed (what happened), with a cursor: `after` the seq last seen.

Callers: Person. Refused: Session (`unsupported`), Unregistered agent (`unsupported`).

Args:

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `after` | `number` | no |  |  |
| `limit` | `number` | no |  |  |
| `id` | `string` | no | >= 1 chars |  |

Result:

| Field | Type | Required | |
|---|---|---|---|
| `events` | `RoostEvent[]` | yes |  |
| `cursor` | `number` | yes |  |

### `schedules`

Callers: Person. Refused: Session (`unsupported`), Unregistered agent (`unsupported`).

Args:

No fields.

Result:

| Field | Type | Required | |
|---|---|---|---|
| `schedules` | `ScheduleRow[]` | yes |  |
| `problem` | `string` | no | The file could not be read when the daemon started: where it was moved; the daemon started with none. |
| `unread` | `number` | no | Entries of the file this daemon cannot run (bad, or from a newer xpi): kept in the file as they are. |

### `schedule-add`

Phase 2: a schedule. `launch` is an xpi dispatch whose sessionFile holds `{{run}}` (each run's own file), built by the caller, environment included.

Callers: Person. Refused: Session (`unsupported`), Unregistered agent (`unsupported`).

Args:

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `name` | `string` | yes | >= 1 chars | A letter or digit, then up to 39 of A-Z a-z 0-9 _ . -. |
| `when` | `string` | yes | >= 1 chars |  |
| `task` | `string` | no |  | The first prompt, at most 64 KiB. |
| `launch` | `DispatchArgs` | yes |  | A session to start. |

Result:

`ScheduleRow` (see shared shapes).

### `schedule-edit`

Phase 2: the launch built again by the editing process; its directory cannot change.

Callers: Person. Refused: Session (`unsupported`), Unregistered agent (`unsupported`).

Args:

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `name` | `string` | yes | >= 1 chars | A letter or digit, then up to 39 of A-Z a-z 0-9 _ . -. |
| `when` | `string` | no |  | A new rule: the anchor is now and nextAt its first slot after now. |
| `task` | `string` | no |  |  |
| `launch` | `DispatchArgs` | yes |  | A session to start. |

Result:

`ScheduleRow` (see shared shapes).

### `schedule-rm`

Callers: Person. Refused: Session (`unsupported`), Unregistered agent (`unsupported`).

Args:

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `name` | `string` | yes | >= 1 chars | A letter or digit, then up to 39 of A-Z a-z 0-9 _ . -. |

Result:

| Field | Type | Required | |
|---|---|---|---|
| `name` | `string` | yes |  |

### `schedule-pause`

Phase 2: pause or resume a schedule.

Callers: Person. Refused: Session (`unsupported`), Unregistered agent (`unsupported`).

Args:

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `name` | `string` | yes | >= 1 chars | A letter or digit, then up to 39 of A-Z a-z 0-9 _ . -. |
| `paused` | `boolean` | no |  | true pauses; anything else resumes, counted from now. |

Result:

`ScheduleRow` (see shared shapes).

### `schedule-run`

Phase 2: a run at once, also paused or manual, nextAt unmoved; busy while the previous run works.

Callers: Person. Refused: Session (`unsupported`), Unregistered agent (`unsupported`).

Args:

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `name` | `string` | yes | >= 1 chars | A letter or digit, then up to 39 of A-Z a-z 0-9 _ . -. |

Result:

| Field | Type | Required | |
|---|---|---|---|
| `name` | `string` | yes |  |
| `id` | `string` | yes |  |

<!-- op-reference:end -->
