# 01: Tool effects

Spec: `../01-tool-effects.md`, decisions 2-5 in `../decisions.md`.

**What to build:** every tool carries a static `effect` (`read`, `write` or `exec`). Built-in tools declare it,
extension tools may declare it, MCP tools derive it from `readOnlyHint`, and an undeclared tool counts as `exec`. The
`tool_call` event and `getAllTools()` expose it, so a package can gate tools without a list of names.

**Blocked by:** None (can start immediately)

**Status:** in review

- [x] `effect?: "read" | "write" | "exec"` on the extension `ToolDefinition` and on `AgentTool`, carried through the
      definition wrapper; one exported `ToolEffect` type
- [x] Built-ins: `read` for read, grep, find, ls, tool_search; `write` for edit, write, SendMessage; `exec` for bash,
      powershell, Agent, Workflow, codemode
- [x] MCP tools: `annotations.readOnlyHint === true` → `read`, otherwise `write`
- [x] One resolver for the effective effect (declared, else `exec`), used by the `tool_call` event and `getAllTools()`
- [x] `tool_call` event gains `effect`; `ToolInfo` from `getAllTools()` gains `effect`
- [x] Examples plan-mode, protected-paths and permission-gate decide by effect where tool names were only a stand-in
      for the effect
- [x] The subagent extension's read-only agents are not changed
- [x] Tests: an inline extension observes `effect` on `tool_call` for a built-in, an extension tool with and without a
      declaration, and an MCP tool with and without `readOnlyHint`; `getAllTools()` lists effects
- [x] Docs: `packages/xpi-coding-agent/docs/extensions.md` (field, event, `ToolInfo`, default), the examples README if
      it describes the changed examples, `docs/xin-pi.md` if it lists xin-pi's differences from pi

## Comments

- `ToolEffect` is declared in `xpi-agent-core` (next to `ToolExecutionMode`) and re-exported from `xpi-coding-agent`.
  The resolver is `resolveToolEffect` in `core/tools/tool-definition-wrapper.ts`; the `tool_call` event looks the
  definition up by tool name in the session's definition registry (unknown name: `exec`).
- plan-mode now disables every active tool whose effect is `write` (looked up with `getAllTools()`), so its existing
  test mock gained a `getAllTools`. permission-gate checks `effect === "exec"` plus a string `command` input, so it also
  covers `powershell`. protected-paths checks `effect === "write"` plus a string `path` input.
- MCP test is unit-level: tools from `createMcpToolDefinition` are registered by an inline extension and called through
  the faux provider; no MCP server.
