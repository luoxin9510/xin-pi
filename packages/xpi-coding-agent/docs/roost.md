# Background Sessions

A background session is an ordinary xpi session that runs without a terminal. A daemon keeps it running in a
pseudo-terminal of its own, so it goes on after the terminal that started it closes. You list your sessions, read
their screens, reply to them, and attach to one to use its whole TUI, then detach and leave it running.

```bash
xpi --bg "run the tests and fix what fails"
xpi roost ls
xpi roost reply <id> "use pnpm, not npm"
xpi roost attach <id>
```

The built-in `roost` extension provides `--bg` and the session side; `xpi roost` is the command line. They need macOS
or Linux and the npm installation of xpi (see [Requirements](#requirements)). `-builtin:roost` in `extensions` turns
the extension off: then there is no `--bg`, and a session the daemon runs neither reports nor takes replies.

This version has `--bg` and the command line. The hub (an overview of the sessions inside xpi, `/agents` and
`xpi roost hub`) and handing a running session over with `/bg` come later.

## Start a session

```bash
xpi --bg "<task>"
xpi --bg "<task>" --bg-name "nightly tests"
```

`--bg` hands the task to the daemon as a new session in the current directory and exits. It prints the session's id
and how to reach it:

```
backgrounded · 3f9c2a1e · run the tests and fix what fails
  xpi roost attach 3f9c2a1e   open it (ctrl+z detaches)
  xpi roost logs 3f9c2a1e     its screen
  xpi roost stop 3f9c2a1e     stop it
  xpi roost ls --json         list all
```

The detach key shown is the one bound to `app.suspend` in your keybindings (`ctrl+z` by default; the action is named
when nothing is bound). The name defaults to the first six words of the task; `--bg-name` sets it. The session runs the same xpi with the
flags that choose its extensions and model (`-e`, `--no-extensions`, `--model`, `--provider`, `--thinking`,
`--session-dir`, `--offline`). `xpi --session <file> --bg "<task>"` continues that session in the background.

The session also gets this xpi's answer about the project folder's trust, as `--approve` or `--no-approve`, so it never
waits at the trust question where nobody sees it: answer the question (or pass `--approve`) when you run `xpi --bg`.
The answer is part of the session's command: every later start of that session (`respawn`, a reply to a finished
session, a restart after a crash) uses it without asking again, also an answer given for one run only. In a folder that
has nothing to trust yet, the session gets `--no-approve` unless you passed `--approve` or a decision is stored, so
project extensions that appear later do not load in it unasked.

The `roost` settings choose a new session's model, thinking level and environment; see [Settings](#settings).

The whole task is the value of `--bg`: quote it as one argument. For a task that starts with `-` or `@`, write
`--bg="<task>"`. Nothing else may be sent with it, because this xpi
would send it to the model itself before exiting, so `--bg` refuses other messages, `@file` arguments, `-p`, `--mode`
and redirected input or output (it needs a terminal). It also refuses `--no-session`: a background session needs a
session file. It does not start the daemon's session when roost cannot run here; it says why instead (see
[Requirements](#requirements)). Each of these stops xpi before anything starts.

## Work with sessions

| Command | What it does |
|---|---|
| `xpi roost ls [--all] [--cwd <dir>] [--json]` | List sessions: waiting first, then working, then ended ones (`--all` includes those ended over 48 hours ago) |
| `xpi roost logs <id\|name>` | Print the session's screen |
| `xpi roost log [-n <count>] [--follow] [<id\|name>]` | What happened lately: started, finished, waiting, replied, stopped |
| `xpi roost reply <id\|name> <text>` | Send a reply. A working session gets it as a follow-up once its turn ends; an idle one starts a turn |
| `xpi roost attach <id\|name>` | Open the session's TUI in this terminal |
| `xpi roost stop <id\|name>` / `rm <id\|name>` | Stop it; `rm` also deletes its record |
| `xpi roost respawn <id\|name>` | Start an ended session again |

A session is named by its id, a unique prefix of it, or its name. The full list, with the daemon's own commands, is in
[CLI](cli.md#background-session-commands).

A reply that is one of `/name <name>`, `/model <provider/id>`, `/thinking <level>` or `/compact` changes the session
at once instead of becoming a prompt. A reply to an ended session starts it again first.

## Attach and detach

`xpi roost attach` shows the session's own TUI, as it is now: its transcript, editor, dialogs and subagent panel. You
type into it as into any xpi session. Several terminals can attach to one session; the latest takes over.

While attached, the keys that would end or freeze the session detach instead, and the session keeps running:

| Key (default) | Keybinding | Detaches |
|---|---|---|
| `ctrl+z` | `app.suspend` | at once, also while a dialog is open |
| `ctrl+c` twice | `app.clear` | on the second press within a second; the first still clears the editor |
| `ctrl+d` twice | `app.exit` | on an empty editor; the first press says to press again |
| `left` | (fixed) | on an empty editor |
| `/quit` or `/exit`, submitted | | the editor is cleared |

They follow your [keybindings](keybindings.md): a rebound `app.suspend`, `app.clear` or `app.exit` detaches with the
new key. While a dialog is open only `app.suspend` detaches; the dialog keeps its other keys. xpi's own pickers
(`/tree`, `/resume`, the settings list) are not dialogs in this sense: while one is open, the left arrow (with the
editor empty) and a double `app.clear` detach too. To end a session, use `xpi roost stop`.

Attaching to an ended session starts it again first; one that failed is told to continue where it left off. When
something happened while nobody watched, a dim line in the transcript says what: turns finished, tools used, the last
question asked. It is not part of the model's context.

In fullscreen xpi, scrolling a session's transcript to its top loads the conversation from before its latest
compaction, a few messages at a time.

## Settings

The `roost` block of `settings.json` (see [Settings](settings.md#background-sessions)):

| Setting | Default | Applies to |
|---|---|---|
| `dispatchModel` | the session default | the model of a session `--bg` starts, unless the command line gives `--model` or `--provider` |
| `dispatchThinking` | the session default | its thinking level, unless the command line gives `--thinking` |
| `inheritEnv` | `true` | the session starts with this shell's environment; `false`: only the login basics, `LC_*` and `envAllowList` |
| `envAllowList` | `[]` | variables carried even when `inheritEnv` is off or `envDenyList` names them |
| `envDenyList` | `[]` | variables never carried; `"PREFIX*"` names a prefix |
| `workspaceEnv` | `"shell"` | the session directory's own environment on top: what its shell's cd hooks set (direnv, mise, fnm), `"direnv"` only, or `"off"` |
| `reapIdleMinutes` | `60` | a session idle, not attached and not pinned this long is stopped; it starts again on attach or reply |
| `cleanupDays` | `30` | records of sessions that ended this many days ago are removed (`0` keeps them) |

The environment keys are read from your own settings only: a project's `.pi/settings.json` cannot choose which of your
environment reaches its sessions. Whatever the lists say, a session gets the variables that say where its roost is,
so `xpi roost` inside it reaches the same daemon.

## Where things are

- **State**: `<agent dir>/xpi-roost/`: one directory per session in `jobs/` (its record, its state, its last screen,
  its command list), the order of the list, the event log and the daemon's log. The agent directory is `~/.pi/agent` unless `XPI_CODING_AGENT_DIR` says
  otherwise.
- **Sockets**: `$XDG_RUNTIME_DIR/xpi-roost-<key>` or `/tmp/xpi-roost-<uid>/<key>`, one per agent directory.
- **One daemon per agent directory**. It starts on demand with the first command that needs it and stops with
  `xpi roost daemon stop`. An xpi with another agent directory has a daemon and sessions of its own.

Each xpi session also holds a lock next to its session file (`<file>.lock`) while it is open, so the daemon never
starts a session on a file another xpi has open.

## Requirements

- **macOS or Linux.** On Windows `--bg` and `xpi roost` say background sessions are not supported (use WSL).
- **The npm installation of xpi** (`npm install -g xpi-coding-agent`). A standalone binary has no Node runtime for the
  daemon and says so.
- **node-pty**, an optional dependency installed with xpi. On Linux it compiles during the install and needs python3,
  make and a C++ compiler. Without it `--bg` and `xpi roost respawn` say how to reinstall it.

After an upgrade, a running daemon still has the old code: run `xpi roost daemon stop --keep-workers`, then
`xpi roost respawn --all`. Every command says so when the versions differ.

## Not there yet

- The hub: `/agents`, `xpi roost hub`, the left arrow that opens it.
- `/bg` and `/bg-fork`, which hand the running session (or a copy) to the daemon.
- Sessions resuming on their own after an interruption, schedules, and messages between sessions.
