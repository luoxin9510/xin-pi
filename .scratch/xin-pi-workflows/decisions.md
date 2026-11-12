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

## Grill 5 (2026-11-11): inline MCP servers, permissionMode, per-agent extensions (`08-mcp-permission-extensions.md`). Accepted by the owner on 2026-11-11

The owner chose to build the three remaining Claude Code agent-file fields worth having, to leave agent teams for when
pi-roost comes into xin-pi, and to leave models that never delegate on their own as they are (the owner changes the
system prompt when needed). Each line is worded so "yes" accepts the proposal.

1. A public `--mcp-config <file or JSON>` adds servers on top of `mcp.json`; a child gets its inline servers through it.
   `stdio` and `http`; `sse` and `ws` are skipped with a warning.
2. Inline servers follow Claude Code's trust rule (project agent files only in a trusted project; user-level and
   `--agents` always) and their tools are handled like a named server's.
3. Hooks (Claude Code's format): rejected by the owner, who asked for xpi's own hook mechanism instead (extensions).
   Questions 3 to 6 of the round (events, tool-name mapping, handler types, hook trust) were dropped with it.
4. `permissionMode: plan` keeps only read-only tools and says so in the prompt; every other value is accepted with one
   warning that xpi never asks for permission and runs as bypassPermissions.
5. A new xpi field `extensions` lists extensions loaded only into that subagent's child (`-e`), paths relative to the
   agent file; same trust rule as inline servers.
6. Claude Code's `hooks` stays accepted with no effect; its warning points to `extensions`.
7. Order: inline MCP and `--mcp-config`, then `permissionMode`, then `extensions`; one PR each with an Opus review and a
   real Haiku check; then the full real-model regression, and the subagent work is wrapped up.

## Grill 6 (2026-11-12): waiting for agents in codemode. Accepted, then superseded by Grill 7 the same day

The owner saw scripts set unreasonable `timeout_ms` values, because a model cannot know how long a subagent takes, and
asked how to bring Claude Code's "subagents report back" into codemode.

The owner first accepted six recommendations:

- pause the deadline while a script waits for agents;
- release agents at a deadline instead of stopping them;
- stall notices to main;
- description lines;
- an eval;
- build before agent teams.

After the draft spec, the owner reconsidered ("限时的还是不好"). Instead, a script should only start agents and end,
and main should idle until results return, without paying for an LLM turn on each return. Grill 7 replaces Grill 6.

## Grill 7 (2026-11-12): start agents and let the script end (`09-smart-waiting.md`). All 6 accepted by the owner on 2026-11-12 ("好的我觉得可以")

1. **Start and end.** An `Agent` call still running when its script ends is released, not cancelled: it keeps running
   and reports to main. The descriptions recommend this pattern. A script awaits agents only when it must combine
   their results.
2. **One wake per group.** The agents one script leaves running form a group. Main wakes once, when all of them have
   ended, with one combined message. `wake: "each"` on an `Agent` call gives a wake per agent, for races.
3. **Waiting costs no LLM turns.**
   - Progress is shown in the panel.
   - A user message to main during the wait carries a one-line status of the running agents.
   - A stall (default 10 minutes without activity) is shown in the panel and to the user. It does not wake main and
     is reported in the group message.
4. **Deadlines.** A deadline releases running agents into the group, as any script end does. Pausing the clock is
   dropped.
5. **Eval.** Multi-agent long cases. Count main's wakes, `timeout_ms` use, agents stopped by a deadline, time and cost,
   before and after, with Haiku and Opus.
6. **Scope.** Codemode only. Grouping teammates' notices is asked before agent teams' PR 1, because it would change
   that spec's decision 7.
