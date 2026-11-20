# Decisions: xpi-graph

## Before the grills (2026-11-17, in conversation with the owner)

- Nodes are in-session nodes: the same session with another role, model and limits, as relay does.
- xpi is codemode only; the tool that moves between nodes exists only in codemode.
- Edges are hard, the inside of a node is free.
- Ideas are borrowed from LangGraph and from upstream's durable and chord packages; no code is ported and chord is
  not brought in.
- The first version is small and has to work; features come later.
- Strong control in the first version is three things: sensitive actions are command nodes run by the engine (a deny
  list on model nodes as a backstop); rules of the form "A only after B passed" are checked when the graph loads;
  anything unclear stops the graph. The aim is that steps cannot be skipped, not that a determined model cannot get
  around a limit.

## Grill 1 (2026-11-17). Accepted by the owner on 2026-11-17 ("全是")

1. Graph files are JS (`export default { ... }`) in `.pi/graphs/` (trusted projects only) and
   `~/.pi/agent/graphs/`, project first: the rules of saved workflows.
2. The engine is not relay's `graph.ts`. `xpi-graph` has its own small interpreter of nodes and edges; relay is not
   touched.
3. Independent review: no subagent node in the first version. The review node's prompt tells the model to start a
   fresh-context Opus subagent with the `Agent` tool; the node sums up and picks the edge.
4. Approval is a `select` with three options: approve, send back, stop the graph. After "send back" the user's next
   message is the comment and the model stays in the node. Without a UI it counts as sent back and the graph stops.
5. A turn that ends without a move: a node that has an approval exit is waiting for the user, which is normal; any
   other node gets one reminder, then the graph stops and asks the user.
6. Command nodes: fixed command text, a timeout of 10 minutes by default (`timeout` on the node changes it), a
   timeout is a failure, the last 200 lines of output go into the session. No graph variables.
7. The deny list matches by substring on the command text. The shell is not parsed; the docs say it can be got
   around.
8. An edge on a loop without `max` gets 3. Counts are per edge, read from the node entries. At the limit the graph
   stops and asks the user.
9. One graph per session. While it runs the nodes decide the model and relay takes no part; a node whose `model` is
   `relay/auto` is a load error; a node without `model` uses the model selected at the start. At the end or on
   `/graph stop` the earlier model and tools are restored.
10. Cache: not measured before the spec. Rule: between two nodes on the same model the role prompt goes in a
    message, not in the system prompt. Measured with Haiku after the first runnable milestone.
11. Names: the package `packages/xpi-graph`, the built-in `builtin:graph` in `src/extensions/graph/`, loaded by
    default. Without `/graph start` it registers no tool and changes no request.
12. The risk that only one flow is ever used is accepted. The dev graph is not shipped with xpi: it lives in this
    repository as `.pi/graphs/dev.js`, the example and the test graph. A second graph (the release flow) is part of
    "done", to test that the engine is general.

## Grill 2 (2026-11-17). Accepted by the owner on 2026-11-17 ("全是")

13. The tool is `next({ to, report })`: `to` a node name, `report` required and stored in the node entry. On
    entering a node the engine sends a message with the node, its role prompt and where it can go. A `to` that is
    not an edge of the current node is an error that lists the choices.
14. No combined exit ("the model picks, then a command verifies"). A check is a command node between the two.
15. A node has two limits: `deny` (command text) and `readOnly` (paths the node cannot write, matched as
    `builtin:protect` matches). No tool allow-list.
16. `requires: [{ before, passed, notAfter? }]`: on every path to `before`, after the last entry into a node of
    `notAfter` there is a pass of `passed`. Without `notAfter` the check is only that every path passes it.
17. A graph is plain data. `/graph start` writes the whole graph into the session's start entry; running, resuming
    and branching read that copy, never the file again.
18. The engine protects only the graph directories and the session file by itself. Files a check depends on
    (`package.json`, CI configuration) are the graph author's to list in a node's `readOnly`. A model that edits a
    test to make it pass is found by the review, not by the engine.
19. Four milestones, one PR each: the package; the smallest runnable `builtin:graph`; strong control; the two
    graphs and the docs.
20. Delivery: spec and tickets in `.scratch/xpi-graph/`, one PR for the owner to approve. After the approval each
    milestone is a branch, a PR, green CI and an independent fresh-context Opus review, then merged by the agent
    without asking at each step. Real-model tests on Haiku only. No release, no npm.

