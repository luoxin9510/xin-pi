# xpi: what differs from upstream pi

Short, file by file. Paths are under `packages/xpi-coding-agent/` unless noted.

## Codemode: background scripts

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

## Testing the subagent extension

The suites ported from pi-pipipi are `node:test` files in `packages/xpi-coding-agent/test/subagent/` (Node >= 22.18
strips the types). Run them from the package root. Tests assert on structure and side effects (result fields, files, the
child's session file), never on model wording, and never start a test runner from inside a test.

| script | seam | needs |
|---|---|---|
| `npm run test:subagent` | `faults` (scripted fake child), `panel`, `worktree`, `memory` | nothing: no auth, no network, git identity set inside the tests. Part of the package `test` script, so root `npm test` and `./test.sh` run it |
| `npm run test:subagent:real` | `real/*`: the extension in-process, children are the built xpi on real haiku | `npm run build`, auth |
| `npm run test:subagent:parent` | `parent/*`: a real `xpi --mode rpc` parent, background scripts, `/subagents stop` | `npm run build`, auth |
| `npm run test:subagent:tui` | `tui/*`: interactive xpi in a pty (node-pty + headless xterm): panel, screen, `x`, `shift+x`, ctrl+b | `npm run build`, auth |
| `npm run test:subagent:evals -- --runs 3` | `evals/`: 17 cases on haiku, graded on structure | `npm run build`, auth |
| `npm run test:subagent:stress -- --calls 20 --limit 20` | `stress/`: 20 concurrent children | `npm run build`, auth, about 4 GB of memory |

The real seams use the built bundle (`dist/bundle/cli.js`); `XPI_SUBAGENT_TEST_PI` points them at another build. Every
sandbox sets `XPI_CODING_AGENT_DIR` to a temp dir holding a copy of `~/.pi/agent/auth.json` and nothing else, so the
user's agent dir is never written, and a temp `HOME`. Only Claude Haiku 5.5 is used. `XPI_SUBAGENT_COST_LOG=<file>`
makes each file append its cost on exit.

The codemode controller is exercised through `codemodeStandIn` in `test/subagent/helpers.ts` (a stand-in `codemode`
tool whose scripts are JS functions, driving `beginCodemodeScript` the way `executeCodemode` does) in the fault suite,
and through the real tool in `parent/` and `tui/`.
