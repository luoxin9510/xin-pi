# 05: Agent-file fields that had no effect, and `--agents`

Spec: `../05-inert-fields.md`. Branch `subagent-inert-fields`.

**Status:** done (2026-11-10)

- [x] T1 `mcpServers` by name (`definition.ts`, `resolve.ts`): with a `tools` list the servers' tools join it as
      `mcp__<server>__*`; without one the other configured servers are excluded; `[]` is no MCP; an unknown name and an
      inline definition warn
- [x] T2 `background: true` (`agent-tool.ts`): stands in for an omitted `run_in_background`; the call's value wins; a
      resume of such an agent follows it; print mode waits
- [x] T3 `--agents` (`discovery.ts`, `index.ts`): a JSON object or a JSON file path, Claude Code's shape; ranks above
      every file; bad JSON stops the start, a bad entry is skipped with a warning
- [x] T4 The fields that stay inert (`permissionMode`, `hooks`, `initialPrompt`, `autoCompactWindow`, `experimental`)
      say why in the warning
- [x] Offline: `test/subagent/faults/mcp-servers.test.ts` (5), `background-field.test.ts` (4), `cli-agents.test.ts` (5,
      one starts a real xpi with the flag and fake children)
- [x] Real, haiku: `test/subagent/real/20-fields.test.ts`
- [x] Docs: `docs/subagent.md` (fields table, Agents on the command line, MCP), `docs/cli.md`, `docs/xin-pi.md`

## Comments

2026-11-10: **The unknown-server warning is in the call's result, not at discovery.** The spec said discovery; the
configured servers depend on the cwd and on project trust, which the call knows. The inline-definition warning is at
discovery (it needs only the file).

**Without a `tools` list, narrowing is by exclusion.** `--tools` in modifier form (`+codemode`) is not an allowlist, so
the servers the agent does not name are passed to `--exclude-tools`. Servers registered by an extension at run time are
not in `mcp.json` and are not excluded (documented).

**A slip:** a stray `git checkout` of `definition.ts` dropped the uncommitted T1 parsing; it was replayed from the edit
script before anything was committed.
