# Spec 01: graph nits from PR #141

Status: draft, waiting for the owner's approval. Grill: all seven decisions as recommended (see the grill report
in the session; summarised below).

## Problem

Two command nodes of the repository's own graphs misbehave. Both files are `.pi/graphs/dev.js` and
`.pi/graphs/release.js`.

1. **`branch` node (`dev.js`).** The check is
   `test "$(git branch --show-current)" != main || git switch -c "dev-..."`.
   - On a detached HEAD, `git branch --show-current` prints nothing. The text is not `main`, so the check passes and
     no branch is made. The build then pushes from a detached HEAD and fails.
   - On a feature branch left over from an unfinished run, the check also passes. The new work lands on the old branch.

   Example: a run stops after its first build on `dev-20261101-100000`. The next `/graph start dev` on that branch
   builds on top of it, with its old commits and its old pull request.

2. **`ci` node (both files).** The node polls `gh pr checks` 30 times, 10 seconds apart. With no pull request on
   the branch the output is empty, so the loop waits its full 5 minutes. Then `gh pr checks --watch --fail-fast`
   fails. The model sees a 5-minute wait and a vague error.

## Goal

1. `branch` makes the new branch only from `main`. On a detached HEAD or on any other branch it fails with a clear
   message and no branch is made.
2. `ci` fails at once, with a clear message, when the branch has no pull request. Any failure of `gh pr view` is
   treated the same way: the node does not tell "no pull request" from "gh not logged in" or "network down"; the
   message shows gh's own error text.

Not in this spec: fetching `origin/main` or checking that local `main` is current (the base is the local `main`,
as today); resuming a leftover branch; a Windows shell; any other node; changes to the graph engine.

## Design

### 1. `branch` node (`.pi/graphs/dev.js`)

The node stays a command node with only a `pass` edge, so a failure halts the graph (decision 2). The new command:

```sh
b=$(git branch --show-current); if [ "$b" != main ]; then if [ -z "$b" ]; then echo "branch: HEAD is detached; run from main"; else echo "branch: current branch is \"$b\", not main; run from main"; fi; echo "then: git switch main, and /graph goto branch"; exit 1; fi; git switch -c "dev-$(date +%Y%m%d-%H%M%S)"
```

The output goes into the session (the last 200 lines), so the model and the owner read the message there.

### 2. `ci` node (both files)

Before the existing polling loop, one check (decision 4):

```sh
pr=$(gh pr view --json number --jq .number 2>&1) || { echo "ci: no pull request for branch \"$(git branch --show-current)\""; echo "$pr"; exit 1; }
```

The rest of the command (the 30 × 10 s wait for the checks to register, then `gh pr checks --watch --fail-fast`) is
unchanged. Edges are unchanged (decision 2):
- `dev`: `ci` `fail` goes to `build` (max 3). The build node is told to open the pull request, so the next pass
  creates it.
- `release`: `ci` `fail` goes to `fix` (max 2). In a release the bump already opened the pull request
  (`scripts/release.mjs:155`), so a missing pull request is seen only when the release is run by hand.

The shell is POSIX `sh` (decision 3), as in the existing nodes.

### 3. Tests (`packages/xpi-coding-agent/test/repo-graphs.test.ts`)

Behaviour, not string matching (decision 6). The test reads the `run` string from the graph literal and runs it with
`sh -c` in a temporary directory.

- `branch`, in a temporary git repository with one commit:
  - on `main`: exit 0, and the current branch is a new `dev-*` branch made from `main`;
  - on a detached HEAD: exit non-zero, the output names the detached HEAD, no branch is made;
  - on another branch (e.g. `feature`): exit non-zero, the output names that branch, the current branch is unchanged.
- `ci`, for both files: a `PATH` with a fake `gh` that fails on `pr view` with "no pull requests found", and a fake
  `sleep` that appends to a file. Assert: exit non-zero, the output has "no pull request for branch", and the fake
  `sleep` was never called.

The tests must not start a test runner, and must not touch `~/.pi/agent` (AGENTS.md). Temporary directories are
removed after each test.

### 4. Documentation (same change)

- `packages/xpi-coding-agent/docs/graph.md`, section "Two graphs to read":
  - the `dev.js` description: the build is put on a branch made from `main`; on any other branch or a detached HEAD
    the graph halts with a message;
  - both descriptions: the wait for checks starts only when the branch has a pull request; without one the node fails
    at once.
- `dev.js` file header and the comment above `branch`: the same facts.

## Files

| Path | Change |
|---|---|
| `.pi/graphs/dev.js` | `branch` and `ci` commands; header and comment |
| `.pi/graphs/release.js` | `ci` command |
| `packages/xpi-coding-agent/test/repo-graphs.test.ts` | behaviour tests for `branch` and `ci` |
| `packages/xpi-coding-agent/docs/graph.md` | "Two graphs to read" |

Tickets: `issues/01-graph-nits.md`.

## Checks

- `npm run check` after the change.
- `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/repo-graphs.test.ts` from
  `packages/xpi-coding-agent`.
- Afterwards, check that no test left a process or a temporary repository behind.
