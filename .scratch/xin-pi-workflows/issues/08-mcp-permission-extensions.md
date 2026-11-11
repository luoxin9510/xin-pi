# 08: Inline MCP servers, permissionMode, per-agent extensions

Spec: `../08-mcp-permission-extensions.md`. One branch per PR.

**Status:** not started

## PR 1: inline MCP servers and `--mcp-config` (branch `subagent-inline-mcp`)

- [ ] T1 `--mcp-config <file or JSON>` in the MCP extension (`extensions/mcp/`): repeatable or one value, same schema
      as `mcp.json`, added after the agent dir and project config (a name it repeats replaces that server); `sse`/`ws`
      entries skipped with a warning; a file that does not parse stops the start with the reason
- [ ] T2 `definition.ts`: inline entries of `mcpServers` (mapping form and list-of-mappings form) kept as definitions
      next to the names; validated with the `mcp.json` validator; an invalid one is a warning and dropped
- [ ] T3 `resolve.ts`: inline servers (only from user-level files, `--agents`, or a trusted project's file) written to a
      file in the child's session dir and passed as `--mcp-config`; tools as for named servers; skipped with a warning in
      an untrusted project
- [ ] Offline tests (fake child: argv, the written config, trust, tools list), real Haiku: an agent whose inline stdio
      server is a tiny test MCP server answers from its tool
- [ ] Docs: `docs/subagent.md` (fields table, MCP), `docs/mcp.md`, `docs/cli.md` (`--mcp-config`)

## PR 2: `permissionMode` (branch `subagent-permission-mode`)

- [ ] T4 `definition.ts`: `permissionMode` parsed (`default`, `manual`, `acceptEdits`, `auto`, `dontAsk`,
      `bypassPermissions`, `plan`); unknown value skips the file; no longer inert
- [ ] T5 `resolve.ts`: `plan` keeps `read`, `grep`, `find`, `ls` (and codemode), excludes `write`, `edit`, `bash`, makes
      agent memory read-only, adds the read-only line to the prompt tail; other values add the one warning
- [ ] Offline tests, real Haiku: a `plan` agent asked to write a file cannot, and says so
- [ ] Docs: `docs/subagent.md`

## PR 3: `extensions` (branch `subagent-extensions`)

- [ ] T6 `definition.ts`: `extensions` (a list or a comma string) resolved against the agent file's directory; package
      sources and `builtin:<name>` passed as given; a missing path is a warning at discovery
- [ ] T7 `resolve.ts`: each passed to the child as `-e`, only from user-level files, `--agents` (relative to the cwd) or a
      trusted project's file; skipped with a warning otherwise; part of the prompt-cache prefix key
- [ ] T8 `hooks` warning points to `extensions`
- [ ] Offline tests, real Haiku: an extension that blocks `bash` in the child (`tool_call`), the agent reports the block
- [ ] Docs: `docs/subagent.md`, `docs/extensions.md` (a note), `docs/xin-pi.md` if core changes

## After the three

- [ ] Full real-model regression: `test:subagent:real`, `:parent`, `:tui`, `:evals`, relay real
- [ ] Roadmap status: subagent work wrapped up