## Facts found while writing the spec (author)

- A workflow's `meta` is read by a literal parser that never runs the file (`LiteralParser`,
  `extensions/subagent/workflows.ts`). The graph file is read the same way, so decision 17 ("plain data") needs no
  check of its own, and listing or starting a graph runs no project code. The first statement is
  `export default <literal>`.
- Relay switches models with a virtual model whose router reads the session branch. The graph does the same with
  `graph/auto`; a resumed session then restores the selection without code. Consequence, not asked in the grills:
  selecting another model while a graph runs ends the graph.
- Decision 10 is met more simply than worded: the role prompt is always in the entry message and never in the
  system prompt, whatever the models of the two nodes.
- A graph needs a way to end. `end` is a reserved target of an edge; it is not a node.
- "Stops and asks the user" is one state, a halt: the graph stays on its node, the session stays usable, and the
  user answers, runs `/graph goto` or runs `/graph stop`. `/graph goto` resets the loop counts.
- `tool_call` fires for calls a codemode script makes and carries the tool's effect, so `deny` and `readOnly` need
  no change in codemode or in the core.
- Subagents are child processes. The node's limits reach them through an environment variable
  (`XPI_GRAPH_LIMITS`); ticket 03 checks that the child inherits it.
- Workflows are also read from `.claude/workflows/` and from a built-in directory. Graphs are not: neither exists
  for graphs.

## Review round 1 (independent Opus, commit 383314267, 2026-11-17)

One blocking finding, six should-fix, six nits; all taken. None changes a decision of the grills. What the spec
now says, and was not asked in the grills:

- A halt on a command node has no node model and no node limits. The router then uses the model selected before
  the graph, the limits are the union of every node's `deny`, and `next` is refused: only `/graph goto` and
  `/graph stop` leave it. A halt on a model node is left by the user's next message.
- One move per visit: `next` writes `graph.move`; a second `next`, or one from a background script, is refused;
  the move is entered at the next request boundary.
- `graph.enter` is sent again after a compaction.
- `graph/auto` is registered at load (a resumed session needs it). Only a `set` or `cycle` selection ends a
  running graph, not a `restore`.
- `/graph start` and `/graph goto` enter the node at once and start the turn.
- `readOnly` does not see shell writes. The entry message tells the model the patterns hold for the shell too,
  and the docs say the engine does not enforce it there.
- `notAfter` cannot contain `before`. The two `requires` checks were reviewed and no counter-example was found.

## Review round 2 (same reviewer, commit 3c5bd06a6, 2026-11-17)

The blocking finding of round 1 is closed (the reviewer agrees). Three should-fix and two nits on the increment;
all taken:

- A pending move is part of the state and is entered at the next boundary of any kind, so a quit, a crash, a
  branch change or an aborted turn cannot leave a node stuck. An aborted turn does not get a request of its own.
- `/graph start` refuses when the selected model is a virtual model (for the owner: with `relay/auto` selected,
  select a physical model first). This narrows decision 9, which only excluded `relay/auto` as a node's model;
  the reason is that a router must return a physical model and a halt on a command node uses the stored
  selection. The alternative, if the owner prefers it: allow the start and let such a halt use the model of the
  last model node visited.
- A command run started from `/graph start` or `/graph goto` has the extension's own abort controller;
  `/graph stop` aborts it.
- `graph/auto` selected by hand with no graph answers with the last model and a notice; nothing is selected
  back.
- Leaving a halt on a model node starts the idle count of the visit again.

## Review round 3 (same reviewer, commit 693189a35, 2026-11-17)

The five findings of round 2 are closed. One should-fix and one nit on the increment; both taken:

- While a command node runs outside a turn, the session is under the rules of a halt on a command node (the
  pre-graph model, the union of every `deny`, `next` refused).
- The result of such a run is a pending move and is entered at a boundary, never in the middle of a turn.

## Approval (2026-11-17)

The owner approved the spec ("批准") with PR #136, and with it the refusal to start a graph while a virtual model
is selected (review round 2).

## Found while building milestone 2 (author, 2026-11-17)

