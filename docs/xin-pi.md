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
