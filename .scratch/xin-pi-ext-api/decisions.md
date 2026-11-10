# Decisions

Four extension-API additions from the omp study, so that the planned packages can be built as packages:

- `01-tool-effects.md`: every tool has an effect (`read` / `write` / `exec`) that packages can read.
- `02-stream-interrupt.md`: a `message_update` handler can interrupt the stream and retry the turn with a reminder.
- `03-side-model-call.md`: `ctx.complete` for side model calls with auth, retries, schema and cost accounting.
- `04-path-schemes.md`: `registerScheme` so file tools resolve `name://...` paths through a package.

Then the packages, in this order (owner, 2026-11-10): `/review` and `/commit` workflows; a safety package (plan mode,
approval, protected paths); post-edit diagnostics; stream rules (TTSR); secrets placeholders. Second batch: advisor,
memory, auto-thinking, ast-grep.

Facts were checked against main `1b622c231` on 2026-11-10 (four read-only investigations). Claude API facts from the
claude-api reference: assistant prefill and forced `tool_choice` (`any`/`tool`) return 400 on current Claude models.

## Grill 1 (2026-11-10): accepted (owner answered "all yes"); all four APIs merged (#34, #35, #37, #38)

Each line is worded so "yes" accepts the proposal; the owner accepted all 17.

Order

1. The four APIs land in the order 01 tool effects → 02 stream interrupt → 03 `ctx.complete` → 04 path schemes, one PR
   each (smallest first; 01 and 02 unblock the first packages, 04 is the largest and no first-batch package needs it).
   The real-model Haiku regression runs after 02 (it touches the agent loop) and again at the end.

Tool effects (`01`)

2. Three effects, `read` / `write` / `exec`; an undeclared tool is `exec`; an MCP tool is `read` when its server marks
   it `readOnlyHint`, otherwise `write` (omp treats every MCP tool as `write`).
3. Static per tool in this version (no effect computed from the call's arguments, so `bash` is always `exec`).
4. Built-ins: `read` for read, grep, find, ls, tool_search; `write` for edit, write, SendMessage; `exec` for bash,
   powershell, Agent, Workflow, codemode.
5. The subagent extension's read-only agents (Plan, Explore, read-only memory) keep their name lists for now; only the
   examples (plan-mode, protected-paths, permission-gate) move to effects.

Stream interrupt (`02`)

6. Discard only: the abandoned attempt is hidden from the model (kept in the session file) and the reminder is appended
   as a hidden custom message; no prefill, no keeping the partial output.
7. At most 3 interrupts per user prompt; after that interrupts are ignored and the stream finishes.
8. The abandoned attempt's cost is counted in the totals; an interrupt does not use up an error retry.

`ctx.complete` (`03`)

9. Result `{ text, value?, usage, model }`; errors throw with a kind (`errorKind` values plus `aborted`, `no_model`,
   `no_auth`, `schema`); retries only `transient` and `rate_limit`, with the session's retry settings.
10. Schemas by prompt-and-validate: ask for JSON, validate with the existing validator, retry up to 2 times quoting the
    error (no forced tool choice).
11. Model references: `inherit`, an alias, or `provider/id`. A new shared `settings.models` alias table; the subagent
    extension reads it after its own `subagent.models`, so existing settings keep working. Named roles (`@judge`) later.
12. Every billed attempt is recorded as a usage entry `ext:<purpose>`, so the footer cost includes side calls.

Path schemes (`04`)

13. Two kinds of scheme: virtual (the handler returns content and may accept writes) and file-backed (the handler
    locates a real file and all tools work on it).
14. Registered schemes are listed in the system prompt, one line each, in registration order.
15. `grep`, `find` and `ls` refuse virtual schemes with "use read"; bash does not understand schemes (said in the
    system prompt line).
16. Names `http`, `https`, `file`, `data` are reserved; registering a name twice fails at load time.

Process

17. Tickets after this Grill, one per spec; Sonnet implementers in worktrees, review, `./test.sh`, CI, merge, like the
    resilience specs.
