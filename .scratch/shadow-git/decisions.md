# shadow-git: decisions

The owner's answers to each grill, recorded with the recommendation they accepted. The spec is `01-shadow-git.md`.

The owner brought their own design notes for a tool that puts a private git history over a workspace owned by another
version control system, with a sandbox for agents. This spec is the neutral version built into xin-pi. It names no
organisation, product line, site, or VCS product.

## Grill 1 (2026-11-14)

The owner changed two answers ("我觉得不用做单独的仓库，做进xpi就行…沙盒做的要减少依赖性…"); the rest were accepted
as recommended in Grill 2 (decision 11).

1. **Form.** Built into xin-pi, not a separate repository or an installable package.
2. **Language.** The core is TypeScript, like the rest of xpi. A machine that runs xpi has Node; no Python. Adapters
   may be shell scripts.
3. **Two layers of sandbox.** `xpi sg sbx run <id> -- <cmd>` runs a whole command (an agent, a shell, a tool) in a
   sandbox. Inside xpi, `isolation: "worktree"` uses a shadow-git sandbox when the cwd is in a shadow-git workspace.
4. **Few dependencies.** Superseded by decision 9: no bubblewrap.
5. **First version.** The core, the sandbox, a "plain directory" adapter for tests, and an adapter template with the
   interface docs. Superseded in part by decision 10: no adapter for any named VCS product.
6. **Agents in xpi.** git works with no setup in a registered workspace. `/sg import`, `/sg export --apply` and
   `/sg merge` are user commands. A `tool_call` hook stops agents from running those, adapters, or host VCS write
   commands. Agents may run `sg status` and `sg export` (the plan).
7. **Naming.** Superseded by decision 8 (no separate repository).

## Grill 2 (2026-11-14)

The owner changed decision 10 (name no field and no VCS product; call them "other non-git VCSs"; everything else as
recommended) and allowed "software development" as the framing ("你可以说软件开发").

8. **Where it lives.**
   - A workspace package `packages/xpi-shadow-git`: the core library, depending only on Node and git.
   - A built-in extension `builtin:shadow-git` that wires it into xpi.
   - The CLI is `xpi sg <cmd>`, shipped with xpi like `xpi roost`. There is no separate `sg` binary.
   - It acts only when the cwd is in a registered workspace. Elsewhere xpi behaves exactly as today.
9. **Sandbox backends.** No bubblewrap.
   - `namespace`: Linux `unshare` and `mount` from util-linux. Real isolation. Needs unprivileged user namespaces.
   - `policy`: no dependencies. The sandbox tree is outside the workspace, shared read-only paths are symlinks, and
     xpi's own file tools check paths in process. `bash` is advisory (a `tool_call` hook and prompt text), and the
     docs say so.
   - `auto` (the default) uses `namespace` when it works, else `policy`, and prints which. `require = "namespace"`
     fails instead. macOS has `policy` only.
10. **Neutral wording.**
    - The docs say "software development", "development workspace", "build and test tools", and "host VCS" (any
      version control system other than git). They name no VCS product.
    - Example paths are neutral, such as `/proj/ws`.
    - The first version ships the plain-directory test adapter and an adapter template with the interface docs.
      Adapters for real host VCSs are written by their users and are not part of xin-pi.
    - Before each PR a local word list, kept outside the repository, is grepped against the diff.
11. **The rest of Grill 1 as recommended**: decisions 2, 3, 5 (as changed by 10) and 6.
12. **The spec** is `.scratch/shadow-git/01-shadow-git.md`, reviewed independently and then approved by the owner.
    The owner's own design notes stay private: they are not copied into or referenced from the repository.

## Grill 3 (2026-11-14)

The owner accepted all recommendations and changed decision 16: when a task sends jobs elsewhere, the sandbox does
not manage what they change ("…沙盒不要去管，不要复杂化").

13. **Default path policy.**
    - Unlisted paths are shared read-only, since build and test tools read widely.
    - Writes are denied unless a rule grants them.
    - In the workspace, files the shadow repo tracks are private to each sandbox. Untracked files are read from the
      primary workspace, so shared scripts and suites work unchanged.
    - Host VCS metadata, which the adapter declares, is hidden.
14. **Import conflicts.** Merge, and stop on conflicts; the user resolves them with plain git. Before merging, list
    the files both sides changed.
15. **`shadow.gitfile`.** Built, off by default. It is the one exception to "nothing in the workspace".
16. **Jobs that leave the machine.** Work a command sends elsewhere (a job scheduler, a remote build) runs outside
    the sandbox. The sandbox does not manage what those jobs change and has no special support for them. The docs
    say this in one paragraph and name no scheduler.
17. **git version.** At least 2.20, checked when a command starts. Too old is an error that suggests `XPI_SG_GIT`.
    Environment variables are `XPI_SG_*`.

## Approval (2026-11-14)

The owner approved the spec after six review rounds (one review and five delta checks) ("是"), with both owner questions as recommended.

18. **The main session** edits the primary workspace like any checkout. Sandboxes are for subagents and teammates.
19. **Teammates** each get a sandbox in a shadow-git workspace. Elsewhere teams are unchanged.
