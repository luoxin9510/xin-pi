# 04: Fork (a child that inherits main's conversation)

Status: done (2026-11-10, `issues/04-fork.md`).

## Problem

A subagent starts empty: main must put everything it knows into `prompt`. For a side task that needs the whole
conversation ("try the other approach we discussed", "write the tests for what we just built") that means retyping
context, and the child pays full price for its first request. Claude Code's fork is a subagent that starts as a copy of
the main conversation and returns only its final result.

## Claude Code's fork, as far as its docs state it

From `code.claude.com/docs/en/sub-agents` (read 2026-11-10; the fork section came through a summary, so wording is not
verbatim):

- A fork "inherits everything the main session has at the moment it spawns": the conversation, and the same system
  prompt, tools and model as main. Because prompt and tool definitions are identical, its first request reuses main's
  prompt cache.
- Started by the user with `/subtask <task>`, or by the model while fork mode is on. `isolation: "worktree"` may be
  passed. How the model names a fork in the `Agent` call is not in what was read (`Agent(fork)` appears as a permission
  rule).
- A fork cannot start further forks. It runs in the background; only its final result comes back, as a message.
- On by default in recent versions; `CLAUDE_CODE_FORK_SUBAGENT=0` turns it off.

## Facts this builds on (xpi)

- `xpi --fork <path|id>` already copies a session into a new one (`SessionManager.forkFrom`, `src/cli/args.ts`).
- A child is `xpi --mode rpc` with `--session-dir <parent's subagents dir> --session-id <agentId>`, its own system
  prompt (head + tail), `--tools` from the agent file, and `XPI_SUBAGENT_DEPTH=1` (no `Agent` tool in the child).
- Main's session file gets each message at `message_end`. While a codemode script runs, the assistant message with the
  `codemode` tool call is in the file and its tool result is not.
- Prompt cache: a request reuses a prefix only when tools, system prompt and earlier messages are byte-identical up to
  a breakpoint (`docs/xin-pi.md`, "Prompt cache layout").

## Solution (proposed)

- `Agent({ subagent_type: "fork", prompt, description, name?, isolation?, run_in_background? })`. `fork` is a reserved
  agent type with no agent file. `model`, `effort` and `schema` are refused on a fork (it is main, continued).
- `/subtask <task>`: the user starts a fork with no model turn, as a background agent; its result arrives in main as
  a message.
- The child starts from a copy of main's session taken at the call (`--fork <main session file>` into the subagents
  dir), with main's model, thinking level, system prompt and tool list, so its first request reads main's cache. The
  task arrives as a user message. Its panel row, screen, `resume`, `SendMessage`, stop and worktree isolation work as
  for any subagent.
- The copy ends in the middle of main's turn (the `codemode` call that runs the script has no result yet). The child
  gets a result for that call saying it is the fork: "You are a fork of this conversation. Do the task in the next
  message and reply with the result; do not continue the script." (Claude Code does the same in substance.)
- A fork runs as a normal child, so it has no `Agent`, `SendMessage` or `Workflow`: it cannot start a subagent (see
  Verified: the cache prefix is kept anyway).
- Not available with an in-memory session (`--no-session`): there is no file to copy. The call throws and says so.
- Setting `subagent.fork` (default true): false removes `/subtask` and makes the type throw.

## To verify before tickets (throwaway prototypes, as for spec 02)

1. A session copied mid-turn, plus an injected tool result, is accepted by the provider and the child answers the
   task (haiku).
2. The child's first request reads main's cache: `cacheRead` covers main's prefix (measured with
   `npm run test:subagent:cache`-style probes). If the child's tool list or prompt differs by one byte it does not;
   find what differs (for example `XPI_SUBAGENT_DEPTH` changing the tool list) and what it costs to make it equal.

## Verified (2026-11-10, haiku, throwaway runs in a temp agent dir)

Main session: one user message (a code word, then "call codemode with `return 6*7`"), `--tools +codemode`, the
subagent extension on. Its first request wrote 5929 tokens to the cache.

1. **The provider accepts the copy.** The session file was cut after the assistant message holding the `codemode` call,
   and a tool result with the fork text was appended for it. `xpi --fork <that file> -p "What is the code word?"`
   answered `KIWI-9`: the fork knew the conversation without being told.
2. **The fork reads main's cache.** Its first request: `cacheRead 5929`, `cacheWrite 115`, `input 4`.
3. **Also with today's child environment** (`XPI_SUBAGENT_DEPTH=1`, so no `Agent`, `SendMessage` or `Workflow`):
   `cacheRead 6044`, `cacheWrite 640`. The system prompt and tool declarations are stored in the session file and travel
   with the copy; what the child lacks is told to the model in a later patch, which costs about 640 tokens once.

Consequences for the solution:

- Decision 3 (a fork starts no subagent) is met by running the fork as a normal child (`XPI_SUBAGENT_DEPTH=1`): the
  tools are simply absent. "Declared but throwing" is not needed, and the cache prefix is kept either way.
- The copy is made by `SessionManager.forkFrom(mainFile, cwd, subagentsDir, { id: agentId })` at the call, then one
  tool result is appended for every tool call of the last assistant message that has none. The child then starts like
  a resume (`--session-dir`, `--session-id`), so no new CLI flag is needed.
- No core change is needed.

## Out of scope

Skills with `context: fork`; a fork of a fork; forking a subagent (only main is forked).

## Testing

- Offline (fake children): the type is reserved, refused fields, in-memory session, the copied session and the injected
  result (file contents), `/subtask`, a fork cannot fork, the setting.
- Real, by hand (haiku): main learns a fact in conversation, forks, and the fork answers from it without being told;
  cache read on the fork's first request.
- Evals: main is asked for a side task that needs the conversation and uses a fork instead of restating context.

## Tickets (after approval and the two prototypes)

1. Tracer: `subagent_type: "fork"` starts a child from a copy of main's session with the injected result; result
   returns like any agent's.
2. Same prompt, tools and model as main; cache measured; limits (no fork of a fork, refused fields, in-memory).
3. `/subtask`, the setting, docs, eval, real run.