- Every move is entered at the end of its turn, or before the next run when the turn never settled. The spec
  first let a model's move be entered at the next request of the same turn; one rule is simpler and a node then
  never changes inside a turn.
- The report of the node before goes into the `graph.enter` message. Without it the report is only an argument
  of a tool call in the transcript, which a compaction drops.
- The extension holds the running logic and the package only the three pure parts; there is no host interface
  as relay's.
- A loop limit halts already in milestone 2 (a graph of model nodes can loop). The reminder, the command nodes,
  the approvals and the limits stay in milestone 3.
- `next` from a background script is refused when no turn runs. A background script that calls it while a
  later turn of the same node runs is accepted: it is a call in a turn of the node.

## Found while building milestone 3 (author, 2026-11-18)

- One function goes on from where the branch is (`proceed` in `index.ts`): it enters a pending move, runs
  command nodes one after the other, and stops at a model node, the end or a halt. A turn's end, the start of
  a run, `/graph start` and `/graph goto` all call it; only where the entries go differs (drafts of the
  boundary, or the session). It folds the entries it writes itself, because drafts are not on the branch yet.
- A turn that was cut off or failed is left alone at its end: its move stays pending and is entered before the
  next run. Milestone 2 entered it at the turn's end without a request; with command nodes that would run a
  command under a signal that is already aborted.
- `/graph start` and `/graph goto` wait for the commands they run. A result that arrives while a turn runs is
  left as a pending move for that turn's end.
- A command node is run by the runner of `checks` (`extensions/checks/runner.ts`: its own process group, a
  timeout, an abort), not by `pi.exec`. Tests pass a fake runner.
- The limits are their own file (`limits.ts`). On a command node the `deny` lists of all model nodes hold and
  no `readOnly` (there is no node whose paths these would be).
- Closing the approval question is Send back, not an approval.
- A stopped command (`aborted`) halts on its node. `/graph stop` and a change of model abort a command that
  runs outside a turn; Escape aborts one that runs at a turn's end.
- The two nits of milestone 2's review are fixed here: a direct call of `next` is refused with how to call
  it, and `docs/graph.md` says which model answers when `graph/auto` is selected by hand.

## Milestone 4 (author, 2026-11-18)

- The two graphs are written and load; the release flow needed no change to the engine.
- The nit of milestone 3's second review round is fixed: after a command, `proceed` checks that the branch
  still holds the graph it started with (the `graph.start` entry), and clears only its own abort handle. A
  test stops a graph whose command is slow to die and starts another one meanwhile.
- Real Haiku runs: five, all to the end, $0.0084 in all (ticket G4.4).
- Open after the first version, for the owner: the main-process path of the limits while a command runs is
  tested only through the environment variable; the `mayWait` branch has no test; Escape does not stop a
  command that runs between two turns (`/graph stop` does).

## Review of milestone 4 (independent Opus, PR #141, commit e1eb22489, 2026-11-18)

Nothing blocking, five should-fix, four nits, all about how the two graphs behave in a real run:

- `dev.js`: a build that started on main could reach main with a plain `git push`, which no `deny` substring
  catches without denying every push (and main has no branch protection). A command node, `branch`, now stands
  between the spec and the build and leaves main if the session is on it; `deny` also names the forms that say
  main, a forced push and a switch to main. The header no longer says the model nodes cannot push to main.
  For the owner: protect the main branch on GitHub.
- The headers and the docs said code is written only after the spec is approved. What the shape guarantees is
  the order in which the nodes are entered; `readOnly` only keeps the file tools off a list of paths. Both
  now say so.
- `release.js`: `main-ci` watched the latest run on main, which right after the merge is still the one before
  it. It now waits for the run of the merge commit.
- Both graphs: `gh pr checks --watch` right after a push can find no check yet. The `ci` nodes wait for the
  first check to appear.
- The PR's success table claimed the first criterion; it now says what was run (the shapes, with stand-ins).
- `release.js`: the review node's `readOnly: ["**"]` would also have matched the temp file a PR comment is
  written to; it is the same list as in `dev.js` now.

## Review of milestone 3 (independent Opus, PR #140, commit 4fc15b23d, 2026-11-18)

One blocking finding, five should-fix, three nits. What changed:

