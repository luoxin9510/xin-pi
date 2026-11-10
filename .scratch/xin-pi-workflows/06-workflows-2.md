# 06: Workflows, second part (Claude Code's workflow files, restarting an agent)

Status: done (2026-11-10, `issues/06-workflows-2.md`).

## Problem

Spec 02 left five things for later. Two are small and close to what exists, and are proposed here:

1. A workflow written for Claude Code lives in `.claude/workflows/`; xpi reads only `.pi/workflows/`. Agent files from
   `.claude/agents/` already work unchanged; workflows should too.
2. An agent of a run that is stuck (looping, waiting on something that will not come) can only be stopped, which
   counts as a failure for the script. Claude Code can restart it: it starts over and the script keeps waiting.

The other three (pause and resume, relaunch with saved results, a bundled `/deep-research`) stay for later specs; see
"Not in this spec" for why.

## Claude Code's behaviour (docs read verbatim on 2026-11-10, `code.claude.com/docs/en/workflows.md`)

Files:

- "`.claude/workflows/` in your project" and "`~/.claude/workflows/` in your home directory". "Project workflows also
  load from every `.claude/workflows/` along that path, and when more than one defines the same name Claude Code runs
  the one closest to the working directory." "If a project workflow and a personal workflow share a name, the project
  one runs."
- `meta`: "keep `export const meta` as the first statement, and keep it a plain object literal with a `name` and a
  `description`." `phases` entries are the `phase()` titles.

Script API (what the page states; `parallel`'s signature and other `opts` keys are still not documented):

- `agent()` resolves to `null` "if you stop it mid-run or it hits an unrecoverable API error". A schema that fails
  validation after five attempts fails the call.
- "`pipeline()` keeps each `null` in the results array."
- "Claude Code makes `Date.now()`, `Math.random()`, and a no-argument `new Date()` throw inside the script, so that a
  relaunched run repeats the same `agent()` calls."
- Limits: 1,000 agents per run; up to 4,096 items per `parallel()` / `pipeline()` call.

Managing a run (keys in `/workflows`):

- "`r` | Restart the selected running agent". "`x` | Stop the selected agent, or stop the whole workflow when focus is
  on the run". "Stopping one agent alone ... counts as failing." "Stopping the whole run doesn't count any agent as
  failed."
- "`p` | Pause or resume the run".
- Relaunch: a completed agent "returns its saved result. The first agent whose prompt differs from the previous run ...
  runs again, and so does every agent after it"; a failed one "runs again, and so does every agent the script starts
  after it".

## Where xpi differs today

| | Claude Code | xpi 1.6.0 |
|---|---|---|
| `agent()` when the agent failed or was stopped | resolves to `null` | rejects (awaited directly, the script ends with the error) |
| `agent()` when the schema is never met | the call fails | rejects (the same) |
| `parallel()` item cap | 4,096 | none (`pipeline()` has it) |
| `Date.now()`, `Math.random()`, `new Date()` | throw | work (xpi has no relaunch, so nothing needs to repeat) |

The first row matters for compatibility: a Claude Code script that writes `const r = await agent(...); if (!r) ...`
ends with an error in xpi instead of taking its own branch.

## Solution (proposed)

### Read Claude Code's workflow files

- Sources, highest priority first: `.pi/workflows/` then `.claude/workflows/` (each from cwd up to the repo root,
  closest wins, trusted projects only), then `~/.pi/agent/workflows/`, then `~/.claude/workflows/`. The same order as
  agent files. A name in a higher source hides the same name lower down.
- `/workflows` shows which directory a workflow came from. Saving from the panel (`s`) still writes to `.pi/workflows/`
  or `~/.pi/agent/workflows/`: xpi does not write into `.claude/`.
- `agent()` follows Claude Code: it resolves to `null` when the agent failed or was stopped, and rejects only when a
  `schema` was never met (and for a wrong call: no prompt, a bad option). `tools.Agent` is unchanged and still returns
  the full result with `status` and `error`.
- `parallel()` gets the 4,096 item cap.
- `Date.now()`, `Math.random()` and `new Date()` keep working. A script that relies on them throwing does not exist.

### Restart a running agent

- `r` on a running agent's row in the panel, and `/restart` on its screen: the child is stopped, its session so far is
  kept as `<id>.restart-<n>.jsonl.bak` next to it, and the agent starts over with the same prompt, type, model, schema and
  worktree. It keeps its id, name, row and place in its phase. Turns and cost add up across restarts.
- The `Agent` call that started it keeps waiting and gets the result of the last start. Nothing is reported to main
  for the restart itself.
- Only a running agent can be restarted. A finished one is continued with `resume` or `SendMessage`, as today.
- A restart does not count toward `subagent.maxAgentsPerScript`.

## Not in this spec

- **Relaunch with saved results.** It needs a result store per run, prompt comparison in call order, and deterministic
  scripts (which is why Claude Code makes `Date.now()` throw). It is the largest of the five and changes what a script
  may do; it gets its own spec, after the owner has used workflows for a while.
- **Pause and resume.** xpi's children are separate processes with no way to hold a request mid-flight; a pause could
  only stop starting new agents. Worth doing together with relaunch, which gives a paused run a way to continue.
- **`/deep-research`.** It "requires the WebSearch tool"; xpi has no built-in web search. A bundled workflow needs that
  decided first.
- **The size warning.** Advisory only; `subagent.maxAgentsPerScript` already bounds a run.

## Testing

- Offline (fake children): the four sources and their order; a `.claude/workflows/` file runs by `/name` and by
  `Workflow`; untrusted project; `agent()` returns `null` for a failed and for a stopped agent and rejects for a
  schema never met; `parallel()` cap; restart (the child is stopped and started again with the same prompt, the call
  resolves with the second run's result, the first session is kept, turns and cost add up, a finished agent is
  refused); the pty test for `r`.
- Real, by hand (haiku): Claude Code's documented example script, saved under `.claude/workflows/`, runs unchanged; a
  restart of a real running agent.
- Docs in the same PR: `docs/subagent.md` (Workflows, the panel and screen keys), `docs/subagent-porting.md`.

## Tickets (after approval)

1. `.claude/workflows/` and `~/.claude/workflows/`; `/workflows` shows the directory.
2. `agent()` resolves to `null` for a failed or stopped agent; `parallel()` cap.
3. Restart a running agent (`r`, `/restart`).
