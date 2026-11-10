# 01: Packages ship workflows and agents

Status: draft, waiting for Grill 1 (`decisions.md`). No code until the owner approves.

## Problem Statement

A package can ship extensions, skills, prompts and themes (`RESOURCE_TYPES` in `src/core/package-manager.ts`). It
cannot ship saved workflows or agent definitions, so a `/review` workflow with its own `reviewer` agent cannot be
installed with `xpi install`. Today the only routes are copying files into `.pi/workflows/` and `.pi/agents/` by hand,
or an extension that writes them at start-up.

## Solution

Two new resource types, `workflows` and `agents`, handled like the other four: conventional directories
(`workflows/`, `agents/`), manifest keys in the `pi` field, per-type filters in `packages` entries, and the
`resources_discover` event gains `workflowPaths` and `agentPaths`. The subagent extension adds the package paths to
its discovery, below the project and user directories, so a user's own file of the same name wins.

## User Stories

1. As a package author, I want to put `review.js` in `workflows/` and `reviewer.md` in `agents/`, so that `xpi install`
   gives users `/review` and the `reviewer` agent.
2. As the owner, I want my own `.pi/workflows/review.js` to win over a package's, so that I can customise it.
3. As the owner, I want `xpi config` and package filters to turn package workflows and agents on and off like skills.
4. As an extension author, I want `resources_discover` to add workflow and agent paths, like skill paths.
5. As the owner, I want a project package's workflows and agents to load only in a trusted project, like its other
   resources.

## Implementation Decisions

- `RESOURCE_TYPES` gains `workflows` and `agents`; manifest, filters, `xpi config` and `xpi list` follow.
- Discovery order for workflows: `.pi/workflows/`, `.claude/workflows/`, `~/.pi/agent/workflows/`,
  `~/.claude/workflows/`, then package and extension-supplied paths. Agents the same, then built-ins last.
- Name collisions keep the first found and warn, as today.
- A package workflow is runnable without project trust when the package itself is a user package.

## Testing Decisions

- Package-manager tests with a fixture package holding `workflows/` and `agents/`: resolved paths, filters, project
  trust. Subagent discovery tests: package paths found, user file wins on a name collision.
- Prior art: package-manager tests, `test/subagent/` discovery tests.

## Out of Scope

- Agents' `skills` field searching package skill paths.
- Hot reload of package workflows (they load at start and on `/reload`, like the others).