- Blocking: a command that ran at a turn's end had no abort signal (the run's signal is gone by then), so
  `/graph stop` ended the graph on the branch while the command went on, and the next command node ran after
  the stop. Every command now runs under the extension's own abort handle, and after a command the branch is
  read again: a graph that was ended meanwhile does nothing more.
- While a command runs at a turn's end, the limits are those of the command node (every node's `deny`), read
  from the running command, not from the branch, which still shows the node before.
- `next` must come from a message of the current visit: the latest assistant message has to come after the
  entry that entered the node.
- The protected paths are compared without case where the file system ignores it (macOS, Windows).
- `docs/graph.md` says what `deny` does not see (tools other than `bash` and `powershell`, an MCP tool for
  example) and that a path with a scheme is not checked.
- The approval re-check compares the visit, not only the node.
- Not changed: `reminded` is reset only by a halt that is left or by entering a node, as the spec says.

## Review of milestone 2 (independent Opus, PR #139, commit 6d089c132, 2026-11-17)

One blocking finding, two should-fix, three nits. What changed:

- Blocking: a background script started in one node could call `next` during a later node's turn and move the
  graph for it. `next` is now accepted only from a script of the latest assistant message on the branch. This
  replaces the note above that such a call in a later turn of the same node is accepted: it is refused too.
- The node message sent again after a compaction starts no turn, and is not sent while a move is pending.
- A broken symlink in a graph directory no longer makes `/graph` fail; a file over 1 MiB is refused.
- A message queued behind the turn that ends a graph is answered by the model selected before the graph.

## Review round 4 (same reviewer, commit 933f811d5, 2026-11-17)

Both findings of round 3 are closed; nothing blocking. One nit, taken: `graph.move` records where the move came
from (`via`), because a model's move may be entered at the next request of the same turn and a command result
may not.

# Spec 02: what a graph run shows

## Grill 1 (2026-11-18). Accepted by the owner on 2026-11-18 ("全是")

The owner asked for observability ("最好我们的xpi-graph要有可观测性").

- O1. One source: the report is computed from the session's entries; no store of its own, as the graph's state.
- O2. Accounting per visit: time, cost, input and output tokens, cache read and write, summed from the messages
  between two `graph.node` entries; a subagent's cost counted where the session records it.
- O3. `graph.command` gets structured details: exit code, duration, timed out, the number of output lines, pass or fail.
- O4. A running command is visible: elapsed time in the footer, the last lines of its output in a widget, removed
  when it ends.
- O5. `/graph` shows a timeline, one line per visit (node, model or command, time, cost, cache, how it was left),
  then the approvals, blocks and halts, and the totals; after the end it shows the last run.
- O6. For programs: `/graph --json`, and events on the extension bus for entering, moving, halting, blocking and
  ending. herdr and roost are not changed.
- O7. A Mermaid graph in the report, with the current node and the edges taken marked. No full-screen view.
- O8. Not in scope: a cost budget, stopping on overspend, OpenTelemetry. Recorded in the "later" table.
- O9. The end-to-end run of the `dev` graph (waiting for a fresh login) goes first; the spec is written meanwhile.
  Delivery as for spec 01: spec PR, then a branch, PR, green CI and an independent Opus review per milestone, merged
  without asking; real-model runs on Haiku 5.5 only; no release, no npm.

## Facts checked before the spec (2026-11-18, by reading the code)

- A foreground subagent started with `Agent` from a codemode script is counted in that script's tool result:
  `message.usage` of the `toolResult` entry holds the sum of the script's nested calls
  (`core/agent-session.ts`, `core/nested-tool-calls.ts`). It cannot be told apart from `models.*` calls of the same
  script. Calls of a background script made after its result was written are `usage` entries of kind
  `nested_tool_calls`.
- A background agent's cost is only in the text of its `subagent` message (`subagent/agent-tool.ts`
  `agentEndMessage`): not counted, and the report says so.
- Every session entry has an ISO `timestamp` (`core/session-manager.ts` `SessionEntryBase`).
- `runCheckCommand` returns the output only at the end; `onOutput` is new.
- Relay's `spendFact` (`xpi-relay/src/facts.ts`) returns text and covers assistant messages only; the package keeps
  its own small fold.
- Extension bus channels are named `name:event` (`docs/extensions.md`).

## Choices made while writing the spec, put to the owner with it

