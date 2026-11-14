# 01: shadow-git

Status: done. PRs #95 (spec), #96 core, #97 sandboxes, #98 xpi integration, #99 wrap-up.

Approval: approved by the owner on 2026-11-14 ("是"), with both owner questions as recommended (decisions 18 and
19). It had six rounds of independent review (one review and five delta checks); the last found nothing blocking or
should-fix.

## Problem

Agent tooling assumes git. It wants cheap diffs, checkpoints, rollback, branches and worktrees. xpi's own features do
too: `isolation: "worktree"`, `/commit`, `/review`, and the footer's branch.

Many development workspaces are owned by another version control system (the **host VCS** here: any VCS that is not
git). Host commands are often slow and verbose, and files may be read-only or links into a shared cache. Putting a
`.git` directory into such a workspace is often not allowed, and the host VCS would see it.

A second need comes with it. Several agents should be able to work on one workspace at once. Each needs its own copy of
the files it changes. Shared scripts and test suites must keep reading the files they read today.

## Goals

- Agents get a normal git interface over an unmodified host workspace.
- Nothing is placed in the workspace: no `.git`, no config, no marker files. The one exception is opt-in
  (`shadow.gitfile`).
- Any host VCS works through a small adapter. xin-pi ships no adapter for a real VCS product.
- The boundary between agent work and host check-ins is an explicit sync point.
- Many agents work in parallel on one workspace, each in a sandbox, with few dependencies.

## Non-goals

