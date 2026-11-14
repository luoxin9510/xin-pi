# xpi-shadow-git

A private git history over a workspace that another version control system (the host VCS) owns, with an explicit sync
point between the two. It is the library and the command line behind `xpi sg`.

- The shadow repo lives in a store, never in the workspace. Its `core.worktree` names the workspace.
- The `host` branch receives imports from the host; `main` is where work lands. `import` brings host changes in,
  `export` hands `host..main` to the host through the adapter's check-in.
- An **adapter** (`sg-adapter-<name>`, a small executable) is the only code that talks to the host VCS. The package
  ships `sg-adapter-plain` (another directory as the host, for tests and trials) and `sg-adapter-template` (the
  interface, commented). It ships no adapter for any real VCS.
- **Sandboxes** let several agents work on one workspace: `xpi sg sbx create|run|ls|rm`. A sandbox is a git worktree on
  `sbx/<id>` plus a path policy (`sandbox.rule = <mode> <path>`). The primary workspace is read-only to it, shared
  files are links into it, and build output goes to a scratch area. Two backends: `namespace` (Linux, `unshare` and
  `mount`, real isolation) and `policy` (anywhere; advisory for shell commands). `sandboxPolicy(sandbox, path)`
  answers what a sandboxed command may do with a path.
- Runtime dependencies: Node and git 2.20 or newer. No npm dependencies.

```typescript
import { runSg } from "xpi-shadow-git";

const exitCode = await runSg(["status"], { cwd: "/proj/ws", defaultStore: "/home/me/.pi/agent/shadow-git" });
```

`runSg(args, options)` runs `xpi sg <args>` and returns the exit code (0 success, 1 a git or adapter failure, 2 a failed
precondition). `options.cwd` is required; `env`, `stdout`, `stderr`, `stdio`, `defaultStore`, `builtinAdaptersDir`,
`lockTimeoutMs` and `ownSessionPid` are optional. The environment variables `XPI_SG_STORE`, `XPI_SG_GIT` and
`XPI_SG_ADAPTER_PATH` apply. The other exports (`initRepo`, `importHost`, `abortImport`, `exportMain`, `exportPlan`,
`mergeBranch`, `resolveRepo`, `withLock`, `liveSessions`, `callAdapter`) are the steps the command is made of, and the
sandbox API is `createSandbox`, `loadSandbox`, `sandboxFromEnv` (`XPI_SG_SANDBOX`), `listSandboxes`, `removeSandbox`,
`refreshTree`, `runInSandbox`, `sandboxPolicy`, `probeNamespace`, `resolveBackend` and `namespaceScript`.

The commands, the sync model, the adapter contract and the limits are in
[shadow-git.md](../xpi-coding-agent/docs/shadow-git.md).

## Tests

```bash
cd packages/xpi-shadow-git
node ../../node_modules/vitest/dist/cli.js --run
```

The tests use temp directories, real git and the plain adapter; they set `XPI_SG_STORE` and never touch `~/.pi`.
`test/namespace.test.ts` needs unprivileged user namespaces and skips, with the probe's message, where they are not
available (macOS, a restricted runner). To run it on Linux from another system, use a container runtime that allows
unprivileged user namespaces and a fresh `/proc` (for example with seccomp and AppArmor unconfined and the masked
system paths unconfined), install vitest in a scratch directory, copy the package there and run it.