- `graph.asked` records the answer of every approval question, since "send back", "stop" and a dismissed question
  leave nothing else on the branch (section 4).
- The report covers the last run on the branch only.
- `/graph --json` comes back as the notice's text, which RPC clients already receive.

## Review of the spec (independent Opus, commit 4baa066fa, 2026-11-18)

Two blocking, five should-fix, four nits; all taken into the spec:

- Blocking: the entries of a move entered at a turn's end are drafts committed together after the commands they
  cause, so their timestamps are equal and a 45-minute command's time would go to the model node before it. Every
  graph entry now carries `at` in its data, and a command's details carry `startedAt` and `durationMs`.
- Blocking: "stop" on an approval writes `graph.end` from inside a script, before the script's tool result, which
  holds its subagent's cost. The last visit of an ended run now counts up to the next user message, and
  `graph.asked` is written before what the answer causes.
- Every usage kind is counted (`own`, `tools`, `other`), so the report's total equals the session's usage; usage
  recorded under `graph/auto` goes to the visit's model.
- `graph:move` added (O6 names moving), and a pending move shows in the report.
- Events come from the committed branch, so dropped drafts emit nothing.
- `/graph --json` has no `graph: ` prefix; the test parses what an RPC client receives.
- The tickets name `docs/porting.md` and `docs/xin-pi.md`; nits on `Sink.message`, the answering model, the error
  state and waits taken.

## Review of the spec, round 2 (same reviewer, commit 50fc9f082, 2026-11-18)

Six of seven findings and all nits of round 1 closed. New: one blocking, one should-fix, four nits; all taken:

- Blocking: the replay mark lived in memory only, so a resumed session would replay the whole history and `/tree`
  could replay or lose events. The mark is set without emitting at `session_start` and `session_tree`, and again
  when it is not on the branch.
- After `graph.end` only `own` and `tools` count, up to the end of the agent run that wrote it, so the cache
  refreshes of an idle session do not grow a finished run's total.
- Nits: `cache_warm` records the real model (the claim was wrong); `recordUsage` writes only `ext:<purpose>`;
  `waitMs` is approval waits only; a queued `graph.command` is matched to its visit by node and start time.

## Review of the spec, round 3 (same reviewer, commit 658a97f6f, 2026-11-18)

All round 2 findings closed; nothing blocking or should-fix. Two nits, taken: the total is checked against the
same entries the report uses; `graph.end` records `duringRun`, and after an end written while idle nothing counts.

## Review of milestone 1 (independent Opus, PR #143, commit c4fedd934, 2026-11-18)

No blocking; three should-fix, six nits. What changed:

- `graph.end` written by `proceed` (a pending move to `end`, entered at a turn's end or before the next run) had
  `duringRun: true` from `!ctx.isIdle()`, so a later turn started by a custom message would have been counted.
  `proceed` now always writes `duringRun: false`; and after an end, counting also stops at any custom message
  that is not the graph's.
- A queued `graph.command` that lands after `graph.end` is matched to its visit (it was skipped); a command
  message whose node has no visit that started before it is not put on a visit of another node.
- `byModel`: the spec now says what the code does (nested calls under "nested calls"); usage under a virtual
  model is put with the model that answered the visit even when it lands before that model's first answer.
- `/graph` ends with the usage line again; the comment on `graph.asked` says what happens when the graph was
  stopped while the question was open.
- Not changed: the report's error-prefix search stays quadratic (it runs only on a branch that cannot be read);
  the suite's total test compares tokens and requests only, since faux usage has no cost (costs are covered by the
  package tests).

## Review of milestone 2 (independent Opus, PR #144, commit 7368a5035, 2026-11-18)

No blocking; two should-fix, three nits; all taken:

- The live view's timers drew through a context that throws once the session is replaced (`/new`, `/resume` while a
  command runs), in a timer callback nobody catches. The callbacks are guarded and end the view on an error; a
  `session_shutdown` handler stops a running command and marks the extension closed, so nothing is written after.
- `graph:command` took its visit from its position; a command run at `before_agent_start` has its message queued
  behind the next node's entry. It is matched by node and start time, as the report does; tested.
- The footer could be left on a stopped command's time when the command was slow to die: the clock does not draw
  after the abort, and the `gone` path of `/graph goto` and `/graph start` syncs the footer.
