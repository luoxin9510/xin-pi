# shadow-git

A private git history over a workspace that another version control system owns. This page covers the core (`xpi sg`),
the sync model, the adapters, sandboxes for parallel agents, and how xpi sessions use them (`builtin:shadow-git`:
`/sg`, hooks, the policy check in xpi's file tools, `isolation: "worktree"` and teammates).

## What it is

Agent tooling assumes git: cheap diffs, checkpoints, rollback, branches. Many development workspaces are owned by a
different version control system (the **host VCS**: any VCS that is not git), where commands are slow and verbose,
files may be read-only or links into a shared cache, and a `.git` directory is often not allowed.

shadow-git puts a git repository next to the workspace instead of inside it:

- The git directory lives in a store (`<agent dir>/shadow-git/<name>.git`) and its `core.worktree` names the workspace.
  Nothing is written into the workspace: no `.git`, no config, no marker files. The two exceptions are opt-in
  (`--gitfile` and `--agents-md`, below).
- The `host` branch receives only imports from the host. Its tip is the **sync point**, the last state the host and git
  agreed on. The `main` branch is where your work lands.
- Moving changes in and out is explicit: `xpi sg import` and `xpi sg export`. A small **adapter** script is the only
  code that talks to the host VCS, so xin-pi ships no support for any real VCS product. You write the adapter for yours.

Not in scope: remotes (the shadow repo is never pushed), a merge engine of its own (conflicts are resolved with plain
git), automatic check-in by agents (only you export), and managing work that leaves the machine.

## Set up with the plain adapter

The `plain` adapter treats another directory as the host. It is for trying shadow-git and for tests. The directory,
the **upstream**, holds a `.plainvcs/version` counter next to the files.

```bash
mkdir -p /proj/upstream/.plainvcs && echo 1 > /proj/upstream/.plainvcs/version
cp -R /proj/upstream/. /proj/ws                 # the workspace starts as a copy

cd /proj/ws
xpi sg init demo --adapter plain --config shadow.plain.upstream=/proj/upstream
xpi sg status
```

`init` registers the current directory, builds the shadow repo, writes the adapter's excludes and the host VCS's own
files (its `metadata`) to the repo's `info/exclude`, runs the adapter's `prepare` and commits the baseline on `host`
(`sg: baseline`). `main` starts at the same commit and is checked out.

Work with git as usual. Every subcommand `xpi sg` does not own goes to git on the shadow repo:

```bash
xpi sg status
xpi sg add -A && xpi sg commit -m "fix the parser"
xpi sg log --oneline
xpi sg export            # what would go to the host
xpi sg export --apply    # check it in through the adapter
xpi sg import            # bring the host's changes in
```

`xpi sg env` prints `export GIT_DIR=... GIT_WORK_TREE=...` for a shell that wants plain `git` (`eval "$(xpi sg env)"`).

`init` options:

| Option | Meaning |
|---|---|
| `--adapter <name>` | Required. Resolves to `sg-adapter-<name>` (see [Adapters](#adapters)). |
| `--scope <paths>` | Space-separated paths the adapter works on, relative to the workspace. Empty is the whole workspace. Only scoped paths and local-only paths are ever tracked. |
| `--local-only <glob>...` | Globs that are tracked in git but never exported (for example `AGENTS.md`, `.pi/`). A glob ending in `/` means everything below. They are git pathspec globs anchored at the workspace root. |
| `--config <key>=<value>` | A setting written to the shadow repo's config before the adapter runs (repeatable). |
| `--gitfile` | Write a `.git` file (`gitdir: <store>/<name>.git`) into the workspace and exclude it, so tools that look for a `.git` find the repo. Off by default; with `--agents-md`, one of the two things shadow-git ever puts in a workspace. |
| `--agents-md` | Write the [AGENTS.md template](#the-agentsmd-template) into the workspace, add `AGENTS.md` to the local-only globs, and commit it on `main` (never on `host`). Refused when an `AGENTS.md` exists. Off by default. |

`init` refuses (exit 2) a directory that is registered, or above or below a registered one, and a name already in use.
If the adapter fails during `init`, the half-built repo is removed.

Ignore build outputs and caches through the adapter's `excludes` or by editing `<store>/<name>.git/info/exclude`: an
untracked file that is not ignored makes the tree "dirty" and stops `import`, `export` and `merge`.

## Sync model

**Invariant:** `host` is always an ancestor of `main`. Import keeps it by merging; export keeps it by fast-forwarding
`host` to `main`.

```text
host:  baseline --- import 1 ----------- import 2 ----- (export moves host up to main)
                \                       \
main:            work --- work --------- merge host --- work
```

### Import

`xpi sg import` needs a clean work tree and takes the lock. It runs these steps:

1. Switch the workspace to `host` and write `<name>.git/SG_IMPORT`.
2. Run the adapter's `update` (it prints a one-line label). The adapter must leave the local-only paths alone.
3. Put the local-only paths back as they are on `host`, in case the update changed or deleted them. If the update created
   a file at a local-only path that `host` does not track, stop (exit 1): a host file collides with a local-only path.
   Rename one of them or change `shadow.localOnly`, then run `xpi sg import` again.
4. Commit what changed on `host` as `sg: import <label>` and remove `SG_IMPORT`.
5. Switch to `main`, print the files changed in both the import and your work since the last import, and
   `git merge host`.
6. A merge conflict stops the command (exit 1) with git's own state: resolve it with git, then
   `xpi sg merge --continue` (or `xpi sg merge --abort`).

**A stopped import** (a collision, a failed adapter, a crash) leaves `SG_IMPORT`, like git's own `MERGE_HEAD`, and
releases the lock. While it exists, `export` and `merge` refuse (exit 2) and `xpi sg status` shows it.
`xpi sg import` resumes: if the adapter's update had finished it continues at the commit, otherwise it runs `update`
again. If you left `host` during the stop, resuming needs a clean tree (exit 2 otherwise), so your edits are never
committed into `host`. `xpi sg import --abort` returns to the last host state: `git checkout -f host`, then
`git clean -fd` over the scope and the local-only paths, which **removes every untracked file created during the stop**
(with no `-x`, so ignored build outputs stay), then `git checkout main`. The record is removed only after that
checkout succeeds, so a failed abort can be run again.

### Export

`xpi sg export` prints the plan and changes nothing: `git diff --no-renames --name-status host..main` without the
local-only paths, with the subjects of the commits in `host..main` that touch an exported path (a commit that only
changes local-only paths, such as notes or `AGENTS.md`, is left out). A rename is a `D` and an `A`. It needs a clean tree
on `main` and the invariant (exit 2 otherwise). A path outside `shadow.scope` stops it (exit 2, with the list), because
the fast-forward would otherwise drop those paths from every later plan.

`xpi sg export --apply` takes the lock, gives the plan to the adapter's `checkin` with a message made from the commit
subjects, and on success fast-forwards `host` to `main`. If the adapter fails, git is unchanged (exit 1). Export is all
of `host..main`: to export part of the work, keep the rest on another branch.

After an export, `host` holds the local-only paths too, so `host` is "the host's state plus the local-only paths".

### Merge, lock and live sessions

`xpi sg merge <branch>` merges a branch into `main` under the lock (`main` checked out, a clean tree). It is for
branches that come from elsewhere, such as a sandbox's `sbx/<id>`. `xpi sg merge --continue|--abort` go to `git merge`, under
the same lock and live-session check.

Writes to the primary workspace (`import`, `export --apply`, `merge`) take `<store>/<name>.lock`, a file created
exclusively that holds the pid. A lock whose process is gone is taken over; a held one is waited for up to ten seconds
(then exit 2). They also refuse (exit 2) while another live xpi session is listed in `<store>/<name>.sessions/<pid>`,
since that session edits the primary workspace without the lock. Entries whose pid is not alive are dropped. xpi
sessions do not write these entries yet.

## CLI

| Command | Effect |
|---|---|
| `xpi sg init <name> --adapter <a> [--scope <paths>] [--local-only <glob>...] [--config <k>=<v>] [--gitfile]` | Register the current directory. |
| `xpi sg import [--abort]` | Import, resume a stopped import, or abort it. |
| `xpi sg export [--apply]` | Print the plan, or check it in and advance `host`. |
| `xpi sg status` | git status, commits ahead of `host`, a stopped import, live sessions, the adapter's `status`. |
| `xpi sg env` | Print `export GIT_DIR=... GIT_WORK_TREE=...`. |
| `xpi sg list` | Print the registry: `<workspace>\t<name>`. |
| `xpi sg agents-md` | Print the [AGENTS.md template](#the-agentsmd-template). Needs no registered workspace. |
| `xpi sg merge <branch>` | Merge a branch into `main`. |
| `xpi sg sbx create <id> [--from <branch>] [--profile <file>]` | Create a sandbox (see [Sandboxes](#sandboxes)). |
| `xpi sg sbx run <id> -- <command...>` | Run a command in a sandbox. |
| `xpi sg sbx ls` | List the sandboxes. |
| `xpi sg sbx rm <id> [--force]` | Remove a sandbox; its branch stays. |
| `xpi sg <git command> ...` | git on the shadow repo, with its exit code. |

`push`, `fetch`, `pull`, `clone`, `remote` and `submodule` exit 2: the shadow repo is local. The check skips git's
global options (`-c k=v`, `-C dir`, `--git-dir=...`) and looks at the command word. It is a guard rail, not
enforcement: a git alias or `xpi sg env` plus plain git gets around it.

The repo is the registered workspace with the longest path that contains the current directory; no match is exit 2.
`xpi sg --repo <name> <command>` (before the command) picks one by name.

Exit codes: 0 success, 1 a git or adapter failure (their stderr is shown as it is), 2 a failed precondition (a dirty
tree, a broken invariant, no repo, a git that is too old, a held lock, a live session).

### Configuration

The store and tools come from the environment:

| Variable | Default | Meaning |
|---|---|---|
| `XPI_SG_STORE` | `<agent dir>/shadow-git` | The store: the registry, the shadow repos and the locks. |
| `XPI_SG_GIT` | `git` on `PATH` | The git binary. It must be 2.20 or newer; older is exit 2 naming this variable. |
| `XPI_SG_ADAPTER_PATH` | `<store>/adapters` | Directories searched for adapters first, `:`-separated. |
| `XPI_SG_UNSHARE` | `unshare` | The program the `namespace` sandbox backend probes and runs. Tests set it to a missing file. |

Per-repo settings are git config keys in the shadow repo, edited with `xpi sg config ...`:

| Key | Meaning |
|---|---|
| `shadow.adapter` | The adapter name. |
| `shadow.scope` | Space-separated paths passed to the adapter. |
| `shadow.localOnly` (multi) | Local-only globs. `xpi sg config --add shadow.localOnly <glob>`. |
| `shadow.gitfile` | Whether `init` wrote the `.git` file. |
| `shadow.<adapter>.*` | Whatever the adapter reads, such as `shadow.plain.upstream`. |
| `sandbox.backend` | `auto` (default), `namespace` or `policy`. |
| `sandbox.require` | `namespace`: a sandbox command fails (exit 2) instead of falling back to `policy`. |
| `sandbox.rule` (multi) | Path rules, `<mode> <path>`. See [Path policy](#path-policy). |

The shadow repo sets `extensions.worktreeConfig` and `core.repositoryformatversion = 1`, and keeps `core.worktree` in
`config.worktree` of the main worktree, so linked worktrees (sandboxes) have their own.

## Adapters

An adapter is an executable named `sg-adapter-<name>`. shadow-git looks for it in `XPI_SG_ADAPTER_PATH`, then in the
adapters shipped with xpi (the two below), then on `PATH`. It is called as `sg-adapter-<name> <op> [args]` with the
workspace root as its cwd and these variables set: `XPI_SG_WORKSPACE` (absolute path), `XPI_SG_SCOPE` and
`XPI_SG_LOCAL_ONLY` (space-separated; the adapter must never change or delete a local-only path), `XPI_SG_GIT_DIR` (the
shadow repo, for settings and the tracked file list) and `XPI_SG_GIT` (the git binary). `GIT_DIR` and `GIT_WORK_TREE`
are not passed on. A non-zero exit is a failure and its stderr is shown unchanged. Paths are relative to the workspace
root. The local-only globs are git pathspec globs (`:(glob)`): `*` does not cross a `/`, and `**/x` also matches a root
`x`. Shell `case` patterns differ on both points, so an adapter should not match them itself; the plain adapter asks git
(a scratch index of the candidate paths and `git ls-files -- ':(glob)<glob>'`).

| Op | Input | Output (stdout) | Contract |
|---|---|---|---|
| `metadata` | | One path per line | The host VCS's own files and directories, **relative to the workspace root only**: every line is anchored to the root. Never tracked; hidden in sandboxes. |
| `excludes` | | One gitignore pattern per line | Other paths git must never track: build outputs, caches, and any host VCS name that repeats in every directory (a pattern such as `.hostvcs-meta/`, not a root path). |
| `prepare` | | | Afterwards every in-scope file is a writable regular file. |
| `update` | | A one-line label | Bring the workspace to the latest host state within the scope. |
| `checkin` | stdin: `A\|M\|D<TAB>path` lines; `--message-file <f>` | | Check in exactly these changes as one host operation, or fail with no partial effect where the host allows it. |
| `status` | | Free text, at most 20 lines | A short summary of the host side. |

The package ships two adapters, both POSIX `sh`:

- **`sg-adapter-plain`**: the directory in `shadow.plain.upstream` is the host. `update` copies the upstream into the
  workspace and removes files that `host` tracked and the upstream no longer has, except local-only paths. `checkin`
  checks every listed file first, then copies them into the upstream, bumps the version and appends the message to
  `.plainvcs/log`. File names with a newline are not supported.
- **`sg-adapter-template`**: every op with comments on its contract and the questions a writer has to answer for their
  VCS, such as which names the VCS puts in a workspace, how to make files writable without breaking a shared cache, and
  whether a check-in needs a lock first. It fails every op that needs a decision, so it cannot be used by accident.
  Copy it to `sg-adapter-<yourname>`, fill it in, and put it in `XPI_SG_ADAPTER_PATH`.

Adapters for real host VCSs are written by their users and are not part of xin-pi.

## Sandboxes

Several agents can work on one workspace when each has its own copy of the files it changes. A sandbox is a private git
worktree plus a path policy that decides, path by path, what a sandboxed command sees and may write.

- The primary workspace is read-only to every sandbox. Only `import`, `export --apply` and `merge` write it, under the
  lock.
- `<store>/<name>.sbx/<id>/tree/` is a git worktree on branch `sbx/<id>`, made from `main` (or `--from <branch>`). Its
  `.git` file is in the store, not the workspace. Each sandbox has its own index and branch, so sandboxes commit in
  parallel.
- Work leaves a sandbox only as commits on `sbx/<id>`. You run `xpi sg merge sbx/<id>`, then `xpi sg export`.

```bash
xpi sg sbx create fix-parser                 # a worktree on sbx/fix-parser, from main
xpi sg sbx run fix-parser -- sh              # a shell in it
xpi sg sbx run fix-parser -- ./run-tests.sh  # any command: a test, a build, an agent
xpi sg sbx ls                                # branch, commits ahead of main, changed files, backend
xpi sg merge sbx/fix-parser                  # you, in the primary workspace
xpi sg sbx rm fix-parser                     # the branch stays
```

`sbx ls` and `status` list a sandbox that cannot be opened (its tree or policy is missing or unreadable) as
`<id>  broken: <reason>` and go on; `sbx rm <id> --force` removes it. `sbx rm` stops (exit 2) when the sandbox has uncommitted changes; `--force` removes it anyway. `sbx create` is refused
(exit 2) while an import is stopped (`SG_IMPORT`), and the id must not be one of `tree`, `scratch`, `primary`,
`policy`, `links`, `excludes`. `xpi sg status` lists the sandboxes.

### Path policy

Rules are git config values, `sandbox.rule = <mode> <path>`, set with `xpi sg config --add sandbox.rule "<mode> <path>"`.
`@ws` is the primary workspace root (`@ws/build` is a path under it); an absolute path inside the workspace is the same
as `@ws/...`; any other absolute path is outside it. The longest matching prefix wins; among rules of the same length
the later one does. `xpi sg sbx create --profile <file>` reads the rules from a git-config file (`[sandbox]`,
`rule = ...`) **instead of** the repo's. The rules are copied into the sandbox when it is created.

| Mode | A sandboxed command sees | It may write | Typical use |
|---|---|---|---|
| `private` | Its own copy | Yes | Source the agent changes |
| `shared-ro` | The primary file | No | Shared libraries, test suites, tool installs |
| `shared-rw` | The primary file | Yes, visible to every sandbox | Shared caches, only when listed |
| `scratch` | An empty per-sandbox directory | Yes | Build and test output |
| `hidden` | Nothing | No | Host VCS metadata, other users' areas, credentials |

**Defaults, when no rule matches:**

- Paths the shadow repo tracks are `private`.
- Other paths under `@ws` are `shared-ro`: read from the primary workspace, so shared scripts and test suites work
  unchanged.
- The adapter's `metadata` paths are `hidden`. A rule of the same length or a longer one overrides this; a shorter one
  (`shared-ro @ws`) does not unhide them.
- Paths outside `@ws` are `shared-ro`.
- Writes are denied unless the mode is `private`, `scratch` or `shared-rw`.

Checks at `sbx create` (exit 2, nothing is created):

- A `scratch`, `hidden` or `shared-rw` rule that covers tracked files is an error. It would hide the agent's own files,
  or leave them out of the share. A `shared-ro` rule over tracked files is allowed: the policy then refuses writes to
  them.
- A `scratch` path must be under `@ws`. A `private` rule needs no setup: a path starts with what git tracks.
- A rule needs a mode and a path (`@ws`, `@ws/<path>` or absolute), with no `.` or `..`.

### The sandbox tree

Both backends start from the same tree:

- The worktree holds the tracked files, as the sandbox's own copies.
- `<store>/<name>.sbx/<id>/primary` is the sandbox's view of the primary workspace: a symlink to it under `policy`, a
  read-only bind mount under `namespace`. Every link in the tree points into `primary`, never at the workspace's own
  path, which the `namespace` backend covers with the tree.
- Every untracked, not-hidden entry of the primary workspace is a symlink in the tree to `primary/<path>`. A directory
  with no tracked files below it is one link, so the number of links stays small. The links are refreshed whenever
  `sbx run` starts, so a file that appeared in the primary since is there.
- A `scratch` path is a link to `<store>/<name>.sbx/<id>/scratch/<path>`.
- A `shared-rw` path under `@ws` is a link to the workspace path under `policy`, and a read-write bind of it at its
  place in the tree under `namespace`.
- The links and mount points are listed in the worktree's own `core.excludesFile` (through
  `extensions.worktreeConfig`), so they never show in the sandbox's `git status`. An untracked file the agent makes in a
  directory that would be a link keeps the directory real, and its other entries become links.

### Backends

`sandbox.backend` is `auto` (the default), `namespace` or `policy`. `auto` checks that
`unshare --user --map-root-user --mount --pid --fork --mount-proc` works (and that `mount` and `findmnt` exist), once per command, uses
`namespace` if it does and `policy` if not, and prints which on stderr. With `sandbox.require = namespace` a failed
check is exit 2, as is `sandbox.backend = namespace`. macOS has `policy` only.

**`namespace`** (Linux). `sbx run` runs the command in a new user, mount and pid namespace (with its own `/proc`)
through a small `sh` script. The pid namespace matters: without it `/proc/<pid>/root` of a process outside would reach
the primary workspace through the host's mount namespace. Every mount point exists before `unshare`. The mount order is fixed:

1. The workspace is bound (`--rbind`) at `primary` and remounted read-only.
2. `hidden` paths are covered, inside `primary` too: an empty read-only `tmpfs` over a directory, `/dev/null` over a file.
3. `shared-rw` paths are bound read-write at their place in the tree.
4. The tree is bound (`--rbind`, so the binds from step 3 come along) over the workspace's own path. Inside the
   sandbox `/proj/ws` shows the agent's files, so scripts that hard-code the workspace path work unchanged.
5. `shared-ro` rules for absolute paths outside the workspace are bound read-only over themselves, and `hidden`
   absolute paths are covered.
6. The shadow repo's `config`, `config.worktree`, `hooks/`, `info/` and `worktrees/` are bound read-only. The sandbox's
   own `worktrees/<id>` (HEAD, index, logs) stays writable, but its `commondir`, `gitdir` and `config.worktree` are
   read-only again: a `commondir` pointed at a directory of the sandbox's own would make git read that directory's
   config.
7. `<name>.sbx` is bound read-only, so other sandboxes' trees and files cannot be written, with this sandbox's `tree`
   and `scratch` writable. A changed config or a hook would run as your own commands later (a `core.fsmonitor`, a filter
   driver, a hook). Refs and objects stay writable: that is how a sandbox commits. `sbx` creates the `hooks/`
   directory if it is missing, so it can be covered.

A read-only remount in a user namespace fails unless it repeats the flags the mount was locked with (`nosuid`, `nodev`,
`noexec` and the access-time flags). Steps 1 and 5 read them with `findmnt -no OPTIONS` and pass them again. Recent
`mount` programs do it themselves; older ones need it. A failed setup step (also the final `cd`) ends the command with
exit 125 and a message. The command starts in the workspace's path, and its environment has `GIT_WORK_TREE` set to it.

Outside the workspace and the listed paths the filesystem keeps its normal permissions: a fully read-only system would
break xpi's own session files, the home directory and temp files.

**`policy`** (any platform; the only one on macOS). It needs nothing installed:

- The command runs with the tree as its working directory, and `GIT_WORK_TREE` is the tree. Absolute paths into the
  primary workspace reach the primary files.
- The path policy is a function of the package: `sandboxPolicy(sandbox, absolutePath)` returns the mode and whether
  reading and writing are allowed. It checks real paths (the parent directory's for a new file), so a write through a
  link into `primary` is a write to the primary file and is denied. The xpi integration enforces it in its file tools
  (`read`, `write`, `edit`, and the read check for `grep`, `find` and `ls`); see [Agents in xpi](#agents-in-xpi).
- `bash` is advisory. Nothing stops a shell command from writing a primary file. A command that must be held to the
  rules should run under `namespace`.

### `sbx run`

`xpi sg sbx run <id> -- <command...>` runs the command with these variables, which always replace values the parent
passed down (so a `GIT_DIR` from another repository cannot leak in):

| Variable | Value |
|---|---|
| `XPI_SG_SANDBOX` | `<name>/<id>` |
| `GIT_DIR` | `<store>/<name>.git/worktrees/<id>` |
| `GIT_WORK_TREE` | the tree (`policy`) or the workspace's path (`namespace`) |
| `XPI_SG_BACKEND` | `namespace` or `policy` |
| `XPI_SG_STORE` | the store, so `xpi sg` inside finds it |

`sbx run` takes a per-sandbox lock (`<id>/lock`) while it refreshes the links, so two runs of one sandbox do not race.
Links that are right stay as they are. Its exit code is the command's. Inside, `git` works on the sandbox: its own index, branch and commits. `xpi sg
<git command>` does too, and `xpi sg import`, `merge`, `export --apply`, `init` and `sbx create|rm|run` are refused (exit 2), as is `--repo` for another repo:
a sandbox does not write the primary workspace and sandboxes do not nest. This refusal depends on `XPI_SG_SANDBOX`
being set; it is a guard rail, not enforcement (see the limits). Several `sbx run` of one sandbox at once
share its tree; start another sandbox for work that must not mix.

### Commands that send work elsewhere

Some build and test tools send work to other machines, such as through a job scheduler or a remote build service. That
work runs outside the sandbox. The sandbox does not manage what it reads or changes and has no special support for it.
Results it writes back into the workspace are the user's to handle.

## The AGENTS.md template

xpi's prompt already tells agents the rules (see [Agents in xpi](#agents-in-xpi)). The template adds what only you can
say about a workspace, and how to work for the host:

- Commit small, with subjects written as host check-in comments, because `export --apply` joins the subjects into the
  check-in message.
- Write build and test output to scratch paths, never into tracked directories.
- In a sandbox, commit on `sbx/<id>` and stop; the user merges.
- Places to fill in: the host VCS's write commands (and matching `shadow.blockCommand` regexes), how to build and
  test, the scratch paths, and the shared paths that must not change.

`xpi sg init ... --agents-md` writes it for a new workspace as a local-only file. For an existing workspace, or for
another tool's instructions file:

```bash
xpi sg agents-md > AGENTS.md            # or > CLAUDE.md
xpi sg config --add shadow.localOnly AGENTS.md
xpi sg add AGENTS.md && xpi sg commit -m "sg: add AGENTS.md (local-only)"
```

The file sits in the workspace, so the host VCS sees it as an unknown file. If that matters, ignore it on the host
side. Other tools than xpi need `eval "$(xpi sg env)"` before git reaches the shadow repo; the template says so.

## Agents in xpi

`builtin:shadow-git` wires all of this into xpi sessions. It is on by default and off with `-builtin:shadow-git`. It
acts only when the session's cwd is in a registered workspace (the **primary**) or `XPI_SG_SANDBOX` is set (inside a
**sandbox**); its handlers do nothing elsewhere, so xpi behaves as without it. The cwd is read at each session start,
from the session itself: a session resumed from another directory (`/resume`, `--session`) is judged by that
directory. A session in the primary workspace edits it like
any checkout: the user is present and commits on `main`. Sandboxes are for the agents the user is not watching.

### In the primary workspace

- **git with no setup.** The extension sets `GIT_DIR` and `GIT_WORK_TREE` in xpi's own environment, so `bash`, `!`
  commands, MCP servers and subagents inherit them, and xpi's own git features (`/commit`, `/review`) use the shadow
  repo. When the session moves to a directory that is not in a workspace, the values from before are restored (and
  its live entry removed); moving into one sets them and writes the entry. A sandboxed child replaces them with its own. Features that read a `.git` path on disk see nothing unless
  `--gitfile` was used. A git command run anywhere in the session reaches the shadow repo, even after `cd` to another
  repository.
- **Live session entry.** A top-level session (not a subagent child, not sandboxed) writes `<name>.sessions/<pid>` and
  removes it at session shutdown and at process exit; a `/reload` leaves one entry. `xpi sg import`, `export --apply`
  and `merge` read these entries and refuse while another live session is listed, because it edits the workspace
  without the lock.
- **A stopped import.** While `SG_IMPORT` exists, a session started in the workspace shows an error notice and blocks
  every tool call, with the reason `run xpi sg import to resume it or xpi sg import --abort`. Extensions cannot end
  startup, so the session stays open for the user to read the message. A blocked session holds no live entry (otherwise
  the resume would refuse); once the import is settled, tool calls work again and the entry is written.
- **`/sg`.** Typed by the user; the model cannot run slash commands. It runs the core in process and prints its output:

  | Command | Runs |
  | --- | --- |
  | `/sg import [--abort]` | `xpi sg import [--abort]` |
  | `/sg export [--apply]` | `xpi sg export [--apply]` |
  | `/sg merge <branch>` (or `--continue`, `--abort`) | `xpi sg merge ...` |
  | `/sg status` | `xpi sg status` |
  | `/sg sbx ls` | `xpi sg sbx ls` |

  The commands that write the workspace (`import`, `export --apply`, `merge`) follow the core's rules and run only when no
  other live session is listed and none of this session's agents works in the primary: the main agent, and subagents or
  teammates that have no sandbox, and running background codemode scripts (their agents may write the workspace).
  Otherwise they say which. A background `bash` job that the model started and left running cannot be tracked: it is
  not seen, so wait for it before importing. The read-only ones (`status`, `export`, `sbx ls`) always
  run. `xpi sg` in a terminal does everything else (`init`, `sbx create`, `sbx rm`, `config`, any git command).
- **Blocked for agents.** A `tool_call` hook on `bash`, `powershell` and any other tool whose input has a string `command` blocks, with a one-line reason: `xpi sg` (and a bare `sg`, in case
  of an alias, also inside another command such as `xpi sg sbx run s -- xpi sg merge b`) with `import`, `merge`, `export ... --apply` or `sbx create|rm`; any `sg-adapter-*`; and every
  `shadow.blockCommand` regex (`xpi sg config --add shadow.blockCommand '\bhostvcs (submit|sync)\b'`; an invalid regex is
  reported and ignored). `xpi sg status`, `xpi sg export` (the plan), `xpi sg sbx ls`, `sbx run` and git pass-through are
  allowed. The hook searches the command text; it is a guard rail against an agent that does not try to get around it,
  not a shell parser. It also matches the words inside quotes (`echo "xpi sg import"` is blocked). A bare `sg` is a
  different system command on Linux, so the prompt and these docs always say `xpi sg`.
- **Order.** `shadow-git` is the first built-in extension: its `session_start` sets the environment, and the `session_start` of the ones after it (`mcp` starting servers, for example) already sees it.
- **Prompt.** A short paragraph (one section, the same every turn) says that a host VCS owns the workspace, that agents
  never call it to write, that `xpi sg export` shows the user what is pending, and to write `xpi sg`, never `sg`.

### Inside a sandbox

A session started with `xpi sg sbx run <id> -- xpi`, or a subagent or teammate that xpi started in a sandbox (below),
has `XPI_SG_SANDBOX` set. It registers no `/sg` and no live entry.

- **Policy check in the file tools.** `read`, `write` and `edit` check each path with the sandbox's path policy, by
  the real path (a new file by its parent directory's), and refuse a denied one with a one-line reason. So a write
  through a link into `primary` is refused, and a hidden path (the adapter's `metadata`) cannot be read. `grep`, `find`
  and `ls` get the read check for the path they are given (their default, the working directory, is the sandbox's own
  tree). Paths of other schemes (`name://...`) are not files and are not checked. A codemode script's calls to these
  tools pass through the same hook.
- **Paths that are always writable.** Under the policy, paths outside `@ws` are `shared-ro` by default, which would stop
  xpi itself. These are always writable, whatever the rules say, and only these:
  - the session's own directory (a subagent's session is below its parent's);
  - the system's temp directory (`os.tmpdir()`);
  - the agent's own memory directory, which the subagent runner passes in `XPI_SUBAGENT_MEMORY_DIR` (so another agent's
    memory is refused: it could plant instructions for it). Project-scope memory (`<workspace>/.claude/agent-memory`) is in
    the primary workspace, so a sandboxed agent's writes to it are refused too;
    the runner leaves the variable out for a read-only memory, and, inside a sandbox, for a child whose memory directory is not the
    one this process received or below it (an agent file written in the sandbox cannot name another agent's memory);
  - the sandbox's own `scratch` and `tree` (already writable by the policy).

  xpi's agent directory as a whole is not on the list: `settings.json`, `auth.json` and `extensions/` there are read by
  the next session that is not sandboxed. Three things stay refused even inside the listed directories: the **store**
  (it holds the shadow repo, the registry and every other sandbox), the **primary workspace** and the sandbox's
  `primary` link (the workspace may itself sit under the temp directory). The check is for the file tools only. A
  `bash` command is held by nothing under `policy`.
- **Scheme paths are refused.** A path like `name://x` is resolved by the host's schemes, which can locate a file
  anywhere, so the check cannot judge it; the file tools refuse it in a sandbox. A path that only contains `://` after a
  directory (`/ws/x://y`) is an ordinary path and is checked.
- **`bash` stays advisory.** The prompt states the rules and the same block list as in the primary applies. Under
  `namespace` the mounts enforce what `bash` does.
- **Prompt.** One paragraph: the agent is in sandbox `<name>/<id>`, the primary is read-only, its work only counts as
  commits on `sbx/<id>`, it never calls the host VCS, and under `policy` that `bash` is not sandboxed.
- **A sandbox that cannot be opened** (`XPI_SG_SANDBOX` names one that is missing or fails its checks) blocks every tool
  call.
- **No nesting.** `isolation: "worktree"` and teammates (which would each get a sandbox) are refused inside a sandbox,
  with the message "sandboxes do not nest".

### Isolation and teammates

In a registered workspace the `Agent` tool's `isolation: "worktree"` makes a shadow-git sandbox instead of a git worktree
under `.pi/worktrees` (nothing is put in the workspace):

- The sandbox is `sub-<agentId>`, on branch `sbx/sub-<agentId>`, made from the primary's current branch. The child
  process runs in it through the backend that `auto` chooses, the same way `xpi sg sbx run` runs a command: its cwd is
  the sandbox's tree (under `namespace`, the workspace's own path) plus the directory the parent was in, when the commit
  has it, and it has the same `XPI_SG_*`, `GIT_DIR` and `GIT_WORK_TREE`. Uncommitted changes of the primary are not in
  the sandbox (the result carries a warning).
- When the child ends with no commits and no changes, the sandbox and its branch are removed. Otherwise both are kept,
  and the result names the branch and says that the user merges it with `/sg merge sbx/sub-<agentId>`. A resume runs in
  the same sandbox.
- `/subagents worktrees` lists and removes these sandboxes too (the ones xpi made: `sub-*` and `team-*`; yours are left
  alone). Removing one deletes its branch as well, as for a worktree.
- The meta file of the agent records `kind: "shadow-git"` with the repo name, the sandbox id and the backend.
- **Teammates** (agent teams): in a registered workspace each teammate gets the sandbox `team-<name>` the same way, kept
  after it stops when it holds work. Running several agents on one workspace is what the sandbox is for: without one,
  teammates would write the same files. A new teammate whose sandbox `team-<name>` still exists from an earlier one is
  refused with a message (merge and remove the old one, or choose another name). Elsewhere teams are unchanged.

## Limits

- **git environment.** `xpi sg env` makes `GIT_DIR` and `GIT_WORK_TREE` point at the shadow repo for that shell. Every git
  command in that shell then reaches the shadow repo, even after `cd` to another repository. Prefer `xpi sg <git
  command>`, which sets them for one command only. Without them, `git` in the workspace finds no repository (unless
  you used `--gitfile`).
- **Modification times.** Switching branches rewrites the modification times of the files it changes, and an import
  switches to `host` and back. Build tools that compare modification times rebuild those files.
- **A clean tree is required** for `import`, `export` and `merge`, including no untracked files that are not ignored.
- **Local-only globs** are git pathspec globs from the workspace root, so `AGENTS.md` matches only the root file. They
  cannot contain spaces, because the adapter receives them space-separated.
- **Sandbox policy is advisory outside a namespace.** Under `policy`, a shell command can write a primary file; only
  xpi's own file tools refuse a denied path. `namespace` enforces it with mounts, for everything but the writable
  submounts below.
- **The bash block list is a guard rail.** It searches command text, so a command built at run time, or a program the
  agent writes and runs, is not caught.
- **The always-writable paths.** The session directory, the temp directory and the agent's own memory directory are writable
  from a sandboxed session's file tools, so a sandboxed agent can change other sessions' files there and anything in
  the temp directory that other programs read. Under `namespace`, ordinary file permissions apply everywhere
  outside the workspace, the store and the listed mounts, for `bash` as well.
- **Stopped import.** A session started while an import is stopped cannot be refused cleanly (an extension cannot end
  startup): it opens, shows the error and blocks its tool calls.
- **Root in the namespace.** The command runs as root inside the namespace, with the user's own uid outside. Files owned
  by other users show as `nobody`, setuid programs do not work, and some tools refuse to run as root. For those,
  `policy` is the way.
- **The git directory is shared.** Refs are shared, so a sandbox can move `main` or any other branch (and write
  `HEAD`), and can rewrite objects it can reach. It can also write the main worktree's `index` and a stopped
  import's `SG_IMPORT` record, which steers where `import --abort` returns; check `xpi sg status` before you abort. `namespace` makes `config`, `hooks/` and `info/` read-only (step 6),
  which keeps a sandbox from planting something your own commands then run. Under `policy` the git directory is fully
  writable. Under `policy` a sandbox can write its own `worktrees/<id>/commondir` or `config.worktree` (or another
  sandbox's) so that git, run later from outside, reads a config with a `filter` driver. The commands `xpi sg` runs
  on a sandbox's tree from outside (`sbx ls`, `status`, `rm`, `run`) therefore check first that `commondir` is still
  `../..` and `config.worktree` holds only `core.excludesFile`; if not, the sandbox is listed as
  `broken: commondir changed` (or `config.worktree changed`) and no git runs in it. `sbx rm --force` removes it
  without running git on its tree. Plain git that you start by hand inside a sandbox's tree is not checked. Only `core.hooksPath` and `core.fsmonitor` are switched off in the commands
  `xpi sg` runs itself (`sbx ls`, `status`). Read a sandbox's work with `git diff` in the sandbox before you trust its
  attributes and config.
- **The in-sandbox refusal is a guard rail.** Inside a sandbox `xpi sg import`, `merge` and the like exit 2 because
  `XPI_SG_SANDBOX` is set; a command that unsets it, or plain `git` with another `GIT_DIR`, is not stopped under
  `policy`.
- **A container may not allow the namespace backend.** Container runtimes mask parts of `/proc`, and then a fresh
  `/proc` cannot be mounted: the probe fails and `auto` uses `policy`. Start the container with those paths unmasked
  (and seccomp and AppArmor unconfined) to use `namespace` there.
- **Writable submounts.** The read-only remount covers the mount at `primary`, not mounts inside the workspace
  (`--rbind` brings submounts along as they were), so a submount that is writable stays writable there.
- **The global excludes file does not apply in a sandbox.** The sandbox's own `core.excludesFile` (the link list)
  replaces the user's global one for that worktree. `info/exclude` of the shadow repo still applies, and `.gitignore`
  files do.
- **Live-session check.** The check reads `<store>/<name>.sessions`, which top-level xpi sessions in the primary write.
  A session that runs with `-builtin:shadow-git`, or another harness that does not write entries, is not seen.
- **`shared-ro` over tracked files** is enforced by the policy only; the namespace does not mount over them.
- **A sandbox's links are a snapshot of one moment.** They are refreshed when `sbx run` starts, not while it runs.
- **Standalone binary.** The shipped adapters are files next to the binary; if you move the binary alone, put them in
  `XPI_SG_ADAPTER_PATH`.
