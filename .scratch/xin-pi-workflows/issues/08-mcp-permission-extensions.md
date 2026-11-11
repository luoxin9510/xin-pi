# 08: Inline MCP servers, permissionMode, per-agent extensions

Spec: `../08-mcp-permission-extensions.md`. One branch per PR.

**Status:** done: PR 1 #57, PR 2 #59, PR 3 #61; regression passed

## PR 1: inline MCP servers and `--mcp-config` (branch `subagent-inline-mcp`)

- [x] T1 `--mcp-config <file or JSON>` in the MCP extension (`extensions/mcp/`): one value; same schema as `mcp.json`,
      added after the agent dir and project config (a name it repeats replaces that server); entries the validator
      rejects (`sse`, `ws`, bad shape) skipped with its message as a warning; JSON or a file that does not parse stops
      the start; scope `cli`, listed by `/mcp`, changes not saved
- [x] T2 `discovery.ts`, `definition.ts`: `AgentDefinition.scope` (`project` | `user` | `cli` | `builtin`) set by
      discovery; inline entries of `mcpServers` (mapping form and list-of-mappings form) kept next to the names,
      validated with the `mcp.json` validator (invalid: warning, dropped); `project` entries with `auth: { provider }`
      dropped with a warning
- [x] T3 `resolve.ts`: inline servers (scope `user`, `cli`, `builtin`, or `project` in a trusted project; skipped with a
      warning otherwise) passed as `--mcp-config '<json>'`; same name as a configured server replaces it; a tool
      namespace collision skips with a warning; tools as for named servers; part of `prefixKey`
- [x] Offline tests (fake child: argv, trust, auth rule, collisions, tools list); real Haiku: an agent whose inline stdio
      server is a tiny test MCP server answers from its tool
- [x] Docs: `docs/subagent.md` (fields table, MCP, OAuth note), `docs/subagent-porting.md` (`ResolveOptions`, scope),
      `docs/mcp.md`, `docs/cli.md` (`--mcp-config`)
- Found while implementing: an error thrown by a `session_start` handler does not stop a run, so `--agents` never
  stopped the start as the spec assumed. A core `validate(value, cwd)` on string extension flags now does it for both
  `--agents` and `--mcp-config` (documented in `docs/xin-pi.md`). The validator also names unsupported types (`ws`).

## PR 2: `permissionMode` (branch `subagent-permission-mode`)

- [x] T4 `definition.ts`: `permissionMode` parsed (`default`, `manual`, `acceptEdits`, `auto`, `dontAsk`,
      `bypassPermissions`, `plan`); unknown value skips the file; values other than `plan` give one discovery warning;
      no longer inert
- [x] T5 `resolve.ts`: `plan` as an allowlist (`read`, `grep`, `find`, `ls`, `codemode` for codemode-only children,
      `StructuredOutput` with a schema; intersected with a `tools` list) plus `--exclude-tools`
      `write,edit,bash,powershell,mcp__*`; `mcpServers` ignored with a warning; memory read-only through
      `memoryReadOnly` with plan wording; read-only line in the prompt tail; `disallowedTools` still applies
- [x] Offline tests (argv for each combination: tools list, none, codemode-only, schema, memory, mcpServers), real
      Haiku: a `plan` agent asked to write a file cannot, and says so
- [x] Docs: `docs/subagent.md`
- Implementation notes: a `plan` child also gets `--no-mcp` (no server starts; `mcp__*` alone missed the resource
  tools). With the fixed `--tools` list no extension tool registers either, so `plan` is stricter than decision 3's
  "extensions' tools are not policed": extension event handlers still run, their tools do not exist. Memory adds
  `read`.

## PR 3: `extensions` (branch `subagent-extensions`)

- [x] T6 `definition.ts`: `extensions` (a list or a comma string); local paths (`isLocalPath`) resolved with
      `resolvePath` against the agent file's directory (`--agents`: the cwd) to absolute paths; package sources and
      `builtin:<name>` passed as given; a missing local path is a warning at discovery
- [x] T7 `resolve.ts`: each passed to the child as `-e`, by `scope` and trust as for inline servers (skipped with a
      warning otherwise); part of `prefixKey`; with `--strict-extensions` whenever there are any
- [x] T7a core: `--strict-extensions` (`cli/args.ts`, `resource-loader.ts`/`main.ts`): an explicit `-e` that fails to
      install, does not exist or throws while loading stops the start with the error; a child that stops this way gives
      a `failed` result with it
- [x] T8 `hooks` warning points to `extensions`
- [x] Offline tests; real Haiku: an extension that blocks `bash` in the child (`tool_call`), the agent reports the block
- [x] Docs: `docs/subagent.md`, `docs/extensions.md` (a note), `docs/subagent-porting.md`, `docs/cli.md`
      (`--strict-extensions`), `docs/xin-pi.md` (core change)
- Notes: `--strict-extensions` only changes install failures (the rest already stopped the start); an untrusted
  project agent with `extensions` fails the call instead of skipping them (spec "Revisions").

## After the three

- [x] Full real-model regression on main e6e96329e: `test:subagent:real` 96/96, `:parent` 13/13, `:tui` 17/17,
      `:evals` 22/22 ($0.011), `test:relay:real` 1/1
- [x] Roadmap status: subagent work wrapped up
