# 04: Fork

Spec: `../04-fork.md`. Branch `subagent-fork`. The three planned tickets landed together: the prototypes showed no core
change was needed.

**Status:** done (2026-11-10)

- [x] Prototypes (spec, "Verified"): the provider accepts a session copied mid-turn with an injected tool result; the
      fork's first request reads main's cache (5929 of 5929 tokens), also with today's child environment
- [x] `subagent_type: "fork"` (`fork.ts`, `agent-tool.ts`): reserved type; the copy is seeded with
      `SessionManager.forkFrom` under the fork's id and every unanswered tool call of the last assistant message gets
      the fork result; the child starts like a resume, with main's model and thinking level and no system prompt flags
- [x] Limits: `model`, `effort`, `schema` refused; in-memory session refused; `subagent.fork: false`; an agent file or
      `--agents` entry named `fork` is skipped; a fork is a normal child, so it has no `Agent` tool
- [x] `/subtask <task>`; continue by `resume`, `SendMessage` and from the screen (`talk.ts`)
- [x] Offline: `test/subagent/faults/fork.test.ts` (5)
- [x] Eval on haiku: "parent forks a side task that needs the conversation", 3/3 (the fork answers a code word that
      is not in its prompt, and its first request reads main's cache)
- [x] Docs: `docs/subagent.md` (Fork, config, evals), `slash-commands.md`, `subagent-porting.md`, `docs/xin-pi.md`,
      both READMEs, `AGENTS.md`

## Comments

2026-11-10: **Decision 3 was met more simply than proposed.** The proposal kept `Agent` declared in a fork and made
the calls throw, to keep the cache prefix. The prototype showed the prefix is kept anyway: the system prompt and tool
declarations are stored in the session and travel with the copy, and the missing tools reach the model as a later
patch (about 640 tokens, once). So a fork runs as a normal child.

**No real test file under `test/subagent/real/`.** A fork needs a real main session in the middle of a turn, which the
in-process harness does not have; the eval runs a real parent and checks the same things.
