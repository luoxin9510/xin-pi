# 02: Workflows (saved, rerunnable orchestration scripts)

Spec: `../02-workflows.md`. Five tickets, one commit each, on branch `subagent-workflows`.

**Status:** done (2026-11-10), branch `subagent-workflows`

- [x] T1 Tracer: `ExtensionCommandContext.createToolContext`; a nested call with no assistant message runs against an
      empty one (`agent-session.ts`); `.pi/workflows/<name>.js` and `<agent dir>/workflows/` in Claude Code's format
      (`meta` parsed as a plain literal, never run; body keeps line numbers); `/name args` starts the script with no model
      turn (background with a UI, foreground in print mode); the end message names the workflow
- [x] T2 Helpers: codemode add-ons (`codemode/addons.ts`: one-line prelude + host globals); `agent`, `parallel`,
      `pipeline`, `phase`, `log`, `args` (`subagent/script-helpers.ts`); `subagent.maxAgentsPerScript` (1000)
- [x] T3 `Workflow({ name, args })` tool (codemode exposure, offered when a workflow can run, description lists them),
      `/workflows` list; names another command has are skipped
- [x] T4 Panel: workflow name and last log line on the script row, agents grouped under phase titles, `s` saves a
      script as a workflow (name, description, project or user, overwrite confirm); the new workflow is a command at once
- [x] T5 Docs (`docs/subagent.md` Workflows, `docs/xin-pi.md` core changes, `docs/subagent-porting.md`), eval "parent
      runs a saved workflow" (3/3), real haiku `test/subagent/real/18-workflows.test.ts` (3 Explore agents with a
      schema through `/list-ts`)

## Comments

2026-11-10: **Phase reaches the Agent call through `AsyncLocalStorage`.** `agent()` passes its phase to the host global
`__subagentAgent`, which runs the Agent call inside `agentPhase.run(phase, ...)`; the Agent tool reads it when it adds
the agent to the script's row. It survives the session's tool pipeline (checked in the offline helper test). Phases are
sequential: two concurrent `phase(title, fn)` calls share one current title (documented).

**A Workflow-started script hangs off the Workflow call.** It runs under the Workflow tool call's own context, so its
nested calls have ids `<main script>/<n>/<m>`; the codemode controller picks the newest script whose id prefixes a call,
which is the workflow's. Verified on a faux-model session (`test/suite/subagent-workflow-tool.test.ts`) and on haiku.

**Save takes the source from the session.** The codemode call that started a script is on the branch; its `code`
(without the `@options` line) is the workflow body. No change to the codemode controller was needed.

**Test-side mistakes, not product bugs:** the first eval runs used a stale `dist/bundle` (the evals run the built CLI;
`npm run build` first), and the eval's "answer" check matched main's promise to reply with the `WF-RESULT` line.

**A slip during T1:** an rpc-mode experiment inherited `DEEPSEEK_API_KEY` from the shell, and the end message's turn ran
two small requests on DeepSeek. Tests that start a real xpi now drop every `*_API_KEY` / `*_AUTH_TOKEN` variable.
