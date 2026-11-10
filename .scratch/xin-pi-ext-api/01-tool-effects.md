# 01: Tool effects

Status: draft, waiting for Grill 1 (`decisions.md`). No code until the owner approves.

Origin: the omp study (tools carry an approval tier `read | write | exec`; plan mode and approval read it) and the
owner's list of packages to build (a plan-mode/approval package first).

## Problem Statement

A package that wants to treat read-only tools differently from tools that change things (plan mode, an approval gate,
a read-only agent) has to hard-code tool names: the plan-mode example lists `edit` and `write`, `protected-paths`
checks `write` and `edit`, `permission-gate` checks `bash`, the built-in Plan and Explore agents disallow `Write, Edit`
by name. A tool added by another package or by an MCP server is invisible to all of them.

Half of a mechanism exists: `ToolDefinition` has MCP-style `annotations` (`readOnlyHint`, `destructiveHint`), and the
MCP extension fills them from servers. But no built-in tool declares them, the wrapper that turns a definition into an
agent tool drops them, and the `tool_call` event carries only the name and the input.

## Solution

Every tool has an effect: `read` (looks, changes nothing), `write` (changes files or agent state) or `exec` (runs
arbitrary code or processes). Built-in tools declare it; extension tools may declare it; MCP tools get it from their
annotations; a tool without one counts as `exec`. The `tool_call` event and `getAllTools()` carry it, so a package can
write "block every tool whose effect is not read" without knowing any names.

## User Stories

1. As a package author, I want each `tool_call` event to tell me the tool's effect, so that my gate needs no list of
   names.
2. As a package author, I want `getAllTools()` to list each tool's effect, so that I can switch to a read-only tool set.
3. As a package author, I want to declare the effect of the tools I register, so that other packages treat them right.
4. As the owner, I want an undeclared tool to count as `exec`, so that a forgotten declaration fails safe.
5. As the owner, I want MCP tools marked read-only by their server to count as `read`, and other MCP tools as `write`,
   so that MCP servers work with plan mode without configuration.
6. As the owner, I want the existing examples (plan-mode, protected-paths, permission-gate) to use effects, so that the
   examples teach the new way.
7. As a maintainer, I want the effect declared once on the tool, so that the scheduler, the gate and the docs cannot
   disagree.

## Implementation Decisions

- An `effect` field on the tool definition and on the agent tool, carried through the definition wrapper; static only
  in this version (per-call effects are Grill question 3).
- Built-in assignments (Grill question 4): `read`: read, grep, find, ls, tool_search; `write`: edit, write,
  SendMessage; `exec`: bash, powershell, Agent, Workflow, codemode.
- MCP: `readOnlyHint` true → `read`; otherwise `write`.
- Default when undeclared: `exec`.
- The `tool_call` event gains `effect`; `ToolInfo` from `getAllTools()` gains `effect`.
- Examples updated; the subagent extension's read-only agents are not changed in this spec (Grill question 5).

## Testing Decisions

- Tests assert on what an extension observes: the `effect` on `tool_call` events for built-in, extension, MCP and
  undeclared tools, and in `getAllTools()`.
- Prior art: extension event tests in `packages/xpi-coding-agent/test/` that load an inline extension and run the faux
  provider (`test/suite/harness.ts`).

## Out of Scope

- An approval or plan-mode package (built later on top of this).
- Concurrency (`exclusive`/`shared`) declarations.
- Effects computed from arguments (for example a read-only `bash` command).

## Further Notes

`annotations` stays for MCP compatibility; `effect` is the field packages read.
