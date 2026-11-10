# 04: Path schemes for file tools (`registerScheme`)

Status: draft, waiting for Grill 1 (`decisions.md`). No code until the owner approves.

Origin: omp's internal URL router: `pr://1428`, `skill://name`, `conflict://1` and others resolve inside every
file-shaped tool, so the model learns one interface (`read`/`write`) instead of a tool per resource. See
`~/Developer/omp-study/04-工具系统/内部URL路由-scheme协议.md`.

## Problem Statement

A package that exposes a resource (a GitHub PR, a skill, a merge conflict, a note in a vault) must add a tool for it,
with its own parameters for the model to learn. xpi's file tools know only paths: `read pr://1` resolves to
`<cwd>/pr:/1` and fails with "not found".

## Solution

`pi.registerScheme(name, handler)` lets a package own `name://...` paths. The built-in `read`, `write`, `edit`, `ls`,
`grep` and `find` route such paths to the handler. A handler either returns content (a virtual resource, read and
optionally written through the handler) or locates a real file (then every tool works on it unchanged, including the
stale-edit guard). Registered schemes are listed in the system prompt, one line each.

## User Stories

1. As a package author, I want `read pr://123` to return my rendering of the PR, so that the model needs no new tool.
2. As a package author, I want `write conflict://1` to reach my handler, so that a write can perform an action.
3. As a package author, I want a scheme that points at real files (`skill://name` → the SKILL.md), so that edit, grep
   and the stale-edit guard work on it for free.
4. As the owner, I want registered schemes listed in the system prompt, so that the model knows they exist.
5. As the owner, I want `edit` on a read-only scheme to fail clearly, so that the model does not loop.
6. As the owner, I want `grep`, `find` and `ls` on a virtual scheme to say "use read", so that the failure is useful.
7. As the owner, I want codemode's `read("pr://1")` to work, since it calls the same tools.
8. As a package author, I want paging (`offset`/`limit`) and truncation to work on virtual content, so that long
   resources behave like files.
9. As the owner, I want a scheme name collision to fail at load time, so that two packages cannot silently fight.

## Implementation Decisions

- One shared resolver used by the six file tools, injected with the session's tools like the file-state store: a path
  becomes either a file path or a virtual resource.
- Handler: `describe` (one line for the system prompt), `resolve(url)` → `{ content, contentType? }` for virtual
  schemes, `locate(url)` → absolute path for file-backed schemes, optional `write(url, content)`, optional
  `readOnly`.
- Virtual reads go through the same line selection and truncation as files; the truncation hint does not suggest
  `sed` for a virtual path.
- Virtual writes are queued per URL; the stale-edit guard keys virtual resources by URL.
- `grep`, `find`, `ls` work on file-backed schemes (on the located path) and refuse virtual ones.
- Bash does not understand schemes; the scheme lines in the system prompt say so.
- Reserved names: `http`, `https`, `file`, `data` (Grill question 16).

## Testing Decisions

- Tool-level tests with an inline extension registering a virtual and a file-backed scheme: read with paging, write
  through the handler, edit on read-only refused, edit on a file-backed path with the stale guard, grep refusal,
  codemode read, collision error, system prompt lines.
- Prior art: `test/tools.test.ts`, `test/stale-edit-guard.test.ts`, extension loading tests.

## Out of Scope

- Any built-in scheme (pr, skill, conflict and others come as packages).
- Images from virtual schemes.
- Scheme paths inside bash.
- Approval tiers per scheme (spec 01 covers tool effects; a scheme write is the tool's effect).

## Further Notes

omp's `SchemeSpec` has many more fields (selectors, authorities, artifact stores); this keeps the two backings that
cover the known packages.
