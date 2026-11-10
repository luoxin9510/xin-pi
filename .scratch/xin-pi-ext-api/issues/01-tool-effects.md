# 01: Tool effects

Spec: `../01-tool-effects.md`, decisions 2-5 in `../decisions.md`.

**What to build:** every tool carries a static `effect` (`read`, `write` or `exec`). Built-in tools declare it,
extension tools may declare it, MCP tools derive it from `readOnlyHint`, and an undeclared tool counts as `exec`. The
`tool_call` event and `getAllTools()` expose it, so a package can gate tools without a list of names.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] `effect?: "read" | "write" | "exec"` on the extension `ToolDefinition` and on `AgentTool`, carried through the
      definition wrapper; one exported `ToolEffect` type
- [ ] Built-ins: `read` for read, grep, find, ls, tool_search; `write` for edit, write, SendMessage; `exec` for bash,
      powershell, Agent, Workflow, codemode
- [ ] MCP tools: `annotations.readOnlyHint === true` → `read`, otherwise `write`
- [ ] One resolver for the effective effect (declared, else `exec`), used by the `tool_call` event and `getAllTools()`
- [ ] `tool_call` event gains `effect`; `ToolInfo` from `getAllTools()` gains `effect`
- [ ] Examples plan-mode, protected-paths and permission-gate decide by effect where tool names were only a stand-in
      for the effect
- [ ] The subagent extension's read-only agents are not changed
- [ ] Tests: an inline extension observes `effect` on `tool_call` for a built-in, an extension tool with and without a
      declaration, and an MCP tool with and without `readOnlyHint`; `getAllTools()` lists effects
- [ ] Docs: `packages/xpi-coding-agent/docs/extensions.md` (field, event, `ToolInfo`, default), the examples README if
      it describes the changed examples, `docs/xin-pi.md` if it lists xin-pi's differences from pi

## Comments
