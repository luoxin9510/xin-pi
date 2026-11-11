# Environment Variables

Pi uses environment variables in three ways:

- Variables such as `XPI_OFFLINE` configure the Pi process.
- Pi sets process markers so child processes can identify Pi as the launching agent.
- Commands run by the LLM-callable shell tools receive `PI_*` variables describing the current session.

Provider API-key variables are documented separately in [Providers](providers.md#use-an-api-key-from-the-environment).

## Process Marker

The CLI and RPC entry points set two process markers:

- `AI_AGENT=pi` is a generic marker that lets tooling identify Pi as the agent that launched the process.
- `XPI_CODING_AGENT=true` is Pi-specific and lets child processes detect that they run inside Pi.

Child processes inherit both markers. They are not session-specific and are not set automatically when Pi is embedded through the SDK.

## Shell Tool Session Environment

Commands run by the `bash` and `powershell` tools receive the current Pi session state:

| Variable | Description |
|----------|-------------|
| `XPI_SESSION_ID` | Current session ID |
| `XPI_SESSION_FILE` | Absolute path to the current session JSONL file; unset for ephemeral sessions |
| `XPI_PROVIDER` | Currently selected model provider |
| `XPI_MODEL` | Currently selected model ID |
| `XPI_REASONING_LEVEL` | Current effective reasoning level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` |

The values are resolved when each command starts. Switching models or changing the reasoning level therefore affects the next shell command without restarting Pi. `XPI_PROVIDER` and `XPI_MODEL` identify the selected Pi model, not a different upstream model that a router may choose internally.

When asked which model or provider is running, inspect these variables instead of inferring the answer from the system prompt:

```bash
printf '%s/%s\n' "$XPI_PROVIDER" "$XPI_MODEL"
printf 'reasoning=%s session=%s\n' "$XPI_REASONING_LEVEL" "$XPI_SESSION_ID"
```

The session file can be inspected directly when the session is persistent:

```bash
if [ -n "$XPI_SESSION_FILE" ]; then
  tail -n 1 "$XPI_SESSION_FILE"
fi
```

These variables are injected into the LLM-callable `bash` and `powershell` tools. They are not injected into user-entered `!` or `!!` commands.

### Custom Shell Tools

Tools created with `createBashTool()` or `createPowerShellTool()` expose the session environment by default when registered with Pi. Injection happens before `spawnHook`, so a hook receives the variables in `ctx.env`:

```typescript
const bashTool = createBashTool(cwd, {
  spawnHook: (ctx) => ({
    ...ctx,
    env: { ...ctx.env, CI: "1" },
  }),
});
```

Disable session metadata independently of the spawn hook:

```typescript
const powershellTool = createPowerShellTool(cwd, {
  exposeSessionEnvironment: false,
  spawnHook: (ctx) => ctx,
});
```

When disabled, Pi removes inherited values for these variables so nested Pi processes do not expose stale parent-session metadata.

## Pi Process Configuration

These variables are read by Pi itself:

| Variable | Description |
|----------|-------------|
| `XPI_CODING_AGENT_DIR` | Override the config directory; default is `~/.pi/agent` |
| `XPI_CODING_AGENT_SESSION_DIR` | Override session storage; overridden by `--session-dir` |
| `XPI_PACKAGE_DIR` | Override the package directory, useful for Nix/Guix store paths |
| `XPI_OFFLINE` | Disable automatic network activity, including model catalog refreshes |
| `XPI_SKIP_VERSION_CHECK` | No effect on xpi: the latest-version check is always off (xpi does not update itself; `xpi update --self` explains how to update) |
| `XPI_SELF_UPDATE_COMMAND` | Unused in xpi (self-update is disabled). Command `pi update` ran to update Pi itself, split on whitespace, with `{packageName}`, `{version}`, and `{installSpec}` placeholders. Takes precedence over the `selfUpdateCommand` setting. See [Custom update command](cli.md#custom-update-command) |
| `XPI_TELEMETRY` | Override install/update telemetry and provider attribution headers: `1`/`true`/`yes` or `0`/`false`/`no` |
| `XPI_CODEMODE_MAX_WORKERS` | Maximum codemode workers alive at once across all sessions in the process; default `2`. Each worker's script may use up to 256 MB. Raise it when one process runs several sessions, such as in-process subagents. Further scripts wait for a free worker. See [Codemode](codemode.md) |
| `XPI_CACHE_RETENTION` | Set to `long` for extended provider prompt caching where supported |
| `XPI_SHARE_VIEWER_URL` | Override the base URL used by `/share` |
| `XPI_RADIUS_GATEWAY` | Override the Radius gateway origin used by `/bug` uploads |
| `XPI_CLEAR_ON_SHRINK` | Set to `1` to clear empty rows when rendered content shrinks; the `terminal.clearOnShrink` setting takes precedence. See [Settings](settings.md) |
| `XPI_HARDWARE_CURSOR` | Set to `1` to show the hardware cursor; see [Terminal setup](terminal-setup.md) |
| `XPI_CLIPBOARD_OSC52` | Set to `1` to also send copied text to the terminal with OSC 52 after the local clipboard write, as Pi does over SSH. Use it when a remote client reaches Pi without SSH variables, such as a multiplexer attached from another machine or a remote IDE daemon |
| `XPI_HYPERLINKS` | Override OSC 8 hyperlink detection with `1`, `0`, or `auto` |
| `XPI_PROGRAM_STATUS` | Override OSC 7501 program status detection: `1` always reports, `0` never reports; otherwise Pi reports only after the terminal confirms support. See [Terminal setup](terminal-setup.md#program-status) |
| `XPI_IMAGE_PROTOCOL` | Override inline image detection with `kitty`, `iterm2`, `none`, or `auto` |
| `XPI_TRUE_COLOR` | Override truecolor detection with `1`, `0`, or `auto` |
| `XPI_TUI_ESC_TIMEOUT` | How long to wait after a lone ESC before treating it as Escape, in milliseconds; defaults to `100` over SSH and `10` otherwise. Increase if Alt-key input is misread as Escape |
| `VISUAL`, `EDITOR` | External editor fallback when `externalEditor` is unset |
| `HTTP_PROXY`, `HTTPS_PROXY` | Proxy outbound HTTP requests |

Provider credentials such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and provider-specific configuration are listed in [Providers](providers.md#use-an-api-key-from-the-environment).

## Background Sessions

`xpi roost` keeps a daemon per agent directory: state in `<agent dir>/xpi-roost/`, sockets in
`$XDG_RUNTIME_DIR/xpi-roost-<key>` or `/tmp/xpi-roost-<uid>/<key>`, where `<key>` is derived from the agent directory.
See [CLI](cli.md#background-session-commands).

| Variable | Description |
|----------|-------------|
| `ROOST_HOME` | Override the state directory (default `<agent dir>/xpi-roost`) |
| `ROOST_RUNTIME_DIR` | Override the socket directory. Each of its levels must be a directory you own, not a link, and the path must stay short enough for a Unix socket |
| `ROOST_AGENT_DIR` | The agent directory the two overrides belong to. When it names another directory than the one xpi uses, `ROOST_HOME` and `ROOST_RUNTIME_DIR` are ignored |
| `XDG_RUNTIME_DIR` | When set (usually on Linux), the base of the default socket directory, unless a socket path would be too long there |

A background session carries `ROOST_AGENT_DIR`, `ROOST_HOME` and `ROOST_RUNTIME_DIR` of its roost, so `xpi roost` run
inside it reaches the same daemon, and an xpi with another agent directory (`XPI_CODING_AGENT_DIR`) gets a daemon of
its own. Other `ROOST_*` names are internal.
