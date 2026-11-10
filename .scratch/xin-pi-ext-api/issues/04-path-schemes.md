# 04: Path schemes (`registerScheme`)

Spec: `../04-path-schemes.md`, decisions 13-16 in `../decisions.md`.

**What to build:** `pi.registerScheme(name, handler)` lets a package own `name://...` paths in `read`, `write`, `edit`,
`ls`, `grep` and `find`. Virtual schemes return content (and may accept writes); file-backed schemes locate a real file
and every tool works on it. Registered schemes are listed in the system prompt.

**Blocked by:** None (lands last by the agreed order)

**Status:** ready-for-agent

- [ ] `registerScheme(name, { describe, resolve?, locate?, write?, readOnly? })`; exactly one of `resolve`/`locate`
- [ ] Reserved names `http`, `https`, `file`, `data`; a duplicate name fails at load time naming both sources
- [ ] One shared resolver, injected with the session's tools like the file-state store
- [ ] Virtual reads use the same line selection, paging and truncation as files; the truncation hint does not suggest
      `sed` for a virtual path
- [ ] Virtual writes go through `write`, queued per URL; `edit` on a virtual scheme reads via `resolve` and writes via
      `write`; read-only or no `write` → clear error
- [ ] Stale-edit guard keys virtual resources by URL; file-backed paths use the located real path
- [ ] `grep`, `find`, `ls`: file-backed work on the located path; virtual refused with a "use read" message
- [ ] System prompt: one line per scheme in registration order, saying bash does not understand schemes
- [ ] Codemode `read("x://...")` works (same tools)
- [ ] Tests: inline extension with a virtual and a file-backed scheme: paged read, write through the handler, read-only
      edit refused, file-backed edit with the stale guard, grep refusal, codemode read, collision and reserved-name
      errors, system prompt lines
- [ ] Docs: `packages/xpi-coding-agent/docs/extensions.md`, tool docs for the six tools, `docs/xin-pi.md`

## Comments
