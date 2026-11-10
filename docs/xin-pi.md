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
  `xpi-coding-agent`, `xpi-codemode`, `xpi-mcp`, `xpi-schema`, `xpi-telemetry`, `xpi-evals`. All share one version. Only
  `xpi-coding-agent` (the CLI, a self-contained bundle) is published to npm; see [Releasing](#releasing).
- App-config environment variables carry the prefix `XPI_` instead of `PI_` (`XPI_OFFLINE`, `XPI_TELEMETRY`,
  `XPI_PACKAGE_DIR`, `XPI_SKIP_VERSION_CHECK`, ...). The list of renamed names is `ENV_VARS` in `scripts/xpi-rename.mjs`.
  CI secrets, build constants and release tooling variables keep their names.
- Removed from the monorepo: `packages/chord`, `packages/durable`, `packages/env`, `apps/p2`, `apps/p3` (coding-agent, ai,
  agent-core and tui did not depend on them), together with their build, workspace, tsconfig and CI wiring. The
  version check is skipped by default (`XPI_SKIP_VERSION_CHECK ??= "1"` in `coding-agent/src/cli/setup.ts`).
- Two built-in extensions, registered in `coding-agent/src/extensions/index.ts` and not replaceable:
  - `subagent` (`src/extensions/subagent/`, off with `-builtin:subagent`): the `Agent`, `SendMessage` and `Workflow` tools
    for codemode scripts, the script helpers (`agent`, `parallel`, `pipeline`, `phase`, `log`), saved workflows
    (`/<name>`, `/workflows`), the `fork` agent type and `/subtask`, the panel, `/subagents`, the `--agents` flag. Settings namespace `subagent.*`, env `XPI_SUBAGENT_*`, branches `subagent/<id>`. It was the separate
    extension pi-pipipi. User docs: [subagent.md](../packages/xpi-coding-agent/docs/subagent.md); porting contracts:
    [subagent-porting.md](../packages/xpi-coding-agent/docs/subagent-porting.md).
  - `upstream` (`src/extensions/upstream/`, off with `-builtin:upstream`): `/upstream`, see below.
- `coding-agent/package.json`: `copy-assets` also copies `src/extensions/subagent/builtin/*.md` to
  `dist/extensions/subagent/builtin`.
- Running it: `npm install && npm run build`, then `node packages/xpi-coding-agent/dist/bundle/cli.js`, or from sources
  `./pi-test.sh`. Subagent children run the same build as their parent (`src/extensions/subagent/invocation.ts`).
- Installing without npm publishing: `npm run xpi:pack` cleans, builds and writes `dist-pack/xpi-coding-agent-<version>.tgz`
  (gitignored); install it with `npm i -g ./dist-pack/xpi-coding-agent-<version>.tgz`. The tarball is self-contained: the
  bundle inlines `xpi-ai`, `xpi-tui`, `xpi-agent-core`, `xpi-codemode` and `xpi-mcp`, so they are `devDependencies` of
  `xpi-coding-agent` and only third-party packages (29 in all) are installed. `npm run check` fails if the built bundle imports
  an `xpi-*` package at runtime. Importing `xpi-coding-agent` as a library (SDK) from such an install is not supported: its
  unbundled `dist/index.js` needs the workspace packages. Development alternative: `npm link` in `packages/xpi-coding-agent`
  after `npm run build`. Verified with a private prefix (`npm i -g --prefix <tmp> <tarball>`, then `<tmp>/bin/xpi --version`,
  `--help`, `--list-models` from another directory with `XPI_CODING_AGENT_DIR` set to a temp dir).
- `npm run build` removes `packages/xpi-coding-agent/dist` first, so files of deleted sources are never packed.
- Self-update is disabled: `xpi update --self` (and plain `xpi update`) prints "xpi is installed from source; rebuild and
  reinstall" and exits 1; `xpi update --extensions|--models|--all` work as before. The latest-version check never runs, so
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
   package (see Testing). Add a changelog line if the package keeps one.

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

npm is not published by either step or by CI. The owner publishes by hand (2FA):
`cd packages/xpi-coding-agent && npm publish --access public`. So npm can be behind the latest GitHub Release.

The other workflows are `ci.yml` (build, check, tests) and `npm-audit.yml` (scheduled audit).

## Core changes: codemode background controller

A codemode script can be moved to the background: the `codemode` call returns early, the script keeps running
detached from the turn's abort signal. The codemode built-in owns the mechanism; the `subagent` extension owns the
policy (when to move, the end message). The `codemode` tool is no longer wrapped or replaced.

- `src/extensions/codemode/scripts.ts` (new): `codemodeScripts` controller (`owner`, `list`, `background`,
  `backgroundAll`, `stop`, `stopAll`, `subscribe`) and the `beginCodemodeScript` hook used by the executor. Exported
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
