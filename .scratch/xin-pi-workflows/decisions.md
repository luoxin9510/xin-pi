# Decisions

## Grill 1 (2026-11-10): all 11 accepted by the owner on 2026-11-10

The owner asked for the two unverified facts of `02-workflows.md` to be checked first; both were (see its Verified
facts). One consequence, within decision 5 (Claude Code's names and semantics): a saved workflow starts with
`export const meta = { name, description }`, Claude Code's format, not a description comment.

Structured output (`01-structured-output.md`)

1. Mechanism: a `StructuredOutput` tool in the child whose parameters are the schema (pi validates, the model retries
   inside its own run), not parsing the last message in the parent.
2. Result: `structured` holds the value and `output` its JSON text; a schema failure returns `status: "failed"` instead of
   throwing; 5 invalid attempts, and one automatic reminder turn when the agent ends without the call.
3. The schema is per call only (no `schema` field in agent files).

Workflows (`02-workflows.md`)

4. A workflow is a saved codemode script: `.pi/workflows/<name>.js` and `~/.pi/agent/workflows/<name>.js`, run as
   `/name args`, started directly as a background script with no model turn.
5. Helpers `agent`, `parallel`, `pipeline`, `phase`, `log`, `args` with Claude Code's names and semantics, available in
   every codemode script, not only in saved workflows.
6. Saving: `s` on a script row in the panel; the model runs saved workflows through a `Workflow` tool.
7. A hard cap of 1000 agents per script run.
8. Left for later specs: pause/resume, restart one agent, relaunch with saved results, `/deep-research`, reading
   `.claude/workflows/`, the size warning.

Names and messages (`03-names-and-messages.md`)

9. `name` is unique per session and also accepted by `resume`.
10. `SendMessage` to a running agent is a steer that returns at once; to a finished one it continues the agent like
    `resume`. No agent-to-agent messages.

Order

11. Specs for fork and for the inert agent-file fields are written after 1-3 have landed.

## Grill 2 (2026-11-10): fork and the inert fields. All 9 accepted by the owner on 2026-11-10

Each line is worded so "yes" accepts the proposal.

Fork (`04-fork.md`)

1. A fork is `Agent({ subagent_type: "fork", ... })`, a reserved type with no agent file, plus `/subtask <task>` for
   the user. It has main's model, thinking level, system prompt and tools; `model`, `effort` and `schema` are refused.
2. A fork starts from a copy of main's session file taken at the call, with a tool result injected for the unfinished
   `codemode` call that says "you are a fork, do the next message's task". No fork with `--no-session`.
3. A fork may not start any subagent (not only "no fork of a fork"): nesting stays one level, as today. The tools stay
   declared for the cache, and the calls throw.
4. Default: omitted `run_in_background` follows the same rules as any agent (not "always background" as in Claude
   Code); `/subtask` is always background.
5. On by default; `subagent.fork: false` turns it off.
6. Before any ticket: the two prototypes in the spec (the provider accepts the copied session; the first request reads
   main's cache). If the cache cannot be read without large core changes, stop and come back with the numbers.

Inert fields (`05-inert-fields.md`)

7. Build `mcpServers` (names of configured servers only, no inline definitions), `background: true`, and `--agents`.
8. Leave `permissionMode`, `hooks`, `initialPrompt`, `autoCompactWindow` and `experimental` inert, with a warning that
   says why.

Order

9. Spec 05 first (three small, independent tickets), then spec 04 (the prototypes decide its size).

## Grill 3 (2026-11-10): workflows, second part (`06-workflows-2.md`). All 5 accepted by the owner on 2026-11-10

Each line is worded so "yes" accepts the proposal.

1. Scope: this spec does two things, reading Claude Code's workflow files and restarting a running agent. Relaunch
   with saved results, pause and resume, `/deep-research` and the size warning stay for later specs.
2. Workflow sources, highest first: `.pi/workflows/`, `.claude/workflows/` (both project, trusted only, closest wins),
   `~/.pi/agent/workflows/`, `~/.claude/workflows/`. Saving from the panel never writes into `.claude/`.
3. `agent()` changes to Claude Code's behaviour: it resolves to `null` when the agent failed or was stopped, and
   rejects only when a `schema` was never met. This changes what shipped in 1.6.0 (today it rejects); scripts that
   `try`/`catch` around `agent()` for failures must check for `null` instead. `tools.Agent` does not change.
4. `parallel()` gets the 4,096 item cap. `Date.now()`, `Math.random()` and `new Date()` keep working.
5. Restart: `r` on a running agent's panel row and `/restart` on its screen. The agent starts over with the same
   prompt and settings and keeps its id, name and row; the earlier session is kept as a file next to it; the waiting
   `Agent` call gets the last start's result; turns and cost add up; a finished agent cannot be restarted.

## Grill 4 (2026-11-10): relaunch with saved results, pause and resume (`07-relaunch-and-pause.md`). All 8 accepted by the owner on 2026-11-10

The owner asked for both features and ruled `/deep-research` out. Each line is worded so "yes" accepts the proposal.

1. Saved results are kept for runs of saved workflows only, in a run file under the session's `subagents/` directory.
   An ad hoc script is not recorded; save it first (`s`).
2. Relaunch is started by the user from `/workflows` (Enter on a stopped or failed run) and by the model with
   `Workflow({ name, relaunch: "R2" })`. It uses the workflow file as it is now and the same args.
3. Matching follows Claude Code: calls are compared in order; a call is answered from saved results only while every
   earlier call was, and it asked the same thing and completed. From the first call that differs, failed or was still
   running, everything runs again.
4. An answered call returns the old agent (same id and session, no cost), so it can still be continued.
5. `Date.now()`, `Math.random()` and `new Date()` keep working: a script that depends on them reruns from the first
   prompt that differs. (Claude Code makes them throw.)
6. A rerun call takes over a `name` that an agent of the relaunched run holds, so a relaunch never fails on a name.
7. Pause (`p` on the script row, and in `/workflows`): the script starts no new agent and its `Agent` calls wait;
   agents already running finish. `p` again resumes. Any script can be paused, saved or not.
8. Not now: pausing by itself on a usage limit; relaunching ad hoc scripts.