- The runner flushes its decoders at the end (a character cut at the end of the output comes as U+FFFD).
- `graph:move` has `to`; the docs say what `graph:start`'s `node` and `visit` are.

Round 2 (same reviewer, commit 06603fc78): all five closed; two nits, taken: a test for `session_shutdown` while a
command runs (the command is aborted, nothing is written after it), and only `graph:command` has its `node` and
`visit` replaced by the matched visit (`graph:blocked` keeps the node whose limits held).

## By-hand run (O2.4, real Haiku 5.5, 2026-11-18)

The repository's own `dev` graph, run end to end on xin-pi in a sandbox (`XPI_CODING_AGENT_DIR`, a copy of the
login), from a clone at main 09fedf693 with that clone's build. The graph was a copy, `dev-e2e`: its model nodes on
Haiku 5.5, its review subagent told to use Haiku, and review → merge made an `approve` edge. The task: the two nits
#141 left (`branch` passed on a detached HEAD or another branch; `ci` waited five minutes when there was no PR).

What happened: grill (7 questions) → spec → branch → build opened PR #145 → ci passed → review → build (a
should-fix from an outside Opus review: `gh pr view` also found a merged PR) → ci → review → build (the spec was
out of date) → ci → review → build (the PR body was out of date) → the `build -> ci` limit of 3 halted the graph
(right: the head had not changed, its CI was green) → `/graph goto review` (refused while the turn ran, taken after
it) → review → the merge was approved → merge ran `gh pr merge --merge --delete-branch`; PR #145 merged
(fc08b4a77). 15 visits, 57m55s, three approvals asked.

`/graph` showed every visit with its time, cost, cache and how it was left, the approvals, the halt and the Mermaid
graph. `/graph --json` parsed; its totals against the session file summed by hand:

| | report | session file |
|---|---|---|
| own (59 assistant messages, all Haiku) | $0.46548007 | $0.46548007 |
| tools (7 `nested_tool_calls` usage entries) | $0.7297355 | $0.7297355 |
| other | $0 | none |
| total | $1.19521557 | $1.19521557 |

Found, not fixed here (follow-ups):
- The review node ran its reviewer subagent on Opus (`anthropic/claude-opus-5-5`) though the node text said Haiku,
  saying AGENTS.md asks for Opus reviews; it once started a second reviewer because the first had not read AGENTS.md.
  Those reviews are the $0.73 of tools. The report cannot say so: the usage entries name the model `auto`, so
  `byModel` has them only as "nested calls", and `tools.requests` is 0 (the entries carry no request count).
- After the end the Mermaid graph still marks `merge` as current, and the `merge -> end` edge is not drawn thick.
- This run used main's code, so it checked milestone 1's report; the live footer, the command widget and the bus
  events of milestone 2 are checked by the faux tests only.

## Spec 03 grill (step 1 of the ideas from pi-durable, 2026-11-20)

