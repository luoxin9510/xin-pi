# 01: Stale-edit guard

Spec: `../01-stale-edit-guard.md`, decisions 2-5 in `../decisions.md`.

**What to build:** `edit`, and `write` over an existing file, fail when this session has not read the file, or when the
file changed since this session last read or wrote it. The failure tells the model to read the file again. A
successful `edit` or `write` counts as the latest read, so edits in a row need no read in between. The check applies to
calls made from codemode scripts too, since they run the same tools. One top-level setting `staleEditGuard` (default
true) turns it off.

**Blocked by:** None (can start immediately)

**Status:** done (PR #29, merged 2026-11-10)

- [x] A per-session store of file fingerprints (real path → hash of the whole file with trailing spaces/tabs and CR
      ignored, plus size and mtime as a fast path), shared by `read`, `edit` and `write`
- [x] `read` records the fingerprint of the whole file for a text read, including a paged read; an image read records
      nothing
- [x] `edit` checks inside the per-path mutation queue, after reading the file and before matching; `write` checks only
      when the target exists; a new file needs no read
- [x] Error texts: not read: `File <path> has not been read in this session. Read it before editing.`; changed:
      `File <path> changed since you last read it. Read it again before editing.` (wording may be tuned; keep "Read")
- [x] `staleEditGuard` in the settings schema, defaults and settings manager; off restores today's behaviour exactly
- [x] Subagent children: their own store (nothing crosses processes); the child's system prompt or tool text needs no
      change, the error text is enough
- [x] Tests (vitest, real tools on a temp dir): unread edit refused; read then external change refused; read, edit,
      edit passes; trailing-whitespace-only change passes; write over unread existing file refused; new-file write
      passes; paged read counts; image read does not; setting off; nested codemode call follows the rule
- [x] Existing tests that edit without reading are updated to read first (not weakened)
- [x] Docs: `packages/xpi-coding-agent/docs/settings.md` (the setting), the tool docs that describe `edit`/`write`,
      `docs/xin-pi.md` if it lists xin-pi's differences from pi

## Comments

2026-11-10: **no size/mtime fast path.** `edit` reads the whole file anyway and custom operations cannot stat, so every check hashes the content (SHA-256, trailing spaces/tabs and CR ignored).

**`write` says "before overwriting it"**, `edit` says "before editing" (review).

**Fingerprints are recorded even when `staleEditGuard` is off**, so turning it on mid-session does not forget what was read (review).

**Tools created one by one have no store** (`createEditTool(cwd)`, SDK and examples): they behave as before unless given `fileState`. Real-model subagent suites not run.
