# xin-pi

xin-pi is an independent fork of [pi](https://github.com/earendil-works/pi) by earendil-works (MIT). It is a minimal,
extensible coding agent harness: you adapt it with [extensions](packages/xpi-coding-agent/docs/extensions.md),
[skills](packages/xpi-coding-agent/docs/skills.md), [prompt templates](packages/xpi-coding-agent/docs/prompt-templates.md)
and [themes](packages/xpi-coding-agent/docs/themes.md), and use it [interactively](packages/xpi-coding-agent/docs/usage.md),
in [print or JSON mode](packages/xpi-coding-agent/docs/cli.md), over [RPC](packages/xpi-coding-agent/docs/rpc.md), or from
the [TypeScript SDK](packages/xpi-coding-agent/docs/sdk.md).

What differs from pi: the command is `xpi`, packages are named `xpi-*` (only the CLI, `xpi-coding-agent`, is published
to npm), environment variables are `XPI_*`, and these built-in extensions are added:

- [subagent](packages/xpi-coding-agent/docs/subagent.md): Claude Code-compatible agents called from codemode scripts
  (`Agent`, with structured output, worktree isolation, memory and names), a `fork` that starts with the whole
  conversation (`/subtask`), `SendMessage` to steer or continue one,
  background scripts, saved [workflows](packages/xpi-coding-agent/docs/subagent.md#workflows) run as `/name` or by the
  model (with relaunch from saved results, and pause), a built-in `/review` workflow (parallel read-only `reviewer`
  agents and a verifier return ranked findings for your uncommitted changes, a branch, a commit or a PR), and a panel and
  full-screen view to watch and talk to subagents.
- [relay](packages/xpi-coding-agent/docs/relay.md): the model `relay/auto`. A strong model explores, plans and reviews;
  a cheap one builds; the strong model reads a record of the result instead of the cheap one's transcript.
- `upstream`: `/upstream` reports what upstream pi has that is worth porting.
- `commit`: `/commit` drafts a commit message for the staged changes with a small model (setting `commit.model`,
  default `haiku`), opens it in an editor, and commits; hooks run and nothing is pushed or amended.

- `xpi sg`: a private git history over a workspace that another version control system owns, with `import` and `export`
  as the sync point and a small adapter script for the host VCS. The built-in `shadow-git` extension gives sessions in
  such a workspace git with no setup, `/sg`, guards for agents, and sandboxes for subagents and teammates
  (`isolation: "worktree"`). See [docs/shadow-git.md](packages/xpi-coding-agent/docs/shadow-git.md).

xin-pi does not merge upstream; changes are ported by hand. The full list is in [docs/xin-pi.md](docs/xin-pi.md).

## Getting started

Node.js 22.19 or newer. Install the published CLI:

```bash
npm install -g xpi-coding-agent
xpi
```

Each [GitHub Release](https://github.com/luoxin9510/xin-pi/releases) also carries standalone `xpi` binaries
(`xpi-<platform>.tar.gz` / `.zip`, with `SHA256SUMS`). npm is published by hand and can be behind the latest release.

Or run it from source:

```bash
npm install
npm run build        # refreshes model data, then builds all packages
```

Run the built command from the checkout:

```bash
node packages/xpi-coding-agent/dist/bundle/cli.js        # or link it as `xpi`: cd packages/xpi-coding-agent && npm link
```

or run straight from TypeScript sources with the dev launcher, from any directory:

```bash
/path/to/xin-pi/xpi-test.sh
```

Inside xpi, run `/login` to connect a subscription or API key, then give it a task. The upstream installers
(`pi.dev/install.sh`, `npm i -g @earendil-works/...`, Nix) install upstream pi, not xin-pi, and do not apply here.
Configuration stays in the shared `~/.pi/agent` directory (override with `XPI_CODING_AGENT_DIR`).

## Packages

This monorepo contains the `xpi` CLI and its supporting libraries. All share one version; only `xpi-coding-agent` is
published to npm (it bundles the others).

| Package | Description |
|---------|-------------|
| **[xpi-telemetry](packages/xpi-telemetry)** | Vendor-neutral telemetry contracts, reference adapter, conformance tests, and typed schemas |
| **[xpi-ai](packages/xpi-ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[xpi-agent-core](packages/xpi-agent-core)** | Agent runtime with tool calling and state management |
| **[xpi-coding-agent](packages/xpi-coding-agent)** | Interactive coding agent CLI |
| **[xpi-tui](packages/xpi-tui)** | Terminal UI library with differential rendering |
| **[xpi-codemode](packages/xpi-codemode)** | Sandboxed JavaScript execution where the only capability is calling injected tools |
| **[xpi-mcp](packages/xpi-mcp)** | Standalone Model Context Protocol client |
| **[xpi-schema](packages/xpi-schema)** | JSON Schema validation without eval (drafts 2020-12 and 7) |
| **[xpi-evals](packages/xpi-evals)** | Real-model evals (private, not published) |
| **[xpi-shadow-git](packages/xpi-shadow-git)** | A private git history over a workspace owned by another version control system, with `import` and `export` as the sync point (`xpi sg`; see [shadow-git](packages/xpi-coding-agent/docs/shadow-git.md)) |
| **[xpi-roost](packages/xpi-roost)** | Background sessions: the roost daemon, PTY host, the hub, schedules and their library (private, ships inside `xpi-coding-agent`) |

## Permissions & Containerization

Pi does not include a built-in permission system for restricting filesystem, process, network, or credential access. By default, it runs with the permissions of the user and process that launched it.

If you need stronger boundaries, containerize or sandbox Pi. See [packages/xpi-coding-agent/docs/containerization.md](packages/xpi-coding-agent/docs/containerization.md) for three patterns:

- **Gondolin extension**: keep `pi` and provider auth on the host while routing built-in tools and `!` commands into a local Linux micro-VM.
- **Plain Docker**: run the whole `pi` process in a local container for simple isolation.
- **OpenShell**: run the whole `pi` process in a policy-controlled sandbox.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [AGENTS.md](AGENTS.md) for project-specific rules (for both humans and agents).  

## Development

```bash
npm install --ignore-scripts  # Install all dependencies without running lifecycle scripts
npm run build         # Refresh model data, then build all packages
npm run build:offline # Rebuild using existing model data without network access
npm run check         # Lint, format, and type check
./test.sh            # Run tests (skips LLM-dependent tests without API keys)
./xpi-test.sh         # Run xpi from sources (can be run from any directory)
```

### Using local packages outside the monorepo

Build every public package into one coherent local artifact set:

```bash
npm run pack:packages -- --out .artifacts/pi-packages
```

This refreshes model data before building `pi-ai`. To avoid network access when
model data is already hydrated, pass `--offline-model-data`.

Then configure an external project to consume one package and resolve all of
its Pi dependencies from the same artifact set. npm is the default:

```bash
node scripts/use-local-packages.mjs \
  --manifest .artifacts/pi-packages/manifest.json \
  --consumer ../my-project \
  --package xpi-ai \
  --package xpi-agent-core
cd ../my-project
npm install --ignore-scripts
```

For a pnpm project, point `--consumer` at the workspace root:

```bash
node scripts/use-local-packages.mjs \
  --manifest .artifacts/pi-packages/manifest.json \
  --consumer ../my-project \
  --package xpi-agent-core \
  --package-manager pnpm
cd ../my-project
pnpm install --ignore-scripts
```

Repeat `--package` for each direct dependency. The command updates the
consumer's `package.json` with content-addressed local `file:` references. It
writes transitive overrides to `package.json` for npm or `pnpm-workspace.yaml`
for pnpm. Keep the artifact directory available while installing or updating
the consumer. Re-run both commands after changing Pi source.

## Supply-chain hardening

We treat npm dependency changes as reviewed code changes.

- Direct external dependencies are pinned to exact versions. Internal workspace packages remain version-ranged.
- `.npmrc` sets `save-exact=true` and `min-release-age=2` to avoid same-day dependency releases during npm resolution.
- `package-lock.json` is the dependency ground truth. Pre-commit blocks accidental lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1` is set.
- `npm run check` verifies pinned direct deps, native TypeScript import compatibility, and the generated coding-agent install lock.
- The upstream installer installed from `packages/xpi-coding-agent/install-lock/`, generated from the root lockfile, to pin transitive deps. The npm package does not pin transitive deps.
- Local release smoke tests (`npm run release:local`) build and pack with the same scripts the release workflow uses. npm is published by hand from the self-contained tarball `npm run xpi:pack` writes; publishing the package folder directly is refused.
- Local release installs and the documented npm install use `--ignore-scripts`. xpi does not update itself.
- CI installs with `npm ci --ignore-scripts`, and a scheduled GitHub workflow runs `npm audit --omit=dev` plus `npm audit signatures --omit=dev`.
- Install lock generation has an explicit allowlist for dependency lifecycle scripts; new lifecycle-script deps fail checks until reviewed.

## License

MIT. Original copyright Mario Zechner (pi); additions by luoxin9510. See [LICENSE](LICENSE).
