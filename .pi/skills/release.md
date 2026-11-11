---
name: release
description: Prepare, publish, verify, and recover xin-pi releases (xpi). Use for release preparation, local release smoke tests, the release PR and tag, and failed release CI.
---

# Releasing xin-pi

Run repository commands from the repo root (two directories above this skill), unless instructed otherwise.

**One version**: all `xpi-*` packages share one version, and the tag is `v<version>`. `patch` = fixes and additions, `minor` = breaking changes. Only `xpi-coding-agent` (the `xpi` CLI) is published to npm; its bundle includes the other packages.

**What does what**:
- `npm run release:patch` / `release:minor` / `release:major` (or `node scripts/release.mjs bump x.y.z`): opens the version bump as a PR.
- `npm run release:tag`: tags main once that PR is merged and CI on main passed.
- `.github/workflows/release.yml` (on the tag): builds the source archive and the standalone `xpi` binaries, smoke-tests them on Linux, macOS and Windows, and publishes the GitHub Release with notes generated from the merged PRs.
- npm: the owner publishes by hand (2FA). Never run `npm publish` unless the owner says so in that turn.

1. **Local smoke test** (optional but recommended before a minor release): build an unpublished release and test it from outside the repo, so it cannot resolve workspace files:
   ```bash
   npm run release:local -- --out /tmp/xpi-local-release --force
   cd /tmp

   /tmp/xpi-local-release/node/xpi --help
   /tmp/xpi-local-release/node/xpi --version
   /tmp/xpi-local-release/node/xpi --list-models
   /tmp/xpi-local-release/node/xpi -p "Say exactly: ok"
   ```
   It also imports the SDK from the isolated npm install. Only the Node build is tested locally; `--bun` adds the
   standalone Bun binary and a Bun install (needs `bun` on PATH), which the release workflow builds anyway. For real prompts, use a temporary `XPI_CODING_AGENT_DIR` holding a copy of `auth.json`, never the real `~/.pi/agent`. Load [interactive-testing.md](interactive-testing.md) for the tmux workflow if the interactive mode needs a check.

2. **Open the release PR** from an up-to-date main with a clean tree:
   ```bash
   npm run release:patch    # fixes + additions
   npm run release:minor    # breaking changes
   ```
   It creates branch `release-vX.Y.Z`, sets every package to the new version, refreshes `package-lock.json` and `packages/xpi-coding-agent/install-lock`, commits `chore: release vX.Y.Z` (the pre-commit hook runs `npm run check`), pushes, and opens the PR. If a fresh lockfile refresh is blocked by npm's release-age gate, rerun with `npm_config_min_release_age=0`. Review the lockfile diff in the PR. Like every PR, it is merged only after the independent Claude Opus review in `AGENTS.md` (Issues and PRs).

   A version already on main that was never tagged (for example after a manual bump) needs no PR: go to step 3.

3. **Tag** after the PR is merged and CI on main passed:
   ```bash
   git checkout main && git pull --ff-only
   npm run release:tag
   ```
   It refuses when the tree is dirty, main differs from origin/main, the packages are not on one version, the tag exists, or CI has not passed on main's head. It pushes only the new tag (the local clone also holds upstream pi's tags; never `git push --tags`).

4. **Watch the release workflow**: `gh run list --repo luoxin9510/xin-pi --workflow release.yml`. When it is green, the release is at `https://github.com/luoxin9510/xin-pi/releases/tag/vX.Y.Z`.

5. **npm**: tell the owner the release is ready and give them the command; they run it themselves:
   ```bash
   npm run xpi:pack
   npm publish ./dist-pack/xpi-coding-agent-X.Y.Z.tgz --access public
   ```

6. **If the release workflow fails**: the tag cannot be moved. Read the failed job. A draft release left behind is deleted by the workflow. If the failure was transient, rerun the workflow (`gh run rerun <id> --failed`) or start it by hand with the tag (`gh workflow run release.yml -f tag=vX.Y.Z`). If the code was wrong, fix main and release the next patch version. A published release is never changed by the workflow.
