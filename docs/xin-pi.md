# xin-pi

xin-pi is an independent fork of [pi](https://github.com/earendil-works/pi) by earendil-works (MIT; the original
copyright notice is kept in `LICENSE`). It follows its own course: upstream is never merged, only read and ported from.
This document is the single place that says what differs from upstream pi and how to keep up with it. Paths are
relative to the repo root; `coding-agent/` stands for `packages/xpi-coding-agent/`.

## Product line

- Command `xpi` (`bin.xpi` and `piConfig.name: "xpi"` in `packages/xpi-coding-agent/package.json`). The config directory
  stays the shared `~/.pi/agent` (and `.pi/` in projects); override the agent dir with `XPI_CODING_AGENT_DIR` and the
  session dir with `XPI_CODING_AGENT_SESSION_DIR`.
- Packages are unscoped `xpi-*`, directory name equal to package name: `xpi-ai`, `xpi-agent-core`, `xpi-tui`,
  `xpi-coding-agent`, `xpi-codemode`, `xpi-mcp`, `xpi-schema`, `xpi-telemetry`, `xpi-evals`, `xpi-roost`. All share one
  version. Only `xpi-coding-agent` (the CLI, a self-contained bundle) is published to npm; see [Releasing](#releasing).
- `xpi-roost` (private) is pi-roost's daemon, PTY host and library, ported for background sessions (spec:
  `.scratch/xpi-roost/01-roost-core.md`). It imports nothing of xpi: the caller gives it the agent directory and the
  daemon and host entry files, and they travel to the daemon, hosts and sessions in `ROOST_*` variables. State is in
  `<agent dir>/xpi-roost/`, sockets in a runtime directory keyed by the agent directory, settings in the `"roost"` section
  of `settings.json`. Its README, `docs/protocol.md` and `docs/port-inventory.md` describe it. `builtin:roost`
  (`xpi --bg`, `/bg`) and the hub are not there yet.
