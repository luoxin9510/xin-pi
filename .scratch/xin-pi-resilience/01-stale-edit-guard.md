# 01: Stale-edit guard

Status: draft, waiting for Grill 1 (`decisions.md`). No code until the owner approves.

Origin: the omp study (`~/Developer/omp-study/09-对比-xpi/xpi可借鉴清单.md`, item 1). omp rejects an edit whose
file changed after the model read it (hashline tags carry a whole-file hash); Claude Code refuses Edit on a file not
read in the conversation and Write over an existing file not read first.

## Problem Statement

The model reads a file, something else changes it (a bash command, a codemode script, a subagent working in the same
checkout, the user in their editor), and the model then edits from its stale picture. Today `edit` re-reads the file
and applies `oldText`/`newText` to whatever is on disk. If the old text still matches once, the edit lands silently on
top of changes the model never saw. `write` overwrites any file without looking. Parallel subagents without worktrees
make this more likely than before.

## Solution

`read` records a fingerprint of each file it returns. `edit` and `write` compare the file on disk with the fingerprint
before writing. When the file changed since the last read, the call fails with a message that says so and tells the
model to read the file again. A successful `edit` or `write` refreshes the fingerprint, so consecutive edits to the
same file keep working.

## User Stories

1. As the owner, I want an edit to fail when the file changed after the model read it, so that the model never
   overwrites work it did not see.
2. As the owner, I want the failure text to say the file changed since it was read and to ask for a re-read, so that
   the model recovers in one step instead of guessing.
3. As the owner, I want two edits in a row to the same file to work without a read in between, so that the guard does
   not slow normal editing.
4. As the owner, I want changes made by bash, codemode scripts, subagents and my editor all to be caught, so that the
   guard does not depend on who changed the file.
5. As the owner, I want `write` over an existing file to be checked the same way, so that a full rewrite cannot erase
   changes either.
6. As the owner, I want creating a new file with `write` to need no read, so that new files stay one step.
7. As the owner, I want edits through codemode's `ctx.executeTool` to follow the same rules, so that scripts are not a
   way around the guard.
8. As the owner, I want a paged read (`offset`/`limit`) to count as a read of the file, so that large files can be
   edited after reading the relevant part.
9. As the owner, I want reading an image not to count, so that the guard state only covers text the model can edit.
10. As the owner, I want a setting to turn the guard off, so that I can rule it out when debugging.
11. As the owner, I want the behaviour after resume, fork and compaction to be predictable, so that an old session does
    not suddenly refuse every edit.
12. As a subagent, I want my own reads to count for my own edits, so that the guard works inside a child the same way.
13. As the owner, I want whitespace-only changes at line ends (an editor trimming trailing spaces, CRLF conversion)
    not to count as a change, so that the guard does not fire on noise. (Grill question.)

## Implementation Decisions

- A per-session file-state store, keyed by real path, holding the content fingerprint of the last read or write. It is
  created with the session's tools and shared by `read`, `edit` and `write` (and therefore by nested codemode calls,
  which run through the same tools).
- Fingerprint: a hash of the whole file after line-end normalisation, plus size and mtime as a fast path: when size
  and mtime match, the hash is not recomputed. `edit` already reads the whole file, so the hash costs no extra I/O.
- `read` with `offset`/`limit` still fingerprints the whole file. Image reads record nothing.
- Check order in `edit`: inside the existing per-path mutation queue, after reading the file and before matching.
  Mismatch → throw with the stale-file message; no automatic re-read.
- `write` checks only when the target exists. A new file needs no read.
- Unread file: behaviour is Grill question 2 (reject like Claude Code, or allow).
- Resume/fork/compaction: the store starts empty for a session loaded from disk (no fingerprints are persisted).
  Combined with the unread-file rule this decides what an old session sees. Grill question 3.
- Setting: one boolean (name in the Grill), default on.
- Subagent children are separate processes with their own store; nothing crosses the process boundary. A change made
  by a child is caught by the parent's disk comparison.

## Testing Decisions

- Good tests drive the real tools on a temp directory and assert on results and file contents only.
- Prior art: `test/tools.test.ts` (read/write/edit describes with tmp dirs), `test/edit-tool-legacy-input.test.ts`,
  `test/nested-tool-calls.test.ts` for the codemode path.
- Cases: changed-after-read rejected; edit-edit without read passes; write over changed file rejected; new-file write
  passes; paged read counts; trailing-whitespace change accepted (if decided); setting off restores today's behaviour;
  nested codemode edit follows the rule.

## Out of Scope

- Hashline-style anchors or any change to the edit argument format.
- Persisting fingerprints in the session file.
- Cross-process coordination between parent and subagent stores.
- Guarding bash writes.

## Further Notes

The text of the failure message is part of the contract: models act on it. Proposed:
`File <path> changed since you last read it. Read it again before editing.`
