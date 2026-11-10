# 04: Path schemes (`registerScheme`)

Spec: `../04-path-schemes.md`, decisions 13-16 in `../decisions.md`.

**What to build:** `pi.registerScheme(name, handler)` lets a package own `name://...` paths in `read`, `write`, `edit`,
`ls`, `grep` and `find`. Virtual schemes return content (and may accept writes); file-backed schemes locate a real file
and every tool works on it. Registered schemes are listed in the system prompt.

**Blocked by:** None (lands last by the agreed order)

**Status:** done (PR #38, merged 2026-11-10)

- [x] `registerScheme(name, { describe, resolve?, locate?, write?, readOnly? })`; exactly one of `resolve`/`locate`
- [x] Reserved names `http`, `https`, `file`, `data`; a duplicate name fails at load time naming both sources
- [x] One shared resolver, injected with the session's tools like the file-state store
- [x] Virtual reads use the same line selection, paging and truncation as files; the truncation hint does not suggest
      `sed` for a virtual path
- [x] Virtual writes go through `write`, queued per URL; `edit` on a virtual scheme reads via `resolve` and writes via
      `write`; read-only or no `write` → clear error
- [x] Stale-edit guard keys virtual resources by URL; file-backed paths use the located real path
- [x] `grep`, `find`, `ls`: file-backed work on the located path; virtual refused with a "use read" message
- [x] System prompt: one line per scheme in registration order, saying bash does not understand schemes
- [x] Codemode `read("x://...")` works (same tools)
- [x] Tests: inline extension with a virtual and a file-backed scheme: paged read, write through the handler, read-only
      edit refused, file-backed edit with the stale guard, grep refusal, codemode read, collision and reserved-name
      errors, system prompt lines
- [x] Docs: `packages/xpi-coding-agent/docs/extensions.md`, tool docs for the six tools, `docs/xin-pi.md`

## Comments

- Types `SchemeHandler`/`SchemeContent` in `extensions/types.ts`; registry and validation in `src/core/schemes.ts`;
  resolver in `src/core/tools/scheme-resolver.ts`. Duplicate check is at call time against the runtime registry plus
  the extension's own pending names; schemes commit with the extension, so a failed load registers nothing.
- Decision: `write` together with `locate` is rejected at registration (a file-backed scheme writes the located file);
  `readOnly` is allowed on file-backed schemes and refuses `write`/`edit`.
- Decision: `write` on a virtual resource whose `resolve` throws counts as creating it (no guard check). After a
  `write`/`edit` the guard records the written content, not a fresh `resolve`.
- Decision: the `schemes` prompt section is also rendered with a custom system prompt. Schemes registered after load
  show up when the prompt is next rebuilt (no change listener).
- Deviation: a first line over the byte limit on a virtual path reads "... cannot be shown" (no bash fallback exists).
- Tests: `test/path-schemes.test.ts` (27), `test/suite/path-schemes-session.test.ts` (4).

2026-11-10: final real-model Haiku regression on main fb1f55493 (all four APIs): `test:subagent:real` 91/91, `:parent`
12/12, `:tui` 16/16, `test:upstream:real` 1/1.