Before it: a survey of pi-durable (local 9c9ce85, upstream README at edfe6b2ef), LangGraph 1.2, LangChain v1
middleware and Deep Agents. The owner asked whether durable's strengths can be taken over: yes, as ideas; no code
(durable's 34k lines import chord in 126 places and bring their own session, storage and scheduler). Three steps
proposed: command-node replay (this spec), a model turn cut off by a crash (core), waits that do not hold a
process (roost). The owner chose to start with step 1.

Round 1, all as recommended ("全是"):
- R1 Scope: `replay`, the intent entry, what happens after a crash; nested usage by model in the same spec as its
  own ticket and PR (it changes the core). A model turn cut off by a crash is step 2.
- R2 `replay: "safe" | "unsafe"` on command nodes, default `"unsafe"`: an author who forgets it does not get
  `gh pr merge` run twice; a crash is rare, so the cost is an occasional `/graph goto`.
- R3 Commands run outside the turn (the `/graph goto` path), so the intent can be written before the command runs.
  The other way, an intent written next to the drafts of `agent_before_settle`, would land out of order.
- R4 A new `graph.run` entry; `graph.command` unchanged.
- R5 Every command node of the repository's two graphs states `replay`, asserted by a test.
- R6 Suite tests with a simulated crash; by hand, `kill -9` during a command, without and with a Haiku node.
- R7 Delivery as before: a spec PR for the owner, then per milestone a branch, a PR, CI, an Opus review, merged.

Round 2, all as recommended ("全是"):
- R8 `session_start` only tells (the process may only be looking); a safe command runs again at the next message or
  `/graph goto`; an unsafe one halts on the command node, the halt written at the user's first action. One process
  per session is assumed.
- R9 A safe command interrupted 3 times in one visit is treated as unsafe.
- R10 `interrupted ×N` in `/graph`, `runs` in `--json`, a `graph:run` event; no event for "interrupted".
- R11 `usageByModel` on tool results, filled by the Agent tool; the recorder keeps it; a released scope writes one
  usage entry per model and the unattributed rest under `unknown/unattributed`; the cost breakdown and the graph
  report use it.

Facts found: entries of a command entered at the end of a turn are drafts committed after it ran
(`_runBeforeSettleBoundary`); reopening a session does not go on by itself; `_releaseNestedCalls` writes the
session's selected model; `Usage` has no model; the Agent tool's output has `model` as `provider/id`.
The summary of the eleven decisions was confirmed by the owner ("确认").

## Review of spec 03, round 1 (independent Opus, commit 6bfad2614)

Two blocking, seven should-fix, six nits; all taken in the spec:
- Blocking: without a UI (`xpi -p`), a command started after the turn would be killed when the process ends (print
  mode settles, then shuts down). Now `/graph start|goto` wait for idle and for no pending command run, in a loop,
  and `session_shutdown` without a UI waits for a running command (shutdown handlers are awaited); with a UI it
  aborts as now.
- Blocking: "a command node that has not run in this visit" would start `gh pr merge` in an old session halted on
  it (an abort writes a halt and no `graph.run`). Now a visit has a condition (halted, finished, interrupted, not
  started) and only a not-started or replayable visit, not halted, with no run in this process, starts.
- "Finished" by any later halt or node would hide the interruption once it was halted or left with goto: entries a
  run writes carry its `startedAt` (`run` on its move and halt, `interrupted` on the halt for an interruption), and
  only those finish it.
- A new session is not written to disk before its first user or assistant message: a core API to persist it now,
  called before the first `graph.run`.
- A rerun at `before_agent_start` would hold the user's message for the whole command: new owner choice R12 (start
  it, do not await it).
- The paths of a queued follow-up, an aborted settle and a crash between the commit and the start are stated.
- `usageByModel` through every path: the types in `xpi-agent-core` and `xpi-ai`, `agent-loop.ts`, the message-start
  merge, the recorder's unreported part, `tool_result` hooks that replace `usage` (they drop the attribution).
- The Agent tool's `model` may be a pattern, `graph/auto` or switched mid-run: the per-model usage now comes from the
  child's own assistant messages; virtual models are never attributed. Codemode `models.*` calls are attributed too.
- Nits: one key `Tools/unattributed`; the report maps `unknown/unattributed` to "nested calls"; the footer synced
  before the command starts; a normal quit reads as interrupted (documented); the example uses `run` without
  `kind`; `release.js` nodes classified one by one.

Round 2 (same reviewer, commit 661047fcd): all round-1 findings closed; no blocking; three should-fix and four nits,
all taken:
- A not-started visit found at `session_start` (an older xpi that died during `/graph goto`, which writes
  `graph.node` before running; or a crash between the commit and the start) may have run: it follows its `replay`
  like an interrupted run. Only a visit this process noted starts without a look at `replay`.
- The shutdown wait without a UI only for reason `quit`; the result is written after it, and no turn starts (a move
  to a model node stays pending). "RPC without a client" dropped: the rule is `ctx.hasUI`.
- `run` on `graph.move`/`graph.halt` renamed `runStartedAt`, so the key does not mean two things on the bus.
- Nits: a separate notice for "not started"; older sessions' tool-result usage moves to `Tools/unattributed`
  (documented); `/resume` keeps listing a session with graph entries and no message; R12's side effect after an
  Esc-cut turn is written in the spec.

Round 3 (same reviewer, commit f8336f60e): round-2 findings closed; one should-fix, taken: during a `quit` wait
without a UI, `proceed` would go on into the next command node (in `release.js`, `sync` then main's CI then `tag`)
inside the shutdown. Now the wait writes the one run's result and its move, then stops; the move stays pending.
Verdict: ready for the owner with that change.
