# Graph

A graph gives a flow hard rules. You write the flow as nodes and edges in a file; xpi runs it in one session. The model
works freely inside a node and can leave it only by an edge the file declares.

## Why

A rule in a prompt ("merge only after CI is green") lowers the chance of a mistake; it does not remove it. The model
can forget the rule and still run the command.

In a graph the rule is the shape of the flow. With no edge from `build` to `merge`, going from one to the other is not
a choice the model has: the tool it leaves a node with offers only the declared targets. The check and the merge are
commands that xpi runs itself, so the model cannot report a check as passed or run the merge early.

What a graph guarantees is that steps are not skipped. It is not a sandbox: see
[What a graph does not guarantee](#what-a-graph-does-not-guarantee).

## A graph file

`.pi/graphs/ship.js`:

```js
// Build on a cheap model, let CI decide, review on a strong one, merge after your approval.
export default {
  name: "ship",
  start: "build",
  nodes: {
    build:  { model: "anthropic/claude-haiku-5-5", prompt: "Build what the spec says and open a pull request.",
              deny: ["gh pr merge", "git push origin main"] },
    ci:     { run: "gh pr checks --watch", timeout: "30m", replay: "safe" },
    review: { model: "anthropic/claude-opus-5-5", prompt: "Review the diff. List what is wrong, or say it is fine.",
              deny: ["gh pr merge", "git push origin main"], readOnly: ["**"] },
    merge:  { run: "gh pr merge --merge --delete-branch" },
  },
  edges: [
    { from: "build",  to: "ci",     exit: "model" },
    { from: "ci",     to: "review", exit: "pass" },
    { from: "ci",     to: "build",  exit: "fail", max: 3 },
    { from: "review", to: "merge",  exit: "approve", label: "nothing to fix" },
    { from: "review", to: "build",  exit: "model",   label: "problems to fix", max: 2 },
    { from: "merge",  to: "end",    exit: "pass" },
  ],
  requires: [{ before: "merge", passed: "ci", notAfter: ["build"] }],
};
```

- **Where.** `.pi/graphs/<name>.js` in the project, from the current directory up to the repository root (the closest
  wins; read only in a trusted project), then `~/.pi/agent/graphs/<name>.js`. The file name is the graph's `name`.
- **Data, not code.** The first statement is `export default` followed by a plain literal: strings in any quotes, bare
  keys, trailing commas and comments are fine; a function call, a variable or a template with `${}` is refused, and
  so is anything after the literal. The file is parsed, never run, so listing or starting a graph runs no code from
  the project. A file larger than 1 MiB is refused.
- An unknown key is an error, so a typo such as `promt` does not pass silently.

### Nodes

| Kind | Fields | What it is |
|---|---|---|
| Model node | `prompt` (required), `model`, `thinking`, `deny`, `readOnly` | A stretch of work by a model. `prompt` is its role. `model` is a `provider/model` reference to a physical model; without one the node uses the model you had selected when the graph started. |
| Command node | `run` (required), `timeout`, `replay` | One shell command that xpi runs. Its exit code picks the edge. `timeout` is `"30s"`, `"10m"` or `"1h"`; the default is 10 minutes, and a timeout counts as a failure. `replay` says what happens when xpi died while the command ran: `"safe"` runs it again, `"unsafe"` (the default) halts the graph (see [After a crash](#after-a-crash)). |

`deny` and `readOnly` are the [limits of a node](#the-limits-of-a-node).

### Edges

An edge has `from`, `to` and `exit`. `to` is a node or `end`, which finishes the graph.

| `exit` | From | Taken when |
|---|---|---|
| `model` | a model node | the model chooses it |
| `approve` | a model node | the model chooses it and you approve |
| `pass` | a command node | the command exits with 0 |
| `fail` | a command node | the command exits with anything else, or times out |

`label` says what the edge means; the model sees it when it chooses. `max` is how many times the edge may be taken in
one run of the graph.

## What is checked when a graph starts

A graph that fails a check does not start. Every problem is reported at once, each with its place:

```
graph: .pi/graphs/ship.js: graph ship: 2 problems
  edges[1].to: no node "reveiw"
  requires[0]: "merge" can be reached without a pass of "ci": build -> merge
```

- Every name resolves, every node has an edge out and can be reached, and the graph can reach `end`.
- An exit fits its node, a model node has at most one edge to each node, a command node at most one `pass` and one
  `fail` edge. A command node may lack one of the two: that result halts the graph.
- An edge on a loop (its target leads back to its source) without a `max` gets `max: 3`.
- A node's `model` exists and is a physical model; a `thinking` level is one xpi knows.
- Each `requires` rule holds on every path.

**`requires`.** `{ before: "merge", passed: "ci", notAfter: ["build"] }` says: on every path to `merge`, after the last
entry into `build`, `ci` passed. Two things are checked on the graph without `ci`'s `pass` edge:

1. `merge` cannot be reached from the start. Otherwise some path reaches it without a pass of `ci`.
2. `merge` cannot be reached from `build`. Otherwise some path changes the code and merges it with no pass after the
   change.

Example for 2: add a node `patch` that only `review` reaches, for small fixes, with an edge `patch -> merge`. Every
path to `merge` still passes `ci`, so the first check is silent, but `ci -> review -> patch -> merge` merges code that
changed after the check. With `notAfter: ["patch"]` the graph is refused, and the message shows that path.

## Running a graph

| Command | What it does |
|---|---|
| `/graph` | The report of the session's last run, running or ended (see [What a run shows](#what-a-run-shows)), with the counts of the looping edges out of the current node and the graph as Mermaid. With no run on the branch: the graph files found. |
| `/graph --json` | The same report as JSON, and nothing else. |
| `/graph start <name>` | Check the graph and enter its first node, which starts working at once. Without a UI (`xpi -p "/graph start <name>"`) the command returns when the graph has ended or waits for you, and no command it started is still running. |
| `/graph goto <node>` | Your own jump to any node, whatever the edges say. Recorded as a jump; the loop counts start again. Going to a command node runs its command. Not while a turn or a command runs. From a command that may have run and may not run again, the halt is written first. |
| `/graph stop` | End the graph, stop a command it is running, and give back the model you had selected. |

What happens while it runs:

- **The model.** `/graph start` selects the virtual model `graph/auto`. It sends each request to the model of the
  current node. The footer shows the graph and the node, `graph ship: build`, and for a node entered by an edge with a
  `max`, how often that edge was taken: `graph ship: build (1/3)`. While a command runs it shows the time it has run,
  `graph ship: ci 3m12s`, refreshed each second, and a widget above the editor shows the command and the last 5
  lines of its output (colour codes removed, a `\r` progress line at its last state). The widget goes when the
  command ends, is stopped, or the graph is.
- **Entering a model node.** The model gets a message with the node's name, the report of the node it comes from, the
  node's prompt, the paths it must not write, and the nodes it may go to with their labels. The role is in this
  message, not in the system prompt; the system prompt has one fixed section about graphs, the same in every node, so
  two nodes on one model share the prompt cache.
- **Leaving a model node.** The model calls `tools.next({ to, report })` from a codemode script, once, and ends its
  turn. `to` must be one of the node's edges; otherwise the call fails and lists the choices. `report` is what the
  next node is told.
- **When a move takes effect.** At the end of the turn, never in the middle of one: until then the old node's model
  answers and its limits hold. A second `next` in the same visit is refused. So is one from a script that outlived the
  request that started it, such as a background script: by the time it calls, the session may be in another turn or
  another node, and a move belongs to the request that asked for it.
- **A command node** is run by xpi in the session's directory. The model is not asked and cannot report a result of
  its own. Every command runs outside a turn: a turn that moves to a command node enters it when the turn ends, and
  the command starts once the turn has settled, so the session is idle while it runs and a message you send then is
  answered at once (by the model you had selected before the graph; the next node is entered when that turn ends).
  Before it starts, xpi writes the session file (even one with no message yet) and a `graph.run` entry. The command,
  how it ended and the last 200 lines of its output go into the session, so the next node reads them. Then the
  `pass` or `fail` edge is taken; several command nodes in a row run one after the other. To stop a command that
  runs, use `/graph stop` (it ends the graph); Escape does not reach it. A turn cut off by Escape as it ends does
  not start the command; your next message does. Leaving the session (`/new`, `/resume`, quitting with a UI) stops
  a command that runs, and nothing more is written to the graph; the graph stays on the command node. Quitting
  without a UI (`xpi -p`) waits for the command and writes its result and move, then stops: no turn, no next node.
- **An approval.** When the model chooses an `approve` edge you are asked: **Approve**, **Send back** or **Stop the
  graph**. After "Send back" the model stays in the node and your next message is the comment. Closing the question
  is not an approval. Without a UI nobody can approve, and the graph halts.
- **A turn that ends without a move.** In a node with an `approve` edge that is the node talking to you, and nothing
  happens. In any other model node the model is reminded once; if the next turn also ends without a move, the graph
  halts.
- **The end.** An edge to `end` finishes the graph and gives back the model and thinking level you had selected.

A graph needs codemode (the model reaches `next` only from a script), and a physical model selected when it starts:
with `relay/auto` or another virtual model selected, `/graph start` asks you to select a physical model first. One
graph runs per session. Relay takes no part while a graph runs.

### When the graph stops and waits for you

A **halt** is the graph saying it cannot decide. The graph stays on its node and the session stays usable; the model
cannot move the graph while it is halted.

| Halted because | On | How to go on |
|---|---|---|
| an edge is at its `max` | the model node that asked | answer (the node goes on), `/graph goto`, `/graph stop` |
| two turns ended without a move | that model node | the same |
| an approval is needed and there is no UI | that model node | the same |
| a command's result has no edge, or its edge is at `max` | the command node | `/graph goto <node>` (the same node runs the command again), `/graph stop` |
| the state cannot be read | | `/graph stop` |

On a model node your next message leaves the halt. On a command node it does not: there is no node at work there. If
you talk to the session while it is halted on a command node, the model you had selected before the graph answers,
the `deny` lists of all nodes hold, and `next` is refused. While a command runs, the `deny` lists of all nodes hold
as well.

Example: `ci` fails a fourth time and `ci -> build` has `max: 3`. The graph halts on `ci`. You say "look at the log";
the model selected before the graph answers, and `gh pr merge` stays denied because `build` and `review` deny it.
Then you run `/graph goto build`.

### The limits of a node

A model node can carry two lists:

- `deny`: text that a shell command of the node may not contain. A `bash` or `powershell` call whose command contains
  one of the strings is blocked.
- `readOnly`: gitignore patterns of paths the node may not write. A file tool call that writes a matching path is
  blocked. The matching is that of [protected paths](protect.md).

While any graph runs, the graph directories and the session's own file are read-only as well.

A blocked call tells the model why, shows a warning, and is recorded in the session (`graph.blocked`). Calls a codemode
script makes are checked too. The limits are those of the node the session is in when the call is made.

A subagent started in a node gets the limits the node has at that moment (the environment variable
`XPI_GRAPH_LIMITS`), and keeps them: a subagent still running after the graph moved on has the old node's limits. A
subagent in its own worktree matches `readOnly` patterns against its own directory. A subagent gets none of the rest:
no `/graph`, no `next`.

Put the commands that must not be run early (the merge, the release, the push to the main branch) in a command node,
and in the `deny` list of the model nodes before it. The command node is the control; the `deny` list is the backstop.

### Resuming, branching, compaction

The state of a graph is not kept anywhere else than in the session: each entry into a node is an entry of the session
(see [The entries](#the-entries)).

- **Resume.** A resumed session is at the node its entries say, with the same counts. A move that was accepted before
  xpi quit, and whose turn never ended, is entered when you send the next message.
- **Branches.** Moving to another branch of the session tree moves the graph with it. To run a node again, branch from
  the entry that entered it. What a command node did (a merge) is not undone by branching.
- **An aborted turn** (Escape) after `next`: the move is not lost and gets no turn of its own; the next node starts
  with your next message.
- **Compaction** can summarise the node's role away, so after a compaction xpi sends the current node's message again.
  It starts no turn of its own.
- **After a crash.** See [After a crash](#after-a-crash).
- **The graph file is read once.** The whole graph is stored in the session when it starts. Editing the file changes
  the next start, not the graph that is running.
- **Selecting another model** while a graph runs ends the graph. Selecting `graph/auto` by hand with no graph running
  does nothing useful: xpi says to use `/graph start`, and the request is answered by the model that was selected
  before the session's last graph, or, in a session that ran no graph, by the model that answered last.

### After a crash

When xpi dies (a crash, `kill -9`, a closed terminal) while a command node's command runs, the session has its
`graph.run` and no result. When the session opens again, xpi only tells you what it found, and writes nothing: you
may only be looking. Your next action decides (any message, or `/graph goto`):

| The command node | Your next action |
|---|---|
| `replay: "safe"`, interrupted fewer than 3 times in this visit | runs it again (`/graph` shows `interrupted ×N`) |
| `replay: "safe"`, interrupted 3 times | halts the graph: `graph.halt` with `interrupted` |
| `replay: "unsafe"` (the default), interrupted | halts the graph: it may have run, and xpi does not know what it did |
| entered, with no `graph.run` (an older xpi died before it) | `safe`: runs it; `unsafe`: halts |

A halt on a command node is left as any other: check what the command did, then `/graph goto <node>` (the same node
runs it again), another node, or `/graph stop`. A message is answered by the model you had selected before the
graph, so you can ask it to look first.

Mark `safe` only what can run twice with the same effect: waiting for CI, reading, a `git pull --ff-only`. A merge, a
version bump, a tag or a publish are `unsafe`. Turn-level state is not part of this: a model turn cut off by a crash
is not resumed, only the move it accepted (see [Resuming, branching, compaction](#resuming-branching-compaction)).

## What a run shows

`/graph` shows the last run on the branch, while it runs and after it ended. It is computed from the session's
entries each time, so a resumed session or another branch of the tree shows its own run.

```
ship (/repo/.pi/graphs/ship.js) · ended (done) in merge
#  node    kind     model / command            time    cost             cache r/w  left by
1  build   model    anthropic/claude-haiku-5-5  6m40s   $0.03            120k/9k    model → ci
2  ci      command  gh pr checks --watch        4m55s   —                —          pass → review
3  review  model    anthropic/claude-opus-5-5   3m10s   $0.41 (tools $0.35)  52k/2k  approve → merge
4  merge   command  gh pr merge --merge          2.1s   —                —          ended (done)
asked: review → merge approve (3)
total 14m47s · $0.44 (tools $0.35) · anthropic/claude-haiku-5-5 $0.03 · anthropic/claude-opus-5-5 $0.06 · nested calls $0.35
not counted: the cost of background agents (the session records it only as text)
```

Then the graph as Mermaid (`flowchart LR`), the current node and the edges taken marked, to paste into a pull request.

- **A visit** is one entry into a node. Its time runs from its entry to the next node's entry (or the end, or now). A
  command visit shows the command's own time. The time includes waits; `--json` has the time spent on approval
  questions as `waitMs`.
- **Cost and tokens** are summed from the session's records in the visit, in three parts: `own` (the node's model),
  `tools` (what codemode scripts' nested calls spent: a subagent started with `Agent`, `models.*`; the session keeps
  only their sum per script, so one subagent cannot be told apart from another call of the same script), and
  `other` (cache refreshes, extension side calls, compaction and branch summaries). The cache column is the node's
  own cache reads and writes.
- **After the end** the rest of the run that ended the graph still counts: a script that answered "Stop the graph"
  writes its result, with its subagent's cost, after the end. Nothing an idle session spends later counts, and after
  an end written between turns (`/graph stop`) nothing does. Counting after the end also stops at the first message
  that is not the graph's (another extension's, a background agent's result), even one injected into the same run:
  that can count a little less, never twice.
- **Not counted:** the cost of background agents, which the session records only in the text of their message, and
  anything before `/graph start`.
- **Approvals.** Every answer is recorded (`graph.asked`), "Send back", "Stop the graph" and a closed question too,
  and listed under `asked`.
- **Blocks and halts** are listed with the visit they happened in.
- **Interrupted runs.** A command visit whose command a crash cut off shows `interrupted ×N` after how it was left.
  The command that runs now is not counted. A command ended by a signal xpi did not send (a closed terminal or
  SIGTERM taking xpi down, a kill by hand) counts as an interruption, not a failure: nothing is written for it, and
  the next action follows its `replay`. xpi cannot tell that signal from one the command brought on itself (killed
  for its memory, a crash of a lone program the shell handed over to), so such an end counts as interrupted too: a
  safe node runs again (up to 3 times), an unsafe one halts. A program that dies inside a longer shell command gives
  the shell an exit code above 128, which is a failure as before.

`/graph --json` gives the same as one JSON object (`schemaVersion: 1`): `status` (`running`, `ended`, `error`),
`graph`, `path`, `startedAt`, `endedAt`, `endReason`, `node`, `halted`, `visits` (each with `node`, `kind`, `via`,
`models`, `run`, `command` with the exit code, the time and the number of output lines, `startedAt`, `durationMs`,
`waitMs`, `own`, `tools`, `other`, `left`, `pending`, `ended`, and for a command visit `runs`: each `graph.run` with
`startedAt`, `finished`, and `running` for the command that runs now), `asked`, `blocked`, `halts`, `total`, `byModel`,
`edgesTaken` and `notCounted`. With a UI it is the text of an info notice (an RPC client gets it as the
`extension_ui_request` it already reads); without one it is one line on stdout. With no run it is
`{"schemaVersion":1,"status":"none"}`.

### Events for other extensions

Each graph record on the branch is also told on the extension bus (`pi.events`), once, in the branch's order:

| Channel | Record | Fields besides `graph`, `node`, `visit`, `at` |
|---|---|---|
| `graph:start` | `graph.start` | `path`, `selection` (`node` is `""` and `visit` is 0: no node is entered yet) |
| `graph:move` | `graph.move` | `to`, `edge`, `via`, `report`, `runStartedAt` (accepted, not entered yet) |
| `graph:enter` | `graph.node` | `via`, `edge`, `report` |
| `graph:run` | `graph.run` | `run`, `replay`, `startedAt` (the command is about to run) |
| `graph:command` | `graph.command` | `run`, `code`, `timedOut`, `startedAt`, `durationMs`, `lines`, `outcome` |
| `graph:asked` | `graph.asked` | `to`, `answer`, `askedAt` |
| `graph:blocked` | `graph.blocked` | `tool`, `rule` |
| `graph:halt` | `graph.halt` | `reason`, `runStartedAt`, `interrupted` |
| `graph:end` | `graph.end` | `reason`, `duringRun` |

An event is told only when its record is on the branch: after each write of the extension and when a run settles,
so the records written at a turn's end come at its end, and a record that is dropped (a graph stopped while its
command ran) is never told. A resumed session and a move in the session tree tell nothing of the records already
there; only new ones. `graph:command` carries the visit of its own command node, even when its message lands after
the next node's entry.

## What a graph does not guarantee

A graph stops a model from skipping a step by mistake or by taking a shortcut. It does not stop a model that sets out
to get around it.

- `deny` matches the text of a command. It does not parse the shell: a command written into a script file and run
  from there is not seen.
- `deny` looks at `bash` and `powershell` calls only. A tool that reaches the same result another way is not seen:
  an MCP tool that merges a pull request is not stopped by a `deny` of `gh pr merge`. If such a tool is
  connected, the command node is your only control for that step, and the model can get ahead of it.
- `readOnly` sees the file tools only. A shell command that writes a file (`cat > spec.md`) is not blocked. A model
  can do that out of habit, not only on purpose, so the message that enters a node names the node's read-only paths
  and says they hold for shell commands too. That is an instruction, not an enforcement. A path with a scheme
  (`name://...`, owned by an extension) is not checked either.
- A model can change a test so that it passes. The check then passes honestly. An independent review finds that, the
  graph does not.
- A review node in the same session sees the whole conversation. For an independent review, tell the node in its
  prompt to start a subagent with the `Agent` tool.
- `/graph goto` is yours and obeys no rule of the graph, `requires` included.
- An extension loaded after the built-ins can change a call after it was checked.

Real isolation (a token that exists only in the merge node, a sandbox) is not part of this.

## Two graphs to read

The xin-pi repository keeps two graphs for its own work, in
[`.pi/graphs/`](https://github.com/luoxin9510/xin-pi/tree/main/.pi/graphs). xpi ships no graph; these are examples.

- [`dev.js`](https://github.com/luoxin9510/xin-pi/blob/main/.pi/graphs/dev.js): grill the request, write the spec,
  build, wait for CI, have it reviewed, merge. The spec node is entered only after you approved the grill and the
  build node only after you approved the spec; a command node makes the build's branch from `main`, and stops the graph on a detached HEAD or on any other branch; the
  merge is a command node behind a CI pass that came after the last visit of build. The review node's prompt
  tells the model to start a fresh subagent for the review, because a node in the same session has seen how the
  code was written. Its header says what the shape guarantees and what the lists only make unlikely: a model on
  main with a plain `git push` is stopped by the branch node and by branch protection on GitHub, not by `deny`.
- [`release.js`](https://github.com/luoxin9510/xin-pi/blob/main/.pi/graphs/release.js): the release flow up to
  the tag. The version bump, the merge and the tag are command nodes; you approve patch or minor, and the merge;
  the tag waits for CI of the merge commit itself.
  It shows a limit of the format: a graph has no variables, so "patch or minor" is two command nodes and the
  model picks one.

Both first check that the branch has an open pull request (a closed or merged one does not count; without one, the node fails at once, with a message), then wait for the checks of that pull request with a small shell loop before `gh pr checks --watch`: a push registers
its checks a little later, and a check that is not there yet would count as a failure.

A graph of your own is short. This one runs a check until it passes, and goes back to the fix at most three
times:

```js
export default {
  name: "green",
  start: "fix",
  nodes: {
    fix:   { prompt: "Make the tests pass. Do not change the tests.", readOnly: ["test/**"] },
    check: { run: "npm test" },
  },
  edges: [
    { from: "fix",   to: "check", exit: "model" },
    { from: "check", to: "fix",   exit: "fail", max: 3 },
    { from: "check", to: "end",   exit: "pass" },
  ],
};
```

## The entries

Custom entries in the session file, none of them sent to the model:

| Entry | Data | Written when |
|---|---|---|
| `graph.start` | the graph as its file's literal, the file path, the selection to give back | `/graph start` |
| `graph.node` | `node`, `via`, `edge`, `report` | a node is entered |
| `graph.move` | `edge`, `via`, `report`, `runStartedAt` (from a command's result: the `startedAt` of its run) | a move is accepted and not entered yet: from `next`, or a command's result |
| `graph.run` | `node`, `run`, `replay`, `startedAt` | a command is about to run; with no result after it, it was interrupted |
| `graph.halt` | `reason`, `runStartedAt` (a run's own halt), `interrupted` (the `startedAt` of the run a crash cut off) | the graph halts |
| `graph.blocked` | `tool`, `rule`, `node` | a limit blocked a call |
| `graph.asked` | `node`, `to`, `answer` (`approve`, `send_back`, `stop`, `dismissed`), `askedAt` | an approval question is answered, before what the answer causes |
| `graph.end` | `reason` (`done`, `stopped`, `model_changed`), `duringRun` | the graph is over |

Each of them also has `at`, the time it was made. That is not always the entry's own timestamp: the entries of a move
entered at the end of a turn are committed together when the turn settles.

The messages the model sees are custom messages: `graph.enter` (a node's entry message), `graph.command` (a command
node's result; its `details` hold `node`, `run`, `code`, `timedOut`, `startedAt`, `durationMs`, `lines` and
`outcome`) and `graph.reminder`.

## Turning it off

`"-builtin:graph"` in `extensions` (see [Settings](settings.md)). Without `/graph start` the extension registers no
tool and changes no request.

## Implementation

- `packages/xpi-graph`: the file format (`parseGraph`), the checks (`checkGraph`), the state folded from the
  session's entries (`readState`, `exits`) and the report of a run (`report`, `formatReport`, `mermaid`). It imports
  nothing of the workspace.
- `src/extensions/graph/`: `files.ts` finds and reads graph files; `limits.ts` holds the limits of a node;
  `index.ts` registers `graph/auto`, the `next` tool and `/graph`, enters a move at `agent_before_settle` or, for a
  move whose turn did not enter it, at `before_agent_start`, and runs command nodes with the runner of
  [checks](checks.md) (its own process group, killed on timeout or abort), always outside a turn: started at
  `agent_settled`, at `before_agent_start` or by `/graph start|goto`, after `pi.persistSession()` and a `graph.run`.
- Tests: `packages/xpi-graph/test/`, `test/graph-files.test.ts`, `test/graph-limits.test.ts`,
  `test/repo-graphs.test.ts` (the two graphs above load, and are refused with a control taken out),
  `test/suite/graph.test.ts` and `test/suite/graph-controls.test.ts` (faux provider, a fake command runner; the
  report, the live view and the events too), `test/checks-runner.test.ts` (`onOutput`).
- Spec and decisions: `.scratch/xpi-graph/` (`03-replay.md`: commands after a crash).