- `xpi roost <subcommand>` (user docs: [CLI](../packages/xpi-coding-agent/docs/cli.md#background-session-commands)) is
  dispatched in `coding-agent/src/main.ts` next to `xpi mcp`, through `src/extensions/roost/cli.lazy.ts`. The commands
  live in `xpi-roost/src/cli.ts` (`runRoostCli`); `src/extensions/roost/cli.ts` supplies the agent directory, the entry
  files (`getRoostEntries()` in `config.ts`), the detach key (a matcher over the user's `app.suspend` binding: the
  library has no key of its own) and the messages for Windows and a standalone binary. Without node-pty only what
  starts a session process is refused (`respawn`, `attach` to a session that is not running: xpi-roost's
  `ptyInstalled`). The daemon runs as `node <roost-daemon.js>`.
- Bundle: `scripts/build-coding-agent-bundle.mjs` builds `roost-daemon.js` and `roost-host.js` from xpi-roost's built
  `dist/daemon/main.js` and `dist/host/main.js` into the chunk directory, next to `config.ts`'s chunk, where
  `resolveRoostEntries` looks for them (like `codemode-worker.js`). Unbundled runs resolve `xpi-roost/daemon` and
  `xpi-roost/host` (their `dist`). xpi-roost is a `devDependency` of coding-agent and is inlined, `@xterm/headless` and
  `@xterm/addon-serialize` too (pure JS, in the host entry only). node-pty is the one external; the build fails if
  any output other than the host imports it. `npm run build` builds xpi-roost (`tsc -p tsconfig.build.json`) before
  coding-agent, and `check-entry-graphs.mjs` budgets its three entries (`.`, `./daemon`, `./host`), each forbidden to
  pull in the others.
- node-pty is an `optionalDependencies` entry of `xpi-coding-agent` (pinned), so an install that cannot compile it on
  Linux still succeeds; `xpi roost respawn` and `attach` to a session that is not running then say how to get it. The install lock allows its install script
  (`allowedInstallScriptPackages` in `scripts/generate-coding-agent-install-lock.mjs`, with the reason: no Linux
  prebuild), and the generator marks packages reached only through `optionalDependencies` (node-pty, node-addon-api)
  `optional: true`.
- App-config environment variables carry the prefix `XPI_` instead of `PI_` (`XPI_OFFLINE`, `XPI_TELEMETRY`,
  `XPI_PACKAGE_DIR`, `XPI_SKIP_VERSION_CHECK`, ...). The list of renamed names is `ENV_VARS` in `scripts/xpi-rename.mjs`.
  CI secrets, build constants and release tooling variables keep their names.
- Removed from the monorepo: `packages/chord`, `packages/durable`, `packages/env`, `apps/p2`, `apps/p3` (coding-agent, ai,
  agent-core and tui did not depend on them), together with their build, workspace, tsconfig and CI wiring. The
  version check is skipped by default (`XPI_SKIP_VERSION_CHECK ??= "1"` in `coding-agent/src/cli/setup.ts`).
- Four built-in extensions, registered in `coding-agent/src/extensions/index.ts` and not replaceable:
  - `subagent` (`src/extensions/subagent/`, off with `-builtin:subagent`): the `Agent`, `SendMessage` and `Workflow` tools
    for codemode scripts, the script helpers (`agent`, `parallel`, `pipeline`, `phase`, `log`), saved workflows
    (`/<name>`, `/workflows`), built-in workflows (`builtin/workflows/*.js`, found last by `discoverWorkflows`, runnable
    in untrusted projects; today `/review`, which runs the built-in read-only `reviewer` agent in `builtin/reviewer.md`),
    the `fork` agent type and `/subtask`, the panel, `/subagents`, the `--agents` flag. Settings namespace `subagent.*`, env `XPI_SUBAGENT_*`, branches `subagent/<id>`. It was the separate
    extension pi-pipipi. User docs: [subagent.md](../packages/xpi-coding-agent/docs/subagent.md); porting contracts:
    [subagent-porting.md](../packages/xpi-coding-agent/docs/subagent-porting.md).
  - `relay` (`src/extensions/relay/`, off with `-builtin:relay`): the virtual model `relay/auto` (a lead model plans and
    reviews, a worker model builds), the `handover` and `handback` tools, `/handover`, `/handback`, `/relay`. Settings
    namespace `relay.*`. It uses the extension API only (a virtual model, the `agent_before_settle` boundary with a
    compaction draft); no core change. User docs: [relay.md](../packages/xpi-coding-agent/docs/relay.md).
  - `upstream` (`src/extensions/upstream/`, off with `-builtin:upstream`): `/upstream`, see below.
  - `commit` (`src/extensions/commit/`, off with `-builtin:commit`): `/commit [hint] [--yes]`. It builds a prompt from
    the staged diff (`context.ts`: lockfiles stat-only, diff capped at 60k characters, the commit section of
    `AGENTS.md`/`CLAUDE.md`, the last 20 subjects), asks `ctx.complete` for `{ type, scope?, summary, body? }` with the
    model of `commit.model` (default `haiku`), opens `ui.editor`, and runs `git commit -F <temp file>`. Extension API
    only; no core change besides the settings entry. Tests: `test/suite/commit.test.ts` (faux provider, temp repo).
- `coding-agent/package.json`: `copy-assets` also copies `src/extensions/subagent/builtin/*.md` to
  `dist/extensions/subagent/builtin` and `builtin/workflows/*.js` to `dist/extensions/subagent/builtin/workflows`.
  `scripts/build-binaries.sh` copies `dist/extensions/subagent/builtin` next to the standalone executable (where
  `BUILTIN_DIR` looks when there is no `src/`).
- `review.js` keeps its pure helpers between `// BEGIN helpers` and `// END helpers`; a workflow file cannot import, so
  `test/subagent/faults/review-workflow.test.ts` evaluates that section from the file itself and also runs the whole body
  with a fake `agent()` against a temp repository. The real-haiku check is `test/subagent/real/23-review.test.ts`.
- Running it: `npm install && npm run build`, then `node packages/xpi-coding-agent/dist/bundle/cli.js`, or from sources
  `./xpi-test.sh`. Subagent children run the same build as their parent (`src/extensions/subagent/invocation.ts`).
- Installing a local build without publishing: `npm run xpi:pack` cleans, builds and writes `dist-pack/xpi-coding-agent-<version>.tgz`
  (gitignored); install it with `npm i -g ./dist-pack/xpi-coding-agent-<version>.tgz`. The tarball is self-contained: the
  bundle inlines `xpi-ai`, `xpi-tui`, `xpi-agent-core`, `xpi-codemode` and `xpi-mcp`, so they are `devDependencies` of
  `xpi-coding-agent` and only third-party packages (29 in all, plus the optional node-pty and node-addon-api) are installed. `npm run check` fails if the built bundle imports
  an `xpi-*` package at runtime. The same tarball is what npm gets, and it works as a library (SDK) too. The repository's
  package folder is not self-contained (its `dist/index.js` imports the workspace packages); the published package is made
  from it by `scripts/coding-agent-publish.mjs`: `main` and the `"."` import point at the
  self-contained `dist/bundle/index.js`, and the declaration files of the workspace packages it refers to are copied into
  `dist/vendor/<package>/` with every `xpi-*` specifier in the `.d.ts` files rewritten to a relative path. The repository's
  own `package.json` keeps the unbundled `dist/index.js`, so workspace consumers (`xpi-evals`, tests) are unchanged.
  `npm run xpi:pack` and `npm run release:local` both pack this way; `release:local` imports the SDK from an isolated
  npm install. Type checking a consumer needs `skipLibCheck: true`: the declarations also refer to packages that are not
  installed (provider SDKs, the MCP SDK, `marked`) and import JSON without import attributes. Checked with a clean
  consumer (`module: nodenext`, `strict`), including the custom message roles that `declare module` adds. Development alternative: `npm link` in
  `packages/xpi-coding-agent` after `npm run build`. Verified with a private prefix (`npm i -g --prefix <tmp> <tarball>`, then `<tmp>/bin/xpi --version`,
  `--help`, `--list-models` from another directory with `XPI_CODING_AGENT_DIR` set to a temp dir).
- `npm run build` removes `packages/xpi-coding-agent/dist` first, so files of deleted sources are never packed.
- Self-update is disabled: `xpi update --self` (and plain `xpi update`) says to reinstall xpi the way it was installed
  (npm, a release binary, or a rebuild from source) and exits 1; `xpi update --extensions|--models|--all` work as before. The latest-version check never runs, so
  there is no update notice (`XPI_SKIP_VERSION_CHECK` is moot). `XPI_SELF_UPDATE_COMMAND` / `selfUpdateCommand` are unused.
- Extensions written for upstream pi import `@earendil-works/*`. There are no compatibility aliases (decision 29): such an
  extension may fail to load until it is translated, see the next section.

## Keeping up with pi

xin-pi does not merge upstream. The `upstream` remote stays for reading. The fork point is
`git merge-base main upstream/main`.

1. Ask for the list: run `/upstream` in xpi (details below). It fetches, lists upstream commits since the fork point, flags
   files changed on both sides, and recommends PORT / ADAPT / SKIP for each. Read-only.
2. Port what you chose, on a branch. For a small upstream commit:
   ```bash
   git format-patch -1 <sha> --stdout > /tmp/port/x.patch      # outside the repo
   node scripts/xpi-rename.mjs /tmp/port/x.patch               # packages/ai -> packages/xpi-ai, @earendil-works/pi-ai -> xpi-ai, PI_* -> XPI_*
   git apply --check /tmp/port/x.patch && git apply /tmp/port/x.patch
   ```
   For a larger change, cherry-pick, then run the script on the files it touched, or rewrite by hand. Where a changed
   file is one of the xin-pi core changes in this document, rewrite instead of resolving conflicts mechanically.
3. `node scripts/xpi-rename.mjs --check <paths>` must be clean, then `npm run check`, then the tests of the touched
   package (see Testing). No changelog entry: xin-pi keeps none (`AGENTS.md`).

`scripts/xpi-rename.mjs` is table-driven (`PACKAGES`, `NAMES`, `ENV_VARS`, `KEEP_SCOPED`): `node scripts/xpi-rename.mjs`
rewrites the whole repo, `<path>...` only the given files or directories, `--check` reports leftovers (exit 1),
`--dry-run` lists what would change. It is idempotent, and a line containing `xpi-rename-keep` is never touched. A new
upstream package or environment variable means a new table entry. Names under `@earendil-works/` that are not ours
(`gondolin`) stay. Files that are about upstream's own names (this document, the root README, `subagent-porting.md`, `/upstream`'s
`data.ts` and its tests) are listed in `SKIP_PREFIXES` and are neither rewritten nor checked.

Translating a third-party extension that targets upstream pi (pi-roost, critic-guy, pi-mobile, ...): copy it, run
`node scripts/xpi-rename.mjs <its directory>` (imports of `@earendil-works/pi-coding-agent`, `pi-ai`, `pi-tui` and
`pi-agent-core` become `xpi-coding-agent`, `xpi-ai`, `xpi-tui`, `xpi-agent-core`; `PI_*` names become `XPI_*`), fix its
`package.json` dependencies by hand, and load it with `xpi -e <dir>` to see if it works. Nothing does this at load time.

Dry run of the procedure (2026-11-09, recorded in ticket 07): upstream had no commits after the fork point, so the
upstream commit `566344046` (a 3-line retry-pattern fix in `packages/ai`) was reverted in our tree on a throwaway branch,
then ported with the steps above. The renamed patch applied cleanly, `xpi-rename --check` was clean, the package's
retry test passed and `npm run check` was green. The branch was not merged.

## Releasing

One version for every package. Two steps, each from an up-to-date `main`:

1. `npm run release:patch` (or `release:minor`, `release:major`): `scripts/release.mjs bump` puts every package on the
   new version, refreshes the lockfile and the coding-agent install lock, and opens a PR from `release-vX.Y.Z`.
2. After that PR is merged and CI on `main` passed, `npm run release:tag` tags `main` `vX.Y.Z` and pushes only that tag.
   The tag starts `.github/workflows/release.yml`: a source tarball, six Bun-compiled `xpi` binaries
   (`xpi-<platform>.tar.gz` / `.zip`), `SHA256SUMS`, a smoke test on three operating systems, then the GitHub Release
   with generated notes.

npm is not published by either step or by CI. The owner publishes by hand (2FA), from the repository root:
`npm run xpi:pack && npm publish ./dist-pack/xpi-coding-agent-<version>.tgz --access public`. So npm can be behind the latest GitHub Release. Publishing the package folder directly is refused by its
`prepublishOnly` (`scripts/refuse-folder-publish.mjs`): that folder is not the package npm users get.

The other workflows are `ci.yml` (build, check, tests) and `npm-audit.yml` (scheduled audit).

## Core changes: codemode background controller

A codemode script can be moved to the background: the `codemode` call returns early, the script keeps running
detached from the turn's abort signal. The codemode built-in owns the mechanism; the `subagent` extension owns the
policy (when to move, the end message). The `codemode` tool is no longer wrapped or replaced.

- `src/extensions/codemode/scripts.ts` (new): `codemodeScripts` controller (`owner`, `list`, `background`,
  `backgroundAll`, `stop`, `stopAll`, `subscribe`, `provideBackground`, `canBackground`) and the `beginCodemodeScript` hook used by the executor. Exported
  from `src/index.ts`.
- `src/extensions/codemode/execute.ts`: `executeCodemode` is now a thin wrapper over the old body (`runCodemode`,
  unchanged). It registers the script, links the turn's signal only while foreground, races the script against "moved",
  and on a move returns `details.background` / `details.scriptId`; the real end is reported through `onEnd`. With a
  context-less call, or when nothing calls `background()`, the result is the old one.
- `src/extensions/codemode/tool.ts`: `CodemodeToolDetails` gains `background?` and `scriptId?`.
- `src/core/nested-tool-calls.ts`: `NestedToolCallRunner.detach(callerId)` / `release(callerId)`. A detached scope
  survives `takeRecord()` and `clear()` (`agent_end`), so nested ids keep counting (no repeated `<id>/1`) and later calls
  and their usage keep going into the same recorder until `release()`.
- `src/core/agent-session.ts`: backs the two new context actions; the runner is created by `_getNestedToolCalls()`.
- `src/core/extensions/types.ts`, `src/core/extensions/runner.ts`: `ExtensionToolContext.detachNestedCalls()` and
  `releaseNestedCalls()` (optional), and the matching `ExtensionContextActions`.
- `src/extensions/subagent/background.ts`: the `installBackground` wrapper and its `registerTool` proxy are gone. The
  script registry (panel rows, `agentStarting`, the end message) follows `codemodeScripts` through `connect()`.
- `src/extensions/subagent/index.ts`: connects the registry at `session_start`. `subagent.backgroundScripts: false`, or
  no UI (print mode), means scripts are neither tracked nor moved.
- Tests: `test/nested-tool-calls.test.ts` (detached scopes), `test/suite/codemode-scripts.test.ts` (controller).

### `run_in_background` and the script screen

The `codemode` tool takes optional `run_in_background` and `description`. The executor moves the script right after it
starts (`codemodeScripts.background()`) when `codemodeScripts.canBackground(sessionId)` says some provider serves the
session. The subagent extension is that provider: `scripts.connect()` registers one (`provideBackground`) whose
`enabled()` is `subagent.backgroundScripts !== false` and a UI, so the flag is ignored (the call waits) with the
extension off, the setting off, or in print mode. `CodemodeScriptInfo` carries `description` and `code`.

- `src/extensions/codemode/tool.ts`: the schema fields and the guidance in the description (more than about 30 s, result
  not needed this turn; never dev servers or watch; return a filtered result). The description is static: it says the
  flag is ignored where unavailable, since the loadout is built before the subagent extension knows its settings.
- `src/extensions/subagent/background.ts`: `ScriptRecord` gains `description`, `code`, `calls` (tool calls in order with
  status, times and the last 200 output lines), `logs` and `result`. `scripts.nested()` fills `calls` from the
  `tool_execution_*` events that carry `parentToolCallId` equal to the script's call id (`index.ts` subscribes). Memory
  only, nothing goes to the session file. The end message names the description.
- `src/extensions/subagent/script-screen.ts`: the script screen, opened from the panel (Enter on a script row). Fixed
  keys like the panel's: `Esc`, `x`, scrolling.
- Tests: `test/suite/codemode-run-in-background.test.ts` (vitest, the flag with and without a provider),
  `test/subagent/panel/script-screen.test.ts` (rows, calls, end message, screen). By hand with Haiku:
  `test/subagent/parent/05-codemode-run-in-background.test.ts`, `test/subagent/tui/13-script-screen.test.ts`.

## Core changes: workflows

Saved workflows (`docs/subagent.md`, "Workflows") start a codemode script from a slash command, with no model turn, and
add helpers to every script that can call `Agent`.

- `src/core/extensions/types.ts`, `src/core/extensions/runner.ts`: `ExtensionCommandContext.createToolContext(toolCallId,
  signal?)`, the tool context a command uses for work that calls tools (`executeTool` with ids `<toolCallId>/<n>`).
- `src/core/agent-session.ts`: a nested call with no assistant message in the session (a command's script, the usual
  case for a fresh session) runs against an empty assistant message (`_emptyAssistantMessage()`), where it used to
  fail with "No assistant message issued this call".
- `src/extensions/codemode/addons.ts` (new), `src/extensions/codemode/execute.ts`: `codemodeAddons.register({ name,
  applies(toolNames), prelude, globals(script) })`. A script whose callable tools an add-on applies to gets its
  one-line prelude on its first line (line numbers do not move) and its host globals, which may call the script's tools
  through `script.callTool` (a nested call row like `tools.<name>()`).
- Tests: `test/subagent/faults/workflows.test.ts` (commands, print and rpc mode), `test/subagent/faults/script-helpers.test.ts`
  (add-on, helpers in a real sandbox), `test/suite/subagent-workflow-tool.test.ts` (the Workflow tool on a session).

## Core changes: prompt cache layout

The Anthropic prompt cache reuses a request prefix only up to a cache breakpoint an earlier request set. Subagent
children used to send one system block that began with the agent's own text, so two agent types, or a child in a
worktree, shared nothing after the tools. Now a child's system prompt is two regions: a head that is the same for every
agent type and checkout (a fixed preamble, then the project context), and a tail with everything of its own (agent body,
preloaded skills, memory, working directory, date). The main agent's prompt has no tail and keeps its order.

- `xpi-ai` `src/types.ts`, `src/utils/text.ts`, `src/utils/transcript.ts`, `src/api/anthropic-messages.ts`:
  `SystemMessage.cacheBreakpoints` names the parts (`"content"` or a section) after which a region ends;
  `getSystemMessageRegions()` splits the rendered prompt there. The Anthropic adapter sends one system block per region
  and spends its four breakpoints in this order: last message, last tool, last hinted region, earlier hinted regions,
  OAuth identity block. Other providers ignore the hint. Only the leading system message carries it.
- `src/core/system-prompt.ts`: `BuildSystemPromptOptions.tail` puts a last section `<instructions>` after the project
  context and moves `cwd` behind the head; `buildSystemPromptCacheBreakpoints()` names the last head section and the
  last section. A skill that lives inside the project is listed with an absolute path, so with a tail the `skills`
  section follows `cwd` whenever such a skill exists. `projectRoot` and `displayContextPath()`: a context file inside
  the project is shown relative to cwd (`AGENTS.md`, `../AGENTS.md`), one under home as `~/...`, never as an absolute
  project path. This also changes the main agent's `<project_instructions path>` lines.
- `src/core/resource-loader.ts`: `DefaultResourceLoaderOptions.systemPromptTail` (text or a file path) and
  `ResourceLoader.getSystemPromptTail()`.
- `src/cli/args.ts`, `src/main.ts`: `--system-prompt-tail <text or file>`.
- `src/core/agent-session.ts`: passes `tail` and `projectRoot` (the checkout holding cwd, from `findGitPaths`) to the
  builder and puts `cacheBreakpoints` on the leading system message. A later change of the tail is an ordinary section
  patch.
- `src/extensions/subagent/resolve.ts`, `runner.ts`: `ChildSpec.systemPrompt` is `{ head, tail }`; the runner passes
  the head as `--system-prompt` and the tail as `--system-prompt-tail`.
- `src/extensions/subagent/stagger.ts`, `exchange.ts`, `config.ts`: `subagent.staggerStart` (default false). After
  the concurrency slot, the first child with a `ChildSpec.prefixKey` (model, tool args, head preamble, git root of the
  parent's cwd) leads; later ones wait until a child with that key sees `message_start` of an assistant message that
  is not a failed request's error (the provider has begun to answer, so the prefix is cached), at most 5 s. For 4
  minutes after such a response nobody waits. No core file is touched for this.
- Tests: `test/system-prompt.test.ts`, `test/system-prompt-updates.test.ts`, `test/resource-loader.test.ts`,
  `test/args.test.ts`, `test/subagent/worktree/cache-layout.test.ts`, `test/subagent/faults/stagger.test.ts`; by hand
  on a real model: `npm run test:subagent:cache`.

## Core changes: stale-edit guard

`read`, `edit` and `write` share a per-session `FileStateStore` (`coding-agent/src/core/tools/file-state.ts`, created by
`AgentSession` and passed through `ToolsOptions.fileState`). `read` records a fingerprint of each text file (SHA-256 of
the content with trailing spaces, tabs and CR removed per line; a paged read fingerprints the whole file as it streams;
an image read records nothing). `edit` and `write` over an existing file verify it inside the per-path mutation queue
and throw `File <path> has not been read in this session. Read it before editing.` or `File <path> changed since you
last read it. Read it again before editing.` (`write` ends `before overwriting it`); recording continues while the
setting is off; a successful edit or write records the new content. Nothing is persisted,
so resume, fork and subagent children start empty. Setting `staleEditGuard` (default true) turns it off. Tools made
alone (`createEditTool(cwd)`) have no store and are unguarded; the multi-tool factories create one. This follows Claude
Code's rule; upstream pi has no such check. User docs: `settings.md#edit-and-write-safety`.
Tests: `test/stale-edit-guard.test.ts`, `test/suite/stale-edit-guard-session.test.ts`.

## Core changes: tool effects

Every tool has a static `effect` (`read` | `write` | `exec`; type `ToolEffect`, declared in `xpi-agent-core` on
`AgentTool` and on the extension `ToolDefinition`, carried by `wrapToolDefinition`). `resolveToolEffect`
(`coding-agent/src/core/tools/tool-definition-wrapper.ts`) is the one resolver: declared effect, else `exec`. The
`tool_call` event (`AgentSession._beforeToolCall`) and `getAllTools()` use it. The MCP adapter
(`src/extensions/mcp/tools.ts`) maps `readOnlyHint === true` to `read`, otherwise `write`. Upstream pi has no effects.
The subagent extension's read-only agents (Plan, Explore, memory) still list tool names. User docs:
`extensions.md#tool-effects`. Test: `test/suite/tool-effects.test.ts`.

## Core changes: stream interrupt

A `message_update` handler may return `{ interrupt: { inject } }` (`MessageUpdateEventResult`). Problem: `agent.abort()`
aborts the run's one signal, so an extension could not stop one request and try again. Changes:

- `xpi-agent-core`: `streamAssistantResponse` (`agent-loop.ts`) gives every request its own `AbortController`, linked to
  the run's signal, and passes it to `AgentLoopConfig.onRequestStart(abortRequest)` (`Agent.onRequestStart`). If the
  provider still completes a request that was aborted alone, the loop sets `stopReason: "aborted"` on the result.
  Tool calls run only after the assistant message ends, and an `aborted` or `error` result ends the loop before
  `executeToolCalls`, so no tool call of the abandoned attempt can start.
- `ExtensionRunner.emitMessageUpdate` returns the first interrupt. `AgentSession._emitExtensionEvent` stores it
  (`_pendingStreamInterrupt`, first of an attempt wins, ignored past `MAX_STREAM_INTERRUPTS_PER_PROMPT` = 3, count reset
  per user prompt) and calls the request abort. `_agentRunAbortRequested` is never set.
- `_handlePostAgentRun` handles it before the error-retry branch (`_retryAfterStreamInterrupt`): `_omitRecoveryAttempt`
  hides the attempt, `_appendCustomMessage` adds the hidden `stream_interrupt` message, `_failedResponse` is set like in
  error retry, the extension event and session event `stream_interrupted` fire, and the run continues. `_retryAttempt`
  is untouched; `_willRetryAfterAgentEnd` reports `willRetry: true`.

User docs: `extensions.md#interrupting-a-stream`, `json.md`. Test: `test/suite/stream-interrupt.test.ts`.

## Core changes: ctx.complete

`ctx.complete(options)` on `ExtensionContext` makes a side model call. Problem: every extension that wanted a second
opinion (a judge, a classifier) repeated model lookup, auth, retries and JSON parsing, and its cost never reached the
footer. Changes:

- `coding-agent/src/core/side-call.ts`: `runSideCall` holds the rules, `CompleteError` (`kind` = `ErrorKind` plus
  `aborted`, `no_model`, `no_auth`, `schema`) and the option and result types. It is a function over a `SideCallHost`,
  so it has no session dependency.
- `AgentSession.complete` wires the host. Model: `"inherit"` = `session.model`, else the shared `models` setting
  (`SettingsManager.getModelAliases`, schema entry `models`), else `resolveCliModel` (the `--model` resolver). Auth:
  `_getSummarizationRequestAuth`, the path compaction uses. Request: `cacheRetention: "none"`, a fresh `uuidv7`
  session id, the session's stream function. Retry: `retryAssistantCall` with `settingsManager.getRetrySettings()`
  (only `transient` and `rate_limit` retry, `retryAfterMs` honoured). Schema: the schema goes into the system prompt,
  the answer is parsed (fence tolerated) and checked with `validateToolArguments`, 2 retries that append the bad
  answer and the error; no tool choice, no prefill (both 400 on current Claude models).
- Usage: each billed attempt (inside the `retryAssistantCall` producer, so failed and retried ones too) goes to
  `sessionManager.appendUsage("ext:<purpose>", ...)`. `UsageEntry` already existed (cache warming); footer,
  `getSessionStats` and `getUsageCostBreakdown` already add every `usage` entry, so no totals code changed. They show
  under the entry's provider/model, not under the purpose.
- Cancellation: the call's signal is `AbortSignal.any` of the caller's signal, the run's `agent.signal` and a
  controller per call that `AgentSession.abort()` and `dispose()` trigger (`abortSideCalls`).
- The extension runner takes `complete` in `ExtensionContextActions`; interactive mode's hand-built shortcut context
  passes it too.
- Subagent: `readConfig(subagent, models)` merges `{ built-in aliases, models, subagent.models }`, so `subagent.models`
  wins, then the shared `models`.

User docs: `extensions.md#ctxcompleteoptions`, `settings.md`, `subagent.md`. Tests: `test/suite/ctx-complete.test.ts`,
`test/subagent/faults/model-aliases.test.ts`.

## Core changes: path schemes

`pi.registerScheme(name, handler)` lets an extension own `name://...` paths in the file tools. Problem: a package that
exposes a resource (a pull request, a skill) needed its own tool; `read pr://1` was the relative path `<cwd>/pr:/1` and
failed. Changes:

- Types: `SchemeHandler`, `SchemeContent` (`core/extensions/types.ts`). `core/schemes.ts`: `SchemeRegistry`
  (`ExtensionRuntime.schemes`, filled on commit like `mcpServers`), `validateScheme` (trust boundary: name regex,
  reserved `http`/`https`/`file`/`data`, exactly one of `resolve`/`locate`, `write` not with `locate`), the one-line
  `describe`. `loader.ts` `registerScheme` throws for a taken name, naming both extension paths; a failed load commits
  nothing.
- `core/tools/scheme-resolver.ts`: `SchemeResolver` (registry + context factory). `resolve(path)` returns undefined for
  an unregistered scheme (the path is untouched), `{ kind: "file", path }` after `locate`, or `{ kind: "virtual" }`.
  It is injected like the file-state store: `ToolsOptions.schemes` is wired into read, write, edit, grep, find and ls by
  `withFileState`, and `AgentSession._buildRuntime` creates one over `runtime.schemes`.
- Per tool: `read`, `write`, `edit` resolve first; a file target replaces the path (stale guard, mutation queue and the
  rest unchanged). `read` on a virtual target runs `selectLinesFromBuffer` on the resolved text and the shared
  `formatTextRead` (extracted from the file branch; no bash hint when `shellPath` is undefined). `edit` shares
  `applyEdits` (BOM, line endings, diff) between files and virtual text. `write`/`edit` run under
  `withUrlMutationQueue(url)` (same queue map, key `url:<url>`), call `SchemeResolver.assertWritable` first
  (`<scheme>:// is read-only`), then `handler.write`. `grep`, `find`, `ls` call `SchemeResolver.searchPath`: located path
  or `<url> is a virtual resource; use read`.
- Stale guard: `FileStateStore.recordUrl`/`verifyUrl` key virtual resources by `url:<url>`; the fingerprint is of the
  full resolved text. `write` over a virtual resource whose `resolve` throws counts as a new resource.
- System prompt: `BuildSystemPromptOptions.schemes` renders a `schemes` section (one line `name:// — describe` each,
  registration order, plus a bash note), also with a custom prompt. `_rebuildSystemPrompt` reads the registry.

Out of scope: built-in schemes, images from virtual schemes, schemes inside bash. User docs:
`extensions.md#path-schemes`. Tests: `test/path-schemes.test.ts`, `test/suite/path-schemes-session.test.ts`.

## Core changes: codemode is a default tool

Upstream pi starts with `read`, `bash`, `edit` and `write`; `codemode` is off unless settings, `--tools` or an MCP server
turns it on. xin-pi adds `codemode` to `DEFAULT_TOOL_NAMES` (`src/core/settings-manager.ts`), which the CLI, the SDK
and a session without a tool selection all start from. The codemode extension still registers the tool with
`defaultActive: false`, so a session whose selection leaves it out (`--tools read,bash`, `"defaultTools": ["-codemode"]`,
a resumed branch that removed it) does not get it back on registration. When merging upstream, keep `codemode` in that
list and keep `src/core/agent-session.ts` reading it instead of its own copy.

## Core changes: extension flag validation

An error thrown by a `session_start` handler is only reported, so an extension could not stop a run whose flag value is
unusable. xin-pi adds `validate(value, cwd)` to string flags (`registerFlag`, `ExtensionFlag` in
`src/core/extensions/types.ts`, kept by `loader.ts`). `applyExtensionFlagValues` (`src/core/agent-session-services.ts`)
calls it for a command-line value with the session cwd; a returned message or a throw becomes an `error` diagnostic,
which stops the start in every mode, as an unknown option does. The services are created again for `/new`, a resume or
a fork, whose diagnostics are not shown: there the value is set anyway, so the extension's `session_start` reports the
problem. `--agents` (subagent) and `--mcp-config` (MCP) use it.
User docs: `extensions.md#piregisterflagname-options`. Tests: `test/extension-flag-validate.test.ts`,
`test/subagent/faults/cli-agents.test.ts`.

## Core changes: --strict-extensions

Upstream pi starts without an `-e` package (`npm:`, `git:`) that fails to install and only warns; a missing `-e` path
or an extension that throws while loading is already an error that stops the start. xin-pi adds `--strict-extensions`
(`src/cli/args.ts`, passed by `main.ts` as `DefaultResourceLoaderOptions.strictExtensions`). With it the resource
loader (`src/core/resource-loader.ts`, `reload()` and the pre-trust pass) reports install failures of
`additionalExtensionPaths` as extension errors instead of warnings, and any such source that yields no extension
resource (skipped offline, not an extension, or a string the package manager does not read as a source), so the start
stops. The subagent extension passes
it to a child whose agent has `extensions`. User docs: `cli.md#resource-options`, `subagent.md#extensions-as-hooks`.
Tests: `test/strict-extensions.test.ts`.

## Testing

Everything below runs from `packages/xpi-coding-agent/`. Tests assert on structure and side effects (result fields,
files, the child's session file), never on model wording, and never start a test runner from inside a test.

| script | what | needs |
|---|---|---|
| `npm test` | `test:subagent`, `test:upstream`, then the vitest suite. Root `npm test` and `./test.sh` run it | the vitest part skips what needs keys |
| `npm run test:subagent` | offline `node:test`: `faults` (scripted fake child), `panel`, `worktree`, `memory` | nothing: no auth, no network, git identity set inside the tests |
| `npm run test:upstream` | offline `node:test` for `/upstream`: temp git repos with a fake `upstream` remote, a stubbed fetch, a fake pi API, a temp agent dir | nothing |
| `npm run test:subagent:real` | `real/*`: the extension in-process, children are the built xpi on real haiku | `npm run build`, auth |
| `npm run test:subagent:parent` | `parent/*`: a real `xpi --mode rpc` parent, background scripts, `/subagents stop` | `npm run build`, auth |
| `npm run test:subagent:tui` | `tui/*`: interactive xpi in a pty (node-pty + headless xterm): panel, screen, keys | `npm run build`, auth |
| `npm run test:subagent:evals -- --runs 3` | `evals/`: 22 cases on haiku, graded on structure | `npm run build`, auth |
| `npm run test:subagent:stress -- --calls 20 --limit 20` | `stress/`: 20 concurrent children | `npm run build`, auth, about 4 GB of memory |
| `npm run test:subagent:cache` | `cache/`: what the provider's prompt cache reuses between agent types, a worktree child and a memory edit, siblings at once with `staggerStart` off and on, plus a payload dump | `npm run build`, auth |
| `npm run test:upstream:real` | `/upstream` on the built xpi in rpc mode, Claude Haiku 5.5 | `npm run build`, auth |

The real-model scripts are run by hand, never in CI. They use the built bundle (`dist/bundle/cli.js`);
`XPI_SUBAGENT_TEST_PI` points them at another build. Every sandbox sets `XPI_CODING_AGENT_DIR` to a temp dir holding a copy
of `~/.pi/agent/auth.json` and nothing else, so the user's agent dir is never written, and a temp `HOME`. The copy is
refused when its Anthropic OAuth token expires within 30 minutes (`test/subagent/user-auth.ts`): a copy that refreshes the
token would leave the user's file with a dead refresh token. Send one message in xpi, then run again. Only Claude Haiku
5.5 is used. `XPI_SUBAGENT_COST_LOG=<file>` makes each file append its cost on exit.

`packages/xpi-roost` is tested on its own: its tests start real daemons, hosts and PTYs (shell commands and fake
workers, no model), so the package has no `test` script and root `npm test`, `./test.sh` and CI's `test (other)` skip it.
Run `npm run test:roost` in `packages/xpi-roost` (about a minute); CI runs it in the `test (roost)` job on Linux after
`npm rebuild node-pty`. The suite sweeps what a killed run leaves, before and after (test processes are marked by
`ROOST_PARENT_PID` and a home under `<tmp>/xroost-*`); check for leftovers after a run anyway. `npm run release:local`
also runs a roost smoke on the packed install (`smokeTestRoost` in `scripts/coding-agent-smoke.mjs`, skipped on
Windows, `npm rebuild node-pty` first on Linux): `xpi roost ls` starts the daemon, `daemon status` reports node-pty, a
shell-command session runs in a PTY host and its screen is read with `logs`, then the daemon is stopped.

The codemode controller is exercised through `codemodeStandIn` in `test/subagent/helpers.ts` (a stand-in `codemode` tool
whose scripts are JS functions, driving `beginCodemodeScript` the way `executeCodemode` does) in the fault suite, and
through the real tool in `parent/` and `tui/`. Root-level checks: `npm run check` (lint, format, types, entry graphs,
install lock) and `node scripts/xpi-rename.mjs --check`.

## `/upstream`: what upstream pi has that xin-pi does not

`/upstream` is a built-in extension (`packages/xpi-coding-agent/src/extensions/upstream/`, name `upstream`, disabled with
`-builtin:upstream`). xin-pi no longer merges upstream; the command tells you what to port. It gathers the facts itself,
writes them to a data file, and injects a short prompt into the main agent (no dedicated subagent), which writes the report.

- **Setting:** `upstream.sourceDir` in settings.json, default `~/Developer/xin-pi`.
- **Git mode:** the source dir is a git checkout with an `upstream` remote. It runs `git fetch upstream` (with `GIT_TERMINAL_PROMPT=0`; a failed fetch is a
  note, not an error), takes the upstream branch to be the remote's default branch (`refs/remotes/upstream/HEAD`, else
  `git ls-remote --symref upstream HEAD`, else `main`; a missing branch falls back to CHANGELOG mode with a notice), takes the
  fork point `git merge-base main upstream/<default branch>`, and lists the upstream commits since then
  (subject, date, author, files capped at 8 per commit), our diff stat against the fork point per package in `xpi-*`
  names, the files changed on both sides (conflict candidates), commits that look related to subagents, background or
  codemode, and the new upstream `packages/coding-agent/CHANGELOG.md` lines. Upstream `packages/<x>` is mapped to
  `packages/xpi-<x>` (`agent` is `xpi-agent-core`); `chord`, `durable`, `env` and `apps/*` are flagged "removed in xin-pi".
- **Fallback mode:** no checkout, or no `upstream` remote. It reads upstream's CHANGELOG from GitHub raw and keeps the
  sections newer than this build's coding-agent version (plus Unreleased). The request times out after 15 s with a clear error. The data file and the prompt say it is partial.
  A notice names the mode that ran.
- **Files:** `~/.pi/agent/upstream/<YYYY-MM-DD-HHMMSS>-data.md` (facts) and `<YYYY-MM-DD-HHMMSS>.md` (the report, written by
  the agent). The prompt names both paths.
- **Report:** four `##` sections: Upstream changes (features / fixes / breaking), Conflicts with our changes, Overlap with
  xin-pi built-ins (take upstream's or keep ours), Recommendations (PORT / ADAPT / SKIP with reason and risk), ending with
  a suggested next step such as "port commits X and Y on a branch". Porting is a separate request: cherry-pick, then
  `node scripts/xpi-rename.mjs <paths>`, or rewrite.
- **Delivery:** `pi.sendUserMessage(prompt, { deliverAs: "steer" })`: an idle main starts a turn, a busy one is steered.
  The prompt says read-only: no edits other than the report, no merge.

Tests: see Testing above.
