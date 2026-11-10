# Contributing to xin-pi

xin-pi is a personal distribution of [pi](https://github.com/earendil-works/pi) with built-in extensions, shipped as the `xpi` CLI. It is maintained by one person, so this guide exists to save both sides time.

Bugs that also happen in upstream pi belong in [upstream's tracker](https://github.com/earendil-works/pi/issues).

## Philosophy

The core stays minimal, as in pi. What xin-pi adds lives in built-in extensions (`packages/xpi-coding-agent/src/extensions/`). PRs that bloat the core will likely be rejected.

## The One Rule

**You must understand your code.** If you cannot explain what your changes do and how they interact with the rest of the system, your PR will be closed.

Using AI to write code is fine. Submitting AI-generated slop without understanding it is not.

If you use an agent, run it from the repository root so it picks up `AGENTS.md` automatically. Your agent must follow the rules and guidelines in that file.

## Quality Bar For Issues

If you open an issue, you must use one of the two GitHub issue templates.

If you open an issue, keep it short, concrete, and worth reading.

- Keep it concise. If it does not fit on one screen, it is too long.
- Write in your own voice (do not use an LLM to generate text, if you must, follow up with a clearly AI labeled comment).
- State the bug or request clearly.
- Explain why it matters.
- If you want to implement the change yourself, say so.

Issues that do not meet this bar may be closed without a reply.

## Blocking

Accounts that spam the tracker, for example with large volumes of agent-generated issues, are blocked.

## Before Submitting a PR

Open an issue first and wait for a maintainer to agree with the change. Before submitting a PR:

```bash
npm run check
./test.sh
```

Both must pass.

Do not edit `CHANGELOG.md`. Changelog entries are added by maintainers.

If you are adding a new provider to `packages/xpi-ai`, see `AGENTS.md` for required tests.

## Questions?

Open an issue with the contribution template.

## FAQ

### Why do some issues get no reply?

A reply is maintenance work too. Low-signal issues, unclear reports, duplicates, and issues that do not follow this guide may be closed without discussion. This keeps time available for reproducible bugs, thoughtful requests, and contributors who have done the work to make their report actionable.

### Why not let AI triage everything?

AI can help group duplicates, summarize reports, and spot missing information. It is not trusted to make final maintainer decisions. Polished AI-generated issues can still be wrong, misleading, or expensive to investigate. Human review remains the final gate.