- **No remote.** The shadow repo is local to one user and is never pushed.
- **No two-way merge engine.** Conflicts between host updates and local work are resolved by the user with plain git.
- **Not a replacement for the host VCS**, which stays the system of record.
- **No automatic check-in by agents.** Only the user checks in.
- **No management of work that leaves the machine** (decision 16; see [Commands that send work elsewhere](#commands-that-send-work-elsewhere)).

## Facts this builds on

Paths are under `packages/xpi-coding-agent/src/` unless stated.

- **Subcommands.** `main.ts` dispatches `xpi roost` and `xpi mcp` before argument parsing (`if (args[0] === "roost")`).
  `xpi sg` goes next to them.
- **Built-in extensions** are listed in `extensions/index.ts` (`builtin:subagent`, `builtin:relay`, `builtin:mcp`) and
  can be disabled with `-builtin:<name>`.
- **Worktree isolation** is `extensions/subagent/worktree.ts`:
  - `planWorktree(cwd, agentId)` finds the git root with `git rev-parse --show-toplevel` and places the worktree at
    `<root>/.pi/worktrees/<agentId>` on branch `subagent/<agentId>`.
  - `ensureWorktree`, `settleWorktree`, `removeWorktree`, `listWorktrees` create, settle and list them.
  - `addExclude` writes to `info/exclude`. `.worktreeinclude` copies ignored files in.
  - In a shadow-git workspace today, `planWorktree` fails (no `.git`). With `GIT_DIR` and `GIT_WORK_TREE` set it would
    succeed and put the worktree inside the workspace, which this spec forbids.
- **Agent teams.** A teammate is never isolated: a named call with `isolation` is a plain subagent
  (`extensions/subagent/agent-tool.ts`).
- **Hooks.** A `tool_call` handler can return `{ block: true, reason }` (`docs/extensions.md`). `before_agent_start`
  can change the system prompt.
- **git.** `GIT_DIR` and `GIT_WORK_TREE` are honoured by every git command. `core.worktree` in a git dir names its
  work tree. `extensions.worktreeConfig` (git 2.20) gives each linked worktree its own config, such as its own
  `core.excludesFile`.
- **Linux namespaces.** `unshare` and `mount` are in util-linux, which is part of the base system on Linux
  distributions. `unshare --user --map-root-user --mount` needs unprivileged user namespaces. Some systems turn them
  off with a sysctl or a security module, and some distributions restrict them by default, which can affect CI runners.
- **git and `core.worktree`.** With `extensions.worktreeConfig` on, a `core.worktree` in the shared `config` applies to
  every linked worktree. It must live in the main worktree's `config.worktree` instead (with
  `core.repositoryformatversion = 1`). A per-worktree `core.excludesFile` replaces the user's global excludes file for
  that worktree; `info/exclude` still applies.

## Decisions (`decisions.md`)

Grill 1–3 are recorded there with the owner's words. They are referenced below by number.

## Solution

### Where it lives (decisions 1, 2, 8)

- **`packages/xpi-shadow-git`**: the core, in TypeScript. Its only runtime dependencies are Node and the `git` binary.
  It exports the library used by the CLI and the extension, and contains the `adapters/` directory (below).
- **`xpi sg <cmd>`**: dispatched in `main.ts` next to `roost`. It loads the core lazily, so it costs nothing elsewhere.
- **`builtin:shadow-git`**: the extension. When the cwd is not in a registered workspace and xpi is not in a sandbox,
  it registers nothing, so xpi behaves exactly as today.

### Concepts

| Term | Meaning |
| --- | --- |
| Host VCS | The version control system that owns the workspace. |
| Workspace | The host-owned directory tree. shadow-git writes no metadata into it. |
| Shadow repo | A git dir at `<store>/<name>.git` whose `core.worktree` is the workspace. |
| Adapter | A small executable that implements the host interface for one host VCS. |
| `host` branch | Receives only import commits. Its tip is the **sync point**: the last state the host and git agreed on. |
| `main` branch | Where the user's and agents' work lands. The default checkout. |
| Import | Bring host changes into `host`, then merge them into `main`. |
| Export | Hand the changes in `host..main` to the host through the adapter's check-in. |
| Primary workspace | The workspace itself, as opposed to a sandbox's copy. |
| Sandbox | A git worktree on branch `sbx/<id>` plus a path policy (below). |

### Layout and configuration (decision 17)

Everything lives under one store directory. The workspace is referenced only by absolute path.

```
<store>/
  registry                  # one line per workspace: <absolute path>\t<name>
  adapters/                 # searched for adapters before PATH
  <name>.git/               # the shadow repo (GIT_DIR); config holds core.worktree and shadow.* keys
  <name>.lock               # lock for writes to the primary workspace
  <name>.sbx/<id>/tree/     # a sandbox's worktree
  <name>.sbx/<id>/scratch/  # a sandbox's scratch area
```

- **Resolving the repo.** The longest registry path that contains the cwd wins. No match is exit 2. `--repo <name>`
  overrides it.
- **The lock** is a file created exclusively, holding the pid and time, taken over when stale. It uses the same rules
  as the team locks (`extensions/subagent/team-files.ts`). Node has no `flock`.
- **Live sessions.** A top-level xpi session in the primary workspace writes `<name>.sessions/<pid>` and removes it at
  exit. Sandboxed sessions and subagent processes do not, since they never write the primary. Entries whose pid is
  not alive are dropped. `import`, `export --apply` and `merge` exit 2 while another live session is listed, since it
  edits the primary without the lock. From inside a session, `/sg` runs them only when no other session is listed and
  none of its own agents is working in the primary (the main agent, and subagents and teammates without a
  sandbox).
- **Environment.**

  | Variable | Default | Meaning |
  | --- | --- | --- |
  | `XPI_SG_STORE` | `<agent dir>/shadow-git` | The store. |
  | `XPI_SG_GIT` | `git` on `PATH` | The git binary. It must be 2.20 or newer; older is an error naming this variable. |
  | `XPI_SG_ADAPTER_PATH` | `<store>/adapters` | Extra directories searched for adapters before `PATH`. |

- **Config keys**, stored in the shadow repo with `git config`:

  | Key | Example | Meaning |
  | --- | --- | --- |
  | `core.worktree` | `/proj/ws` | The workspace root. Kept in `config.worktree` of the main worktree (see Facts), so linked worktrees keep their own. |
  | `shadow.adapter` | `plain` | The adapter; resolves to `sg-adapter-<name>`. |
  | `shadow.scope` | `src/ test/` | Optional paths passed to the adapter. Empty is the whole workspace. |
  | `shadow.localOnly` (multi) | `AGENTS.md`, `.pi/` | Globs tracked in git but never exported. |
  | `shadow.blockCommand` (multi) | a regex | Host VCS write commands agents must not run (see [Agents in xpi](#agents-in-xpi)). |
  | `shadow.gitfile` | `false` | Opt-in `.git` file in the workspace (decision 15). |
  | `sandbox.backend` | `auto` | `auto`, `namespace` or `policy` (decision 9). |
  | `sandbox.require` | unset | `namespace`: fail instead of falling back. |
  | `sandbox.rule` (multi) | `scratch @ws/build` | Path rules (see [Path policy](#path-policy-decision-13)). |

  `xpi sg config ...` is git pass-through, so the user edits these with plain `git config` syntax. Keeping rules in
  git config needs no TOML or YAML parser.

### Sync model (decision 14)

**Invariant:** `host` is always an ancestor of `main`. Import keeps it by merging. Export keeps it by fast-forwarding
`host` to `main`.

Local-only paths are tracked on `main` and never exported. After an export `host` contains them too, so `host` is "the
host's state plus the local-only paths".

#### init

1. Refuse when the directory, or a directory above or below it, is already registered (exit 2).
2. Create `<name>.git` with `extensions.worktreeConfig`, `core.repositoryformatversion = 1`, and `core.worktree` in
   `config.worktree`. Append the registry line.
3. Write the adapter's `excludes` output and its `metadata` paths (anchored with a leading `/`) to `info/exclude`.
4. Run the adapter's `prepare`.
5. Commit the scope on `host` as `sg: baseline` (`git add -A -- <scope>`; the whole workspace when the scope is
   empty). Only scoped paths and local-only paths are ever tracked. Create `main` at the same commit and check it out.
6. With `shadow.gitfile = true`, write the `.git` file and add `.git` to `info/exclude`.

#### import

1. Require a clean work tree (no changes and no untracked files that are not ignored). Take the lock.
2. `git switch host`. The workspace returns to the host state (local-only paths that were exported stay).
3. Write `<name>.git/SG_IMPORT` (the old `host` sha), then run the adapter's `update` with `XPI_SG_LOCAL_ONLY` set to the local-only globs, which it must leave alone. It
   prints a one-line label, which is added to `SG_IMPORT`.
4. Put the local-only paths back as they are on `host`: restore tracked ones the update changed or deleted. If the
   update created a file at a local-only path that `host` does not track, stop (exit 1) on `host` and list those
   paths: a host file collides with a local-only path, and the user renames one of them or changes
   `shadow.localOnly`. Then commit any change on `host` as `sg: import <label>` (`git add -A -- <scope>` with a
   `:(exclude,glob)<glob>` pathspec per local-only glob). Remove `SG_IMPORT`: from here on, a stop is git's own
   state.
5. `git switch main`. Print the files changed both in the new import and in `old host..main`.
6. `git merge host`. A conflict stops the command (exit 1) with git's own message and `MERGE_HEAD`. The user resolves
   it with plain git (`git merge --continue` or `--abort`).
7. Release the lock.

**A stopped import.** If import stops in step 3 or 4 (a collision, a failed commit, a crash), `SG_IMPORT`
stays, like git's own `MERGE_HEAD`, and the lock is released; the record is the guard.

- `xpi sg import` with the record present resumes. With a label it skips steps 1–3 and continues at step 4. Without
  one (`update` did not finish) it runs `update` again.
- `xpi sg import --abort` runs `git checkout -f host` and `git clean -fd -- <scope>` (no `-x`, so ignored build
  outputs stay), removes the record, and runs `git switch main`. Without a record there is nothing to abort (exit 2);
  a conflicted merge is aborted with `git merge --abort`.
- While the record exists, `export`, `merge`, `sbx create` and new top-level sessions in the workspace refuse
  (exit 2), and `xpi sg status` shows it.

`git switch` rewrites the modification times of changed files. Build tools that use them rebuild those files. The docs
say this.

#### export

1. Require a clean work tree on `main` and the invariant (exit 2 otherwise).
2. **Plan:** `git diff --no-renames --name-status host..main`, minus local-only paths. Print it with the subjects of
   the commits in `host..main`. Read-only. A rename is a `D` and an `A`.
3. If a planned path is outside `shadow.scope`, exit 2 and list those paths. The fast-forward in step 5 would
   otherwise drop them from every later plan.
4. **Apply** (`--apply`, the user only): take the lock and give the plan to the adapter's `checkin`, with a message
   made from the commit subjects.
5. On success, fast-forward `host` to `main`. On failure, change nothing in git and exit 1.

Export is all of `host..main`. To export part of the work, keep the rest on another branch.

### CLI

Every subcommand that `xpi sg` does not own goes to git with the repo's `GIT_DIR` and `GIT_WORK_TREE` set, so
`xpi sg diff`, `xpi sg log` and `xpi sg commit` behave like git.

| Command | Effect |
| --- | --- |
| `xpi sg init <name> --adapter <a> [--scope <paths>] [--local-only <glob>...]` | Register the cwd and run init. |
| `xpi sg import [--abort]` | Run import, resume a stopped one, or abort it. |
| `xpi sg export` | Print the export plan. Read-only. |
| `xpi sg export --apply` | Print the plan, check it in through the adapter, and advance `host`. |
| `xpi sg status` | git status, commits ahead of `host`, the adapter's `status`, and the sandboxes. |
| `xpi sg env` | Print `export GIT_DIR=... GIT_WORK_TREE=...` for the resolved repo. |
| `xpi sg sbx create\|run\|ls\|rm ...` | Manage sandboxes (below). |
| `xpi sg merge <branch>` | Merge a branch (usually `sbx/<id>`) into `main` in the primary workspace, under the lock. Needs `main` checked out and a clean tree (exit 2). |
| `xpi sg list` | Print the registry. |
| `xpi sg <git command> ...` | Git pass-through. |

`push`, `fetch`, `pull`, `clone`, `remote` and `submodule` exit 2 with a one-line message.

Exit codes are 0 for success, 1 for a git or adapter failure (their stderr is shown as it is), and 2 for a failed
precondition (a dirty tree, a broken invariant, no repo, a git that is too old).

**Error handling.** Any non-zero git or adapter exit ends the command with that tool's stderr. There are no retries or
fallbacks. Input is validated at the boundaries only: arguments, registry lines, and adapter output.

### Adapters (decisions 5, 10)

An adapter is an executable named `sg-adapter-<name>`, found in `XPI_SG_ADAPTER_PATH` and then `PATH`. shadow-git
talks to the host VCS only through it.

It is called as `sg-adapter-<name> <op> [args]` with the workspace root as its cwd and with `XPI_SG_WORKSPACE` (an
absolute path), `XPI_SG_SCOPE` (space-separated paths, possibly empty) and `XPI_SG_LOCAL_ONLY` (space-separated
globs it must never change or delete) set. A non-zero exit is a failure, and its
stderr is shown unchanged. Paths are relative to the workspace root.

| Op | Input | Output (stdout) | Contract |
| --- | --- | --- | --- |
| `metadata` | | One path per line | The host VCS's own files and directories. Never tracked; hidden in sandboxes. |
| `excludes` | | One gitignore pattern per line | Other paths git must never track (build outputs, caches). |
| `prepare` | | | Afterwards every in-scope file is a writable regular file. |
| `update` | | A one-line label | Bring the workspace to the latest host state within the scope. |
| `checkin` | stdin: `A\|M\|D<TAB>path` lines; `--message-file <f>` | | Check in exactly these changes as one host operation, or fail with no partial effect where the host allows it. |
| `status` | | Free text, at most 20 lines | A short summary of the host side (locks held, newer versions available). |

The package ships two adapters in `packages/xpi-shadow-git/adapters/`, both POSIX `sh`:

- **`sg-adapter-plain`** treats another directory as the host. That directory is given by `shadow.plain.upstream`
  and holds a `.plainvcs/` metadata dir with a version counter. `update` copies the upstream into the workspace,
  deleting removed files except local-only paths. `checkin` copies the listed files into the upstream and bumps the version. It exists for
  the tests and for trying shadow-git without a host VCS.
- **`sg-adapter-template`**: every op with comments on its contract and the questions a writer must answer for their
  VCS. Examples are metadata names, how to make files writable without breaking a shared cache, and whether a check-in
  needs a lock first.

Adapters for real host VCSs are written by their users and kept outside xin-pi.

### Sandboxes (decisions 3, 9, 13, 16)

A sandbox is a private git worktree plus a path policy that decides, path by path, what a sandboxed command sees and
may write.

**Model.**

- The primary workspace is read-only to every sandbox. Only `import`, `export --apply` and `merge` write it, under the
  lock.
- `<name>.sbx/<id>/tree/` is a git worktree on `sbx/<id>`, created from `main` (or `--from <branch>`). Its `.git` file
  is inside the store, not the workspace. Each sandbox has its own index and branch, so sandboxes commit in parallel.
- Work leaves a sandbox only as commits on `sbx/<id>`. The user runs `xpi sg merge sbx/<id>`, then exports.

#### Path policy (decision 13)

Rules are `sandbox.rule = <mode> <path>`. `@ws` is the primary workspace root, and absolute paths are allowed. The
longest matching prefix wins. `xpi sg sbx create --profile <file>` reads the rules from a git-config file instead.

| Mode | A sandboxed command sees | It may write | Typical use |
| --- | --- | --- | --- |
| `private` | Its own copy | Yes | Source the agent changes |
| `shared-ro` | The primary file | No | Shared libraries, test suites, tool installs |
| `shared-rw` | The primary file | Yes, visible to every sandbox | Shared caches, only when listed |
| `scratch` | An empty per-sandbox directory | Yes | Build and test output |
| `hidden` | Nothing | No | Host VCS metadata, other users' areas, credentials |

**Defaults, when no rule matches:**

- Paths the shadow repo tracks are `private`.
- Other paths under `@ws` are `shared-ro`, read from the primary workspace, so shared scripts and suites work
  unchanged.
- The adapter's `metadata` paths are `hidden`.
- Paths outside `@ws` are `shared-ro`.
- Writes are denied unless the mode is `private`, `scratch` or `shared-rw`.

A `scratch` or `hidden` rule that covers tracked files is an error at `sbx create` (exit 2). It would hide the agent's
own files.

#### The sandbox tree

Both backends start from the same tree:

- The worktree holds the tracked files.
- `<name>.sbx/<id>/primary` is the sandbox's view of the primary workspace. Under `policy` it is a symlink to the
  workspace. Under `namespace` it is a read-only bind (below). All links in the tree point into it, never at the
  workspace path itself, which the `namespace` backend covers with the tree.
- Every untracked, not-hidden entry of the primary workspace becomes a symlink in the tree to `primary/<path>`. A
  directory with no tracked files below it becomes one link, so the number of links stays small. The links are
  refreshed when `sbx run` starts.
- A `scratch` path becomes a link to `scratch/<path>`.
- A `shared-rw` path under `@ws` becomes a link to the workspace path under `policy`. Under `namespace` it is a
  read-write bind of the primary path at its place in the tree.
- The links are listed in the worktree's own `core.excludesFile` (through `extensions.worktreeConfig`), so they never
  show up in the sandbox's `git status`.

#### Backends (decision 9)

**`namespace`** (Linux). It runs the command in a new user and mount namespace with
`unshare --user --map-root-user --mount`, via a small `sh` script:

- Every mount point is created before `unshare`. The mount order is fixed:
  1. The primary workspace is bound (`--rbind`) at `<name>.sbx/<id>/primary` and remounted read-only. Submounts
     inside the workspace stay as they are; the docs say so.
  2. `hidden` paths are covered, inside `primary` too: an empty `tmpfs` over a directory, `/dev/null` over a file.
  3. `shared-rw` paths are bound read-write at their place in the tree.
  4. The tree is bound (`--rbind`, so the binds from step 3 come with it) over the workspace's own path. Inside the sandbox, `/proj/ws` shows the agent's files, so
     scripts that hard-code the workspace path work unchanged.
  5. `shared-ro` rules for absolute paths outside the workspace are bound read-only over themselves.

  In a user namespace a read-only remount fails unless it repeats the flags the original mount was locked with
  (`nosuid`, `nodev`, `noexec` and so on). Steps 1 and 5 read them with `findmnt -no OPTIONS` and pass them again.
- Outside the workspace and listed paths, the filesystem keeps its normal permissions. A fully read-only system would
  break xpi's own session files, the home directory and temp files. xpi's file tools still enforce the whole policy
  (see the policy backend).
- The command runs as root inside the namespace (the user's own uid outside). The docs say so, and what follows from
  it: files owned by other users show as `nobody`, setuid programs do not work, and some tools refuse to run as root.
  For those, `policy` is the way.

**`policy`** (any platform; the only one on macOS). It needs nothing installed:

- The command runs with the tree as its cwd. Absolute paths into the primary workspace reach the primary files.
- xpi's `read`, `write` and `edit` tools check each path against the policy in process and refuse a denied one. The
  check uses the real path (of the parent directory for a new file), so a write through a link into `primary` is
  seen as a write to the primary file.
- `bash` is advisory. The prompt tells the agent the rules, and the `tool_call` hook blocks the commands listed under
  [Agents in xpi](#agents-in-xpi). Nothing stops a shell command from writing a primary file. The docs say this
  plainly.

**`auto`** checks `unshare --user --map-root-user --mount true` once per command. It picks `namespace` when that works,
else `policy`, and prints which one it picked. With `sandbox.require = namespace`, a failed check is exit 2.

#### Commands

| Command | Effect |
| --- | --- |
| `xpi sg sbx create <id> [--from <branch>] [--profile <file>]` | Create the worktree on `sbx/<id>`, the scratch area and the links. |
| `xpi sg sbx run <id> -- <cmd...>` | Run a command in the sandbox with `XPI_SG_SANDBOX=<name>/<id>`, `GIT_DIR=<name>.git/worktrees/<id>`, and `GIT_WORK_TREE` set to the tree (`policy`) or the workspace path (`namespace`). These always replace values the parent passed down. |
| `xpi sg sbx ls` | List sandboxes: branch, commits ahead of `main`, changed files, backend. |
| `xpi sg sbx rm <id>` | Remove the worktree and scratch. The branch `sbx/<id>` is kept. |

`xpi sg sbx run <id> -- xpi` runs a whole xpi session in a sandbox. Its `builtin:shadow-git` sees `XPI_SG_SANDBOX`
and applies the policy to its tools. Inside a sandbox, `isolation: "worktree"` and teammates' sandboxes are refused
with a message: sandboxes do not nest.

#### Commands that send work elsewhere

Some build and test tools send work to other machines, such as through a job scheduler or a remote build service. That
work runs outside the sandbox. The sandbox does not manage what it reads or changes and has no special support for it.
Results it writes back into the workspace are the user's to handle.

### Agents in xpi (decisions 3, 6)

When the session's cwd is in a registered workspace, `builtin:shadow-git` does the following.

- **git with no setup.** It sets `GIT_DIR` and `GIT_WORK_TREE` in xpi's own environment. Every child inherits them:
  `bash`, `!` commands, MCP servers and subagents. xpi's own git features (`/commit`, `/review`, worktree planning)
  then use the shadow repo. Features that read a `.git` path on disk see nothing unless `shadow.gitfile` is on. A git
  command run anywhere in that session reaches the shadow repo, even after `cd` to another repository. The docs say
  so.
- **User commands.** `/sg import`, `/sg export [--apply]`, `/sg merge <branch>`, `/sg status` and `/sg sbx ls` run the
  core in process and print its output. They are typed by the user; the model cannot run slash commands.
- **Blocked for agents.** A `tool_call` hook on `bash` blocks the following and returns a one-line reason:
  - `xpi sg` (and a bare `sg`, in case of an alias) with `import`, `merge`, `export ... --apply`, or `sbx create|rm`;
  - any `sg-adapter-*`;
  - every `shadow.blockCommand` regex (the adapter template suggests patterns for host VCS write commands).

  `xpi sg status`, `xpi sg export` (the plan), `xpi sg sbx ls` and git pass-through are allowed. (A bare `sg` is a
  different system command on Linux, so the prompt and docs always say `xpi sg`.)
- **Prompt.** A short paragraph says that a host VCS owns the workspace, that agents must never call it to write, and
  that `xpi sg export` shows the user what is pending.
- **The main session** (decision 18) edits the primary workspace like any checkout. The user is present and commits on `main`.
  Sandboxes are for agents the user is not watching.

**Isolation in a shadow-git workspace.**

- `isolation: "worktree"` creates a shadow-git sandbox `sub-<agentId>` from the primary's current branch, instead of
  `<root>/.pi/worktrees/<agentId>`. The child runs in it through the chosen backend, as `sbx run` does. This is a
  second kind of `WorktreeRef` in `worktree.ts`; the meta file records which kind.
- Settling follows today's rule. With no commits and no changes, the sandbox and its branch are removed. Otherwise
  both are kept, and the result names `sbx/sub-<agentId>` and says to run `/sg merge`.
- `/subagents worktrees` lists and removes these sandboxes too.
- **Teammates** (decision 19). In a shadow-git workspace each teammate gets a sandbox `team-<name>`. Running
  several agents on one workspace is the point of the sandbox. Without one, teammates would write the same files.
  Elsewhere teams are unchanged.

### Porting

The porting menu gets a "shadow-git" entry: depends on the subagent system for the isolation part, Linux first, with
the `policy` backend as the portable fallback. The detailed guide lists the core's API, the adapter contract, the
namespace script, and the hook. Same PR rule as every feature.

### Docs

- `packages/xpi-coding-agent/docs/shadow-git.md`: what it is, setup with the plain adapter, the sync model, the
  CLI, adapters and the template, sandboxes and both backends, agents in xpi, and the limits (advisory `bash` in
  `policy`, git env reaching other repos, mtimes on import, root in the namespace, writable submounts, the global
  excludes file not applying in sandboxes, work sent elsewhere).
- `README.md` and `docs/xin-pi.md`: one line and a link.
- `docs/subagent.md`: isolation in a shadow-git workspace, and teammates.
- The porting menu and detailed guide.
- `packages/xpi-shadow-git/README.md`.

Before each PR, a word list kept outside the repository is grepped over the diff (decision 10).

## Out of scope

- Adapters for real VCS products.
- bubblewrap, macOS `sandbox-exec`, overlay filesystems.
- Remotes, sharing a shadow repo between users, Git LFS.
- Managing work that leaves the machine (decision 16).
- Agents checking in or importing.
- Making a whole system read-only in the namespace backend.

## Questions for the owner (answered: decisions 18, 19)

1. **The main session edits the primary workspace.** The draft lets the interactive session edit the workspace like
   any checkout, and keeps sandboxes for subagents and teammates. The other choice puts every agent, the main one too,
   in a sandbox, as the owner's original notes did. Recommended: as drafted.
2. **Teammates get sandboxes.** In a shadow-git workspace each teammate runs in its own sandbox, which changes
   "teammates are never isolated" for these workspaces only. Recommended: yes.

## Testing

- **Offline**, with temp stores and workspaces and the plain adapter. Each new guard is checked to fail when removed.
  - **Core.**
    - init writes nothing into the workspace, and refuses nested registrations;
    - registry resolution by longest prefix, and `--repo`;
    - the git version check;
    - the blocked commands and pass-through.
  - **Sync.**
    - import with no local work, with local work, and with a conflict (stops; the both-changed list is printed);
    - import after an export keeps the local-only paths, even when the adapter deletes them;
    - a host file colliding with an unexported local-only path stops import on `host` with `SG_IMPORT` left; a rerun
      resumes at step 4; `--abort` returns to the last host state; `export`, `merge`, `sbx create` and a new session
      refuse while the record exists; a crash during `update` reruns it;
    - CLI import refused while a primary session is live (a sandboxed one does not count; a dead pid is dropped);
      `/sg import` refused while one of its agents works in the primary;
    - local-only paths kept out of the plan;
    - export plan, out-of-scope paths refused, `--apply` success and adapter failure (git unchanged);
    - the invariant checks and exit codes.
  - **Lock.** Two writers at once; a stale lock is taken over.
  - **Sandboxes.**
    - create, ls, rm, with the branch kept;
    - links for untracked paths kept out of the sandbox's status;
    - `git -C <tree> rev-parse --show-toplevel` is the tree, not the workspace;
    - the policy check through a link into `primary` (refused);
    - scratch and hidden rules, and the error for rules over tracked files;
    - the policy check for `read`, `write` and `edit`, and the `tool_call` blocks;
    - `auto` falling back with the message, and `require = namespace` failing.
  - **Namespace backend**: in a local Linux VM or container where unprivileged user namespaces work. Covers
    the path view at the workspace's own path, a read-only primary, a hidden directory and file (also under
    `primary`), a scratch path, a `shared-rw` path, a read-only bind of a `nosuid` mount, and a `git commit` inside. In CI the test skips with the probe's message when the runner forbids namespaces.
  - **xpi integration.**
    - nothing registered outside a workspace;
    - `GIT_DIR` reaching `bash` and subagents;
    - `isolation: "worktree"` making a sandbox, settling, and `/subagents worktrees`;
    - teammates in sandboxes; nesting refused inside a sandbox;
    - the `/sg` commands.
- **Real check** before the last merge, with Haiku, a temporary agent dir and HOME, a copied auth file whose expiry is
  checked first, and the real `~/.pi/agent` untouched. A session in a plain-adapter workspace starts a subagent with
  `isolation: "worktree"` that changes a file and commits. The user's `/sg merge` and `/sg export` then show the
  change, and the agent's attempt to run `sg export --apply` is blocked.

## PRs (after approval)

1. **Core.** The package, `xpi sg` (init, import, export, status, env, list, merge, pass-through, blocks), the lock,
   both adapters, `docs/shadow-git.md` (core parts), the package README.
2. **Sandboxes.** The tree and links, the path policy, both backends, `sbx` commands, the container test. Docs and the
   porting entry for what exists.
3. **xpi integration.** `builtin:shadow-git`: environment, `/sg`, hooks, prompt, the policy check in tools,
   isolation, teammates. `docs/subagent.md`.
4. **Wrap-up.** The detailed porting guide, `docs/xin-pi.md`, the real Haiku check, and a release.

## Revisions while implementing

PR 1 (core) differs from the text above in these places.

- **`git checkout`, not `git switch`.** The spec's steps say `git switch`, which needs git 2.23. The minimum is 2.20, so
  import, abort and the tests use `git checkout -q <branch> --`.
- **Lock staleness.** The lock is stale when its holder's pid is gone; there is no age limit. The team locks also treat
  a lock older than 30 seconds as stale, but an import or a check-in can run for minutes, and taking over a lock of a
  live holder would let two writers into the primary workspace. A lock file that cannot be read yet is stale after
  five seconds.
- **Adapter lookup.** `XPI_SG_ADAPTER_PATH` (default `<store>/adapters`), then the adapters shipped with xpi, then `PATH`.
  The spec lists only the first and the last, but the plain adapter has to be found without setup.
- **Adapter environment.** Adapters also get `XPI_SG_GIT_DIR` (the shadow repo) and `XPI_SG_GIT` (the git binary), so the
  plain adapter can read `shadow.plain.upstream` and the tracked file list. `GIT_DIR` and `GIT_WORK_TREE` are removed.
- **Additions to the CLI.** `init --config <key>=<value>` (a setting written before the adapter runs, so the plain
  adapter's upstream can be given at init) and `init --gitfile` (`shadow.gitfile = true`). `xpi sg merge --continue` and
  `--abort` go to `git merge`, because `merge` is an `xpi sg` command and plain git is not reachable through it.
- **Registration order.** `init` appends the registry line after the baseline commit, not before the adapter's ops, and
  removes the half-built repo if any step fails.
- **Local-only matching in adapters.** The spec says only that adapters must leave local-only paths alone. The globs are
  git pathspec globs, which shell `case` patterns do not match the same way, so the plain adapter asks git, and the
  docs and the template say so.
- **`metadata` is root-relative.** Every `metadata` line is anchored to the workspace root in `info/exclude`. A host name
  that repeats in every directory goes in `excludes`.
- **`import --abort`** also cleans local-only paths, and removes the record only after `git checkout main` succeeds.
  Resuming an import from a branch other than `host` needs a clean tree.
- **`merge --continue|--abort`** take the lock and the live-session check.

PR 2 (sandboxes) differs from the text above in these places.

- **Rules are a snapshot.** `sbx create` copies the effective rules (the repo's `sandbox.rule`, or the `--profile`
  file's, which replaces them) and the adapter's `metadata` paths into `<name>.sbx/<id>/policy`. Later config changes do not reach
  an existing sandbox.
- **`metadata` paths are rules of their own length.** The spec makes them hidden "when no rule matches". Here a
  `metadata` path is hidden unless a rule of the same length or longer says otherwise, so `shared-ro @ws` does not
  unhide the host VCS's files.
- **`shared-rw` over tracked files is an error** at `sbx create`, like `scratch` and `hidden`: the tracked files are the
  sandbox's own copies, so they would silently not be shared. `shared-ro` over tracked files is allowed (the policy
  refuses writes; the namespace does not mount over them). `scratch` outside `@ws` and `scratch @ws` are errors too.
- **A directory that would be one link stays real** when the agent made an untracked file in it, or a rule below it
  is not `shared-ro`; its other entries become links.
- **Worktree naming.** git names a worktree after its directory, so `git worktree add` runs at `<root>/<id>` and
  `git worktree move` puts it at `<root>/tree`. That keeps `GIT_DIR=<name>.git/worktrees/<id>`.
- **`sbx rm` refuses uncommitted work** (exit 2) unless `--force`. The spec has no flag; removing a worktree with
  unsaved edits loses them.
- **Extra variables and `XPI_SG_UNSHARE`.** `sbx run` also sets `XPI_SG_BACKEND` (the policy function needs it: under
  `namespace` the workspace's own path is the tree) and `XPI_SG_STORE`. `XPI_SG_UNSHARE` names the `unshare` program the
  probe and the backend use; tests set it to a missing file to make the backend unavailable on any platform.
  `sandboxPolicy(sandbox, path, backend = "policy")` takes the backend as an argument.
- **Probe.** Besides `unshare ... true` it checks that `mount` and `findmnt` exist. Non-Linux platforms fail the probe
  without running anything. `sandbox.backend = namespace`, like `sandbox.require = namespace`, is exit 2 when it fails;
  `require = namespace` with `backend = policy` is exit 2 too.
- **Setup failures** in the namespace script end with exit 125 and a message, so they are not taken for the command's
  own exit code.
- **Inside a sandbox** (`XPI_SG_SANDBOX` set), `xpi sg` finds the repo by that name (the tree is outside any
  registered workspace), runs git pass-through and `env` on the sandbox's git dir and tree, and refuses `import`,
  `merge`, `export --apply` and `sbx create|rm|run` (exit 2). Without this, `xpi sg commit` inside a sandbox would commit
  on `main`.
- **Remount flags.** util-linux 2.38 repeats the locked flags itself on `remount,bind`, so the explicit repetition in the
  script cannot be shown to matter there (a raw `mount(2)` remount without them fails with EPERM, which confirms the
  lock). The script repeats them anyway, for older `mount` programs.
- **`sbx ls` format.** One line per sandbox: `<id>  sbx/<id>  <n> commit(s) ahead of main  <n> changed file(s)  backend <b>`;
  `status` prints the same lines under `sandboxes:`, each prefixed with `<name>/`. A sandbox that cannot be opened is
  listed as `<id>  broken: <reason>`.
- **Out of the namespace script:** an absolute `shared-rw` rule nested under an absolute `shared-ro` rule is not made
  writable again, and hidden paths inside a `shared-rw` path are covered in the tree but a hidden rule is not applied to
  submounts of the workspace.

After review of PR 2:

- **pid namespace.** The namespace backend runs `unshare --user --map-root-user --mount --pid --fork --mount-proc`
  (the probe too). Without it `/proc/<pid>/root` of a process outside reaches the primary through the host's mount
  namespace. Container runtimes that mask `/proc` make the probe fail, so `auto` falls back to `policy` there.
- **Step 6, the git directory.** After the spec's five steps the script binds the shadow repo's `config`,
  `config.worktree`, `hooks/` and `info/`, and the sandbox's own `config.worktree`, read-only. `sbx` creates `hooks/`
  if it is missing. The commands `xpi sg` runs itself also pass `-c core.fsmonitor=`. Refs stay shared and writable;
  `policy` leaves the git directory writable. Both are documented as limits.
- **Locking and links.** `sbx run` refreshes the links under `<id>/lock`, and leaves a link that is right alone, so a
  running command never sees one vanish; an `EEXIST` from a concurrent refresh counts as success.
- **Broken sandboxes** are listed as broken, and `sbx rm --force` removes one. A git config file that cannot be read
  is an error (exit 1), not an empty rule list.
- **Inside a sandbox**, `init` and `--repo <other>` are refused too; `XPI_SG_STORE` passed to the command is the
  store's real path; the final `cd` of the script is a setup step (exit 125); `strictatime` is among the repeated
  mount flags.

After the second review of PR 2:

- **Steps 6 and 7 of the script.** The git directory's `worktrees/` is read-only, with the sandbox's own
  `worktrees/<id>` writable except `commondir`, `gitdir` and `config.worktree`; `<name>.sbx` is read-only with this
  sandbox's `tree` and `scratch` writable. The writable parts are bound first, then the parent is bound with `--rbind`
  and remounted read-only, since a read-only remount covers the top mount only. The tree is still bound over the
  workspace's path in step 4, before these, so its view there stays writable.
- **Checks outside the namespace.** Before any git runs on a sandbox's tree from outside, `commondir` must still be
  `../..` and `config.worktree` must hold only `core.excludesFile`; otherwise the sandbox is `broken: commondir
  changed` or `broken: config.worktree changed`. Removing a sandbox no longer runs `git worktree remove` on its tree:
  the directories go by hand and `git worktree prune` follows. Under `policy` the attack stays possible for plain git
  started by hand in a tree; this is documented.

PR 3 (xpi integration) differs from the text above in these places.

- **The file-tool check is a `tool_call` hook.** `read`, `write`, `edit`, `grep`, `find` and `ls` are held to the policy by
  a handler on `tool_call` (it sees codemode's nested calls too), not by wrapping the tools. `grep`, `find` and `ls` get
  the read check for a `path` they are given; their default, the working directory, is the sandbox's tree. Paths that
  contain `://` are other schemes, not files, and are not checked.
- **Always writable, with exceptions.** Besides the agent directory, the session directory, `os.tmpdir()` and the sandbox's
  `scratch` and `tree`, the check never lets these through even when they sit inside those directories: the **store**
  (inside the agent directory by default; it holds every other sandbox), the **primary workspace** and the sandbox's
  `primary` link. The override applies only where the policy says `shared-ro`, so a `hidden` path stays hidden.
- **A stopped import cannot refuse a session cleanly.** An extension cannot end startup, so the fallback of this spec
  applies: an error notice at `session_start`, and every tool call blocked with a reason that names `xpi sg import` and
  `xpi sg import --abort`. The check is made again at each call, so a session works again once the import is settled.
  A blocked session writes no live-session entry (it would make the resume refuse); the entry is written by the first
  turn or tool call after the import is settled.
- **`/sg`.** Also accepts `merge --continue` and `merge --abort`. Only `import`, `export --apply` and `merge` need the
  workspace to themselves (no other live session, no agent of the session working in the primary, the main agent idle);
  `status`, `export` (the plan) and `sbx ls` always run. Output goes to a notice (`error` level on a non-zero exit).
  Only a top-level session registers it.
- **bash block list.** The hook searches the command text (the shell is not parsed), so it also matches inside quotes. `xpi
  sg sbx run` is allowed (the sandbox is the agent's own); `sbx create|rm` are blocked. The one-line reason ends with
  "ask the user to run it". An invalid `shadow.blockCommand` regex is reported on stderr once and ignored.
- **A child of the primary** (`XPI_SUBAGENT_DEPTH` set) gets the git environment, the block list and the prompt like the
  main session, but no entry and no `/sg`.
- **Prompt.** Added as the section `shadow-git` of `systemPromptOptions` in `before_agent_start`, the same text every turn.
- **A sandbox that cannot be opened** blocks every tool call (fail closed).
- **Isolation: how the child is started.** `ChildSpec.launch(command, args, env)` is set by the exchange once the sandbox
  exists and called by `runChild` just before `spawn`, because the runner adds the system-prompt files to the arguments
  itself. xpi-shadow-git gained `prepareLaunch(repo, id)` (the refresh and backend choice of `sbx run`, returning a
  `wrap(cmd, { env, subdir })`); `runInSandbox` uses it too. `namespaceScript` and `namespaceCommand` take an optional
  `subdir` for the final `cd`. `removeSandbox` takes `dropBranch`. The package also exports `sandboxGit`, `changedFiles`,
  `sandboxesDir`, `git`, `splitZ`, `configAll`, `currentBranch`, `revParse`, `dirtyPaths`, `readImportRecord` and
  `assertNoImport`.
- **Where the child starts.** `WorktreeRef.kind: "shadow-git"` with `repo`, `sandbox` and `backend`; `worktreeCwd(ref)` is
  the tree plus the subdirectory (under `namespace`, the workspace's own path plus it), used by `resolve.ts` and `fork.ts`.
  The sandbox is made when the exchange gets its slot (`ensureWorktree`), from the primary's current branch, and a
  dirty primary adds a warning as for worktrees.
- **Ids.** `sub-<agentId>` for isolation and `team-<name>` for a teammate. A teammate whose sandbox directory or branch
  still exists from an earlier one is refused at planning (merge and remove it, or choose another name); a resume
  re-enters its kept sandbox. A sandbox that settles as unchanged is removed with its branch after each exchange, so an
  idle teammate that did nothing holds none and the next wake makes a new one.
- **Settling** looks at the sandbox's own `git status` (ignored files do not count) and at HEAD not being on `sbx/<id>`;
  the result's `note` ends with the `/sg merge` hint. Quiet: nothing is printed by the core there (the TUI owns the terminal).
- **`/subagents worktrees`** lists only the `sub-*` and `team-*` sandboxes, so a sandbox the user made is never offered for
  removal, and removing one deletes its branch too.
- **Nesting.** `isolation: "worktree"`, an agent file's `isolation` and a teammate are refused when `XPI_SG_SANDBOX` is
  set, with "sandboxes do not nest", before anything is made.
- **Tests** are `test/subagent/shadow-git/*.test.ts` (node:test, in `npm run test:subagent`) with the `policy` backend
  forced; the namespace wrapper with a subdirectory is in `packages/xpi-shadow-git/test/namespace.test.ts`.

After review of PR 3:

- **The session's cwd decides, at each `session_start`.** The extension registers its handlers (not `/sg` with an effect) in
  every non-sandbox session, and they act only while the session's `ctx.cwd` is in a registered workspace. This replaces
  "registers nothing unless ..." and the cwd of the process: a session resumed from another directory has that
  directory's cwd with no `chdir`. Entering sets `GIT_DIR`/`GIT_WORK_TREE` and writes the live entry; leaving (or a
  shutdown) restores the values from before the extension set them and removes the entry.
- **Always writable is narrower.** Not the agent directory: the session directory, `os.tmpdir()`, `~/.claude/agent-memory`,
  and the sandbox's `scratch` and `tree`. The store and the primary stay refused inside them.
- **Scheme paths** (`^@?[a-z][a-z0-9+.-]*://`) are refused by the sandbox's file tools (they cannot be judged); other
  paths containing `://` are checked as paths.
- **The block list** applies to every tool whose input has a string `command`, and scans overlapping matches, so the inner
  `sg merge` of `xpi sg sbx run s -- xpi sg merge b` is seen.
- **`/sg`'s busy check** also counts running background codemode scripts and queued teammates; a background `bash` job
  cannot be tracked (documented).
- **Smaller:** `findWorkspace` returns `undefined` on any error; a sandbox child's `ref.backend` and cwd follow the backend
  used at launch; the subdirectory is `/`-separated.

After the second review of PR 3:

- **`builtin:shadow-git` is first in `builtInExtensions`**, so its `session_start` (which sets `GIT_DIR` and `GIT_WORK_TREE`)
  runs before `mcp`, `codemode` and the rest start anything. Handlers run in the array's order.
- **Memory.** Not `~/.claude/agent-memory` as a whole: the subagent runner sets `XPI_SUBAGENT_MEMORY_DIR` to the child's own
  memory directory (it follows `claudeDir`), and only that is writable. Project-scope memory is in the primary, so a
  sandboxed agent's writes there are refused (documented).
- **The memory variable is passed narrowly.** `XPI_SUBAGENT_MEMORY_DIR` is left out for a read-only memory, and, when
  `XPI_SG_SANDBOX` is set, for a child whose memory directory is not the one received or below it; what the process
  received is removed from the child's environment otherwise.

PR 4 (wrap-up): the real-model check is `test/subagent/real/24-shadow-git.test.ts` (an isolated agent commits in its sandbox;
`xpi sg merge` and the export plan show it; the agent's `xpi sg export --apply` is blocked and the host unchanged). The
namespace backend is also run end to end offline in `test/subagent/shadow-git/namespace.test.ts` (an isolated subagent and a
teammate; skips where namespaces are unavailable). The detailed porting guide is the section "shadow-git: the detailed
guide" of `porting.md`.
