<a id="cli-and-modes-reference"></a>

# Command Line

This page documents Pi's built-in command-line commands and options. Run `pi --help` or append `--help` to a command for the exact interface in your installed version. The top-level help also includes options registered by loaded extensions.

```sh
pi [options] [--] [@files...] [messages...]
pi install <source> [options]
pi remove <source> [options]
pi uninstall <source> [options]
pi update [target] [options]
pi list
pi config [options]
pi auth login <provider> [--api-key] [--no-browser]
pi auth logout <provider>
pi auth <check|print-api-key|print-bearer-token> [options]
pi mcp <add|remove|list|login|logout> [options]
```

<a id="modes"></a>

## Invocation and output

```sh
pi
pi --print "Summarize this repository"
git diff | pi --print "Review this change"
pi --mode json "Inspect this repository" > events.jsonl
```

With terminal stdin and stdout, Pi opens the terminal UI unless `--print`, `--mode json`, or `--mode rpc` selects another interface. When either stream is redirected and neither JSON nor RPC mode is selected, Pi uses print mode. See [CLI Integration](cli-integration.md) for choosing between interactive, print, JSON, RPC, and SDK integration.

| Input | Behavior |
|---|---|
| `message` | Provide an initial prompt |
| `@path` | Include a text file or image in the first prompt |
| Piped stdin | Prepend its contents to the first prompt |
| `--` | Stop option parsing so a prompt can begin with `-` |
| `--agents <json\|path>` | Subagents for this run, as a JSON object or the path of a JSON file; see [Subagents](subagent.md#agents-on-the-command-line). From the built-in `subagent` extension |
| `--mcp-config <json\|path>` | MCP servers for this run, added after `mcp.json`, as JSON in its shape or the path of a JSON file; see [MCP](mcp.md#add-servers-for-one-run). From the built-in `mcp` extension |
| `--bg <task>` | Start `<task>` as a background session in the current directory and exit, printing its id and how to attach; see [Background Sessions](roost.md). Interactive mode only; macOS and Linux with the npm installation. From the built-in `roost` extension |
| `--bg-name <name>` | The name of the session `--bg` starts (default: the task's first six words) |

Pi resolves `@path` from the current working directory. The working directory also controls project configuration, resource discovery, and session grouping.

`--print` controls whether Pi runs once and exits. `--mode` selects the output interface. `--mode text` does not force one-shot execution when stdin and stdout are terminals; use `--print` for that behavior.

| Option | Behavior |
|---|---|
| `-p`, `--print` | Run the supplied prompts, write the final assistant text to stdout, then exit |
| `--mode text` | Select text output; still open the terminal UI when stdin and stdout are terminals |
| `--mode json` | Run the supplied prompts, write JSONL events to stdout, then exit |
| `--mode rpc` | Read JSONL commands from stdin and write responses and events to stdout until shutdown |
| `--export <input> [output]` | Export a session file to HTML and exit; derive the destination when `output` is omitted |

RPC mode rejects `@file` arguments. JSON and RPC modes reserve stdout for protocol records. See [JSON Event Stream](json.md) and [RPC Protocol](rpc.md).

<a id="model-options"></a>

## Models

```sh
pi --model sonnet:high
```

See [Choose a Model](models.md) for model selection and [Providers](providers.md) for credentials.

- `--provider <name>`<br>
  Restricts `--model` lookup to one provider. It requires `--model`.
- `--model <pattern>`<br>
  Selects by exact ID or fuzzy ID/name match. It accepts `provider/id` and an optional `:<thinking>` suffix. If several providers match, Pi prefers the one with credentials, otherwise it asks for `--provider`.
- `--api-key <key>`<br>
  Uses a non-persistent API-key override. It requires a model selected through `--model` or `--models`. It does not choose between providers that offer the same model.
- `--thinking <level>`<br>
  Sets `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. It overrides a `--model` suffix and is clamped to the model's capabilities.
- `--models <patterns>`<br>
  Sets a comma-separated scope for startup and cycling. It accepts exact IDs, fuzzy matches, case-insensitive globs, and optional `:<thinking>` suffixes. A model offered by several providers is added for each, with a warning.
- `--list-models [search]`<br>
  Lists available models, optionally filtered by a fuzzy search, then exits.

<a id="session-options"></a>

## Sessions

```sh
pi --continue
```

See [Sessions and Context](sessions.md) for resuming, forking, naming, and storing sessions.

- `-c`, `--continue`<br>
  Continues the most recent session for the current directory.
- `-r`, `--resume`<br>
  Opens the session selector and resumes the chosen session in its working directory. Press Tab to include sessions from other directories.
- `--session <path|id>`<br>
  Opens a session by file path or full/partial ID, and resumes it in its working directory. If the ID only matches sessions stored for another directory, Pi offers to fork it into the current directory instead.
- `--session-id <id>`<br>
  Opens the current directory's existing session with the ID, or creates it otherwise. IDs accept letters, numbers, `.`, `_`, and `-`.
- `--fork <path|id>`<br>
  Forks a session, chosen by file path or full/partial ID, into a new session in the current directory.
- `--session-dir <dir>`<br>
  Overrides storage and lookup. It takes precedence over `XPI_CODING_AGENT_SESSION_DIR` and the `sessionDir` setting.
- `--no-session`<br>
  Uses an in-memory session that is not persisted.
- `-n`, `--name <name>`<br>
  Sets the session display name.

Constraints:

- Session IDs must start and end with a letter or number.
- `--fork` cannot be combined with `--session`, `--continue`, `--resume`, or `--no-session`.
- `--session-id` cannot be combined with `--session`, `--continue`, or `--resume`. Combine it with `--fork` to choose the new ID.

<a id="tool-options"></a>

## Tools

```sh
pi --tools read,grep,find,ls --print "Review this project"
```

See [Settings](settings.md#tools) for configuring the default tool selection.

- `-t`, `--tools <list>`<br>
  Replaces the default selection with a comma-separated allowlist of built-in, extension, or custom tools. Entries are tool names or patterns where `*` matches any characters. MCP tools are kept unless an entry starts with `mcp__` (see [MCP tools](#tools)). A list of only `+name` and `-name` entries is not an allowlist; it changes the default selection instead.
- `-xt`, `--exclude-tools <list>`<br>
  Disables comma-separated tool names or patterns after all other selection options, MCP tools included.
- `-nbt`, `--no-builtin-tools`<br>
  Disables the default tools while retaining extension and custom tools. `codemode` is one of the default tools, so it is
  off too unless named with `--tools`.
- `-nt`, `--no-tools`<br>
  Starts with all built-in, extension, custom, and MCP tools disabled.

Default enabled tools are `read`, `bash`, `edit`, `write`, and `codemode`, unless `defaultTools` changes them. `--tools` with plain names replaces the whole selection, so name every tool you want. Like `defaultTools`, it also accepts a list of only `+name` and `-name` entries, which adds tools to or removes them from the default selection: `pi --tools +grep,-write` keeps the other default tools, enables `grep`, and disables `write`. These entries take exact tool names, not `*` patterns; use `--exclude-tools` to disable tools by pattern. Plain names and `+name`/`-name` entries cannot be mixed. `/reload` enables tools newly added to `defaultTools`, but a tool removed with `-name` stays removed.

<a id="mcp-tools"></a>

`--tools` selects the tools declared to the model. It does not remove MCP tools, whose reach is set by their [exposure](mcp.md#control-tool-exposure): `pi --tools read,codemode` keeps every MCP tool callable from codemode scripts. An MCP tool that no entry names or matches is never declared directly, whatever its exposure; only `tool_search`, if listed, can load it. Once an entry starts with `mcp__`, `--tools` filters MCP tools too, so this keeps only the tools of the `radius` server:

```sh
pi --tools read,bash,codemode,'mcp__radius__*'
```

The MCP resource tools (`list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource`) count as MCP tools. To remove MCP tools, use `--exclude-tools 'mcp__*'` or [`--no-mcp`](#resources).

| Built-in | Purpose |
|---|---|
| `read` | Read text files and supported images |
| `bash` | Run shell commands |
| `powershell` | Run PowerShell commands on Windows |
| `edit` | Apply exact text replacements to an existing file that was read and has not changed since (see [`staleEditGuard`](settings.md#edit-and-write-safety)) |
| `write` | Create a file, or overwrite one that was read and has not changed since |
| `grep` | Search file contents |
| `find` | Find paths using glob patterns |
| `ls` | List directory contents |

Extensions can add `name://...` paths that these file tools (all but `bash` and `powershell`) accept; see [Path Schemes](extensions.md#path-schemes).

Built-in extensions add two more tools. `codemode` is on by default (it is in the default tool selection); `tool_search` is off. The MCP extension turns them on when an MCP server needs them (see [MCP](mcp.md#control-tool-exposure)). To change them yourself, name them in `--tools` or `defaultTools`.

| Built-in extension | Purpose |
|---|---|
| `codemode` | Run JavaScript that calls the other tools, for example in parallel with `Promise.allSettled`; only the script's output reaches the model |
| `tool_search` | Search tools that are not declared to the model (`codemode` and `deferred` exposure, such as MCP tools) and declare the matches for the next call |

### Enable codemode

`codemode` is one of the default tools, so it is on in every session. To turn it off for every session, remove it in `~/.pi/agent/settings.json` or a project's `.pi/settings.json`:

```json
{
  "defaultTools": ["-codemode"]
}
```

This keeps `read`, `bash`, `edit`, and `write`. For one invocation, remove it with `--tools`:

```sh
pi --tools -codemode
```

With either, an MCP server with `codemode` exposure turns it on again; set `"autoEnableCodemode": false` next to
`mcpServers` to keep it off (see [MCP](mcp.md#control-tool-exposure)), or exclude it with `--exclude-tools codemode`. A
`--tools` list of plain names leaves `codemode` out unless it names it, and MCP cannot turn it on then.

Codemode is useful without MCP: scripts can run several tool calls in parallel, filter large output before it reaches the model, call classifier models such as TypeSafe's Jev through `models.classify()` (see [Classifier models](models.md#use-classifier-models)), and generate images through `models.generateImages()` (see [Image models](models.md#use-image-models)).

### How codemode works

Scripts run in a QuickJS sandbox and reach the other tools through `tools.<name>(args)`. [Codemode](codemode.md) describes the script API, how tools are listed and found, the `store()` and `models` globals, and the limits.

### Tool search

`tool_search` is off by default; enable it with `"defaultTools": ["+tool_search"]` or `--tools`. It uses the same ranking as `searchTools()` over tools that are not declared yet and declares the matches for the next model call. Loaded tools are recorded in the session like other tool changes, so they stay declared on that branch.

<a id="resource-options"></a>

## Resources

```sh
pi --extension ./review.ts
```

See [Configuration](configuration.md) for conventional directories and project trust, [Settings](settings.md#resources) for configured paths, and [Pi Packages](packages.md) for package sources.

- `-e`, `--extension <path>`<br>
  Loads an extension file or directory, or a built-in extension such as `builtin:mcp`, and is repeatable.
- `-ne`, `--no-extensions`<br>
  Disables discovered, configured, and built-in extensions. Explicit `-e` paths still load, so `pi -ne -e builtin:mcp` keeps only the built-in MCP support.
- `--strict-extensions`<br>
  An `-e` source that loads no extension stops the start with the error, instead of a warning (or nothing) and a session without it: a package (`npm:`, `git:`) that fails to install, one skipped in offline mode, a directory or package without an extension, or a string that is not a source (such as `github:owner/repo`). A missing `-e` path and an extension that throws while loading stop the start either way. Subagents pass it to a child whose agent has [`extensions`](subagent.md#extensions-as-hooks).
- `--no-mcp`<br>
  Disables the built-in MCP support for this run: no servers connect, and there are no MCP tools or `/mcp`. It does not affect an extension that replaces the built-in MCP support.
- `--skill <path>`<br>
  Loads a skill file or directory and is repeatable.
- `-ns`, `--no-skills`<br>
  Disables discovered and configured skills. Explicit `--skill` paths still load.
- `--prompt-template <path>`<br>
  Loads a prompt-template file or directory and is repeatable.
- `-np`, `--no-prompt-templates`<br>
  Disables discovered and configured templates. Explicit `--prompt-template` paths still load.
- `--theme <path>`<br>
  Loads a theme file or directory and is repeatable.
- `--use-theme <name[/name]>`<br>
  Selects the initial interactive theme for this run.
- `--no-themes`<br>
  Disables discovered and configured themes. Explicit `--theme` paths still load.
- `-nc`, `--no-context-files`<br>
  Disables `AGENTS.md` and `CLAUDE.md` discovery.

Resource paths apply only to the current process. Relative paths resolve from the current working directory.

<a id="prompt-and-display-options"></a>

## Prompts and process

```sh
pi --append-system-prompt ./instructions.md
```

See [Configuration](configuration.md) for saved configuration, [Security](security.md#understand-project-trust) for project trust, and [Environment Variables](environment-variables.md) for process controls.

- `--system-prompt <text|path>`<br>
  Replaces the default system prompt with text or the contents of an existing file.
- `--append-system-prompt <text|path>`<br>
  Appends text or an existing file to the system prompt and is repeatable.
- `--tui-mode <mode>`<br>
  Uses `fullscreen` (default) or `regular` terminal mode.
- `--verbose`<br>
  Shows verbose interactive startup information, overriding `quietStartup`.
- `-a`, `--approve`<br>
  Trusts project-local configuration and resources for this process.
- `-na`, `--no-approve`<br>
  Ignores trust-gated project-local configuration and resources for this process.
- `--offline`<br>
  Disables automatic network activity, including model catalog refreshes. Equivalent to `XPI_OFFLINE=1`.
- `-h`, `--help`<br>
  Shows help, including flags registered by loaded extensions, then exits.
- `-v`, `--version`<br>
  Shows the Pi version, then exits.

Extensions may register additional long-form options. Unknown short options are rejected.

## Package commands

```sh
pi install npm:@scope/package
```

See [Pi Packages](packages.md) for source formats, filtering, installation, and project scope.

### Common tasks

| Task | Command |
|---|---|
| Install a package | `pi install <source>` |
| List configured packages | `pi list` |
| Remove a package and its settings entry | `pi remove <source>` |
| Configure which package resources load | `pi config` |

Add `--local` or `-l` to `install`, `remove`, `uninstall`, or `config` to use project settings instead of global settings.

### Update packages and model catalogs

xpi does not update itself. To get a newer xpi, reinstall it the way it was installed: `npm install -g xpi-coding-agent@latest`,
a newer [release binary](https://github.com/luoxin9510/xin-pi/releases), or a rebuild from source. `pi update` without a
target says so and exits with status 1.

| Task | Command |
|---|---|
| Update all installed packages | `pi update --extensions` |
| Update one installed package | `pi update <source>` |
| Refresh model catalogs | `pi update --models` |
| Update all installed packages (and repeat the note about xpi itself) | `pi update --all` |

The `XPI_SELF_UPDATE_COMMAND` variable and the `selfUpdateCommand` setting of upstream pi have no effect.

### Aliases and command options

- `pi uninstall <source>` is an alias for `pi remove <source>`.
- `pi update --self`, `pi update self`, and `pi update pi` are aliases for `pi update`: they explain how to get a newer xpi.
- `pi update --extension <source>` is an alias for `pi update <source>`.
- `-a`, `--approve` trusts project-local files for one command. `-na`, `--no-approve` ignores trust-gated project-local files.
- Append `-h` or `--help` to a command for its exact usage and option constraints.

## Credential commands

`pi auth login <provider>` logs in to a provider in the terminal and exits, without starting a session. It signs in with an account and opens the browser, like `/login <provider>`. Providers without account sign-in ask for an API key. Logging in to Radius also adds the Radius MCP server to `~/.pi/agent/mcp.json` when no global server uses that login yet. It requires an interactive terminal.

| Option | Description |
|---|---|
| `--api-key` | Save an API key instead of signing in with an account; the key is read without echoing it |
| `--no-browser` | Do not open a browser; use the provider's other sign-in method, such as a device code, for example over SSH. Asks when there are several. Not allowed with `--api-key` |

`pi auth logout <provider>` removes the credentials that `pi auth login` or `/login` stored, like `/logout`. Environment variables and `models.json` config are unchanged. It exits with status `0` when nothing is stored, so it is safe to repeat.

```sh
pi auth login radius
pi auth logout radius
pi auth check --provider openai --json
```

The other authentication commands require `--provider <provider>` or `--model <model>`. See [Providers](providers.md) for supported methods.

| Command | Description |
|---|---|
| `pi auth check` | Print `ready`, `not_ready`, or `invalid`; exit with status `0`, `1`, or `2`, respectively |
| `pi auth print-api-key` | Print the resolved API key |
| `pi auth print-bearer-token` | Print a resolved OAuth bearer token |

| Option | Applies to | Description |
|---|---|---|
| `--provider <provider>` | All | Resolve credentials for a provider |
| `--model <model>` | All | Resolve credentials from a model; may be combined with `--provider` |
| `--json` | `auth check` | Write the structured result as JSON |
| `--credentials` | `auth check` | Emit the resolved credential when ready |
| `--no-refresh` | `auth check` | Do not refresh expired OAuth credentials; refresh is the default |
| `--min-expiry <duration>` | `print-bearer-token` | Require remaining token lifetime using `ms`, `s`, `m`, or `h`, such as `30m` |

Credential-printing commands write secrets to stdout.

## MCP commands

These commands work outside a session, so agents can run them through `bash`. See [MCP Servers](mcp.md).

| Command | Description |
|---|---|
| `pi mcp add <server> [options] -- <command> [args...]` | Add or replace a stdio server in `mcp.json`; `--env KEY=VALUE` (repeatable) and `--cwd <dir>` set its environment and working directory. Arguments after the command are passed to it |
| `pi mcp add <server> [options] --url <url>` | Add or replace a streamable HTTP server; `--header KEY=VALUE` (repeatable), `--bearer-token-env-var <NAME>` (sends `Authorization: Bearer ${NAME}`), `--oauth-client-id`, `--oauth-client-secret`, `--oauth-callback-port`, `--oauth-client-name`, and `--oauth-client-registration` (`auto`, `cimd`, or `dcr`) configure authentication |
| `pi mcp remove <server>` | Remove a server from `mcp.json`; stored OAuth credentials are kept |
| `pi mcp list [--json]` | Connect to every enabled server and print its state, tools, and errors; exit with `1` when a config entry is invalid or an enabled server is not connected |
| `pi mcp login <server> [-l] [--timeout <seconds>]` | Sign in to an OAuth server: open the authorization page and wait for the browser; a terminal also accepts the pasted redirect URL. `--timeout` limits the whole sign-in, including requests to the authorization server (default 300 seconds). `-l` requires the server to be defined in the project's `.pi/mcp.json` |
| `pi mcp logout <server> [-l]` | Delete the stored OAuth credentials of a server |

`add` and `remove` change `~/.pi/agent/mcp.json`, or `.pi/mcp.json` in the current directory with `--local` (`-l`). `add` also takes `--exposure <mode>` (see [Exposure](mcp.md#control-tool-exposure)) and `--description <text>` and does not connect; run `pi mcp list` to check the server.

Project `.pi/mcp.json` files are only read for projects that are already trusted.

## Background session commands

`xpi roost` lists and controls background sessions: xpi sessions that a per-agent-directory daemon runs in
pseudo-terminals, so they keep running after the terminal that started them closes. `xpi --bg "<task>"` starts one; see
[Background Sessions](roost.md). The hub and `/bg` come later.

| Command | Description |
|---|---|
| `xpi roost ls [--all] [--cwd <dir>] [--json]` | List sessions (also `list`). Ended sessions older than 48 hours are shown with `--all`; `--cwd` keeps the sessions of one directory; `--json` prints the rows for programs |
| `xpi roost attach <id\|name>` | Open a session in this terminal. The `app.suspend` key (default `ctrl+z`, see [Keybindings](keybindings.md)) detaches and leaves it running. An ended session is started again first; one that failed is told to continue where it left off. Needs a terminal |
| `xpi roost logs <id\|name>` | Print the session's current screen, or its last one when it has ended |
| `xpi roost log [-n <count>] [--follow] [<id\|name>]` | What happened lately (started, finished, stopped, ...), oldest first; `--follow` keeps printing |
| `xpi roost reply <id\|name> <text>` | Send a reply to an xpi session; queued as a follow-up while it works. Exits with `1` when it was not delivered |
| `xpi roost stop <id\|name>` | Stop the session; its record stays |
| `xpi roost rm <id\|name>` | Stop it and delete its record |
| `xpi roost respawn <id\|name>` | Start an ended session again, or restart a live one |
| `xpi roost respawn --all` | Restart every live and reaped session, for example after an upgrade |
| `xpi roost daemon status` | The daemon's pid, version, socket directory and whether it can load node-pty; does not start a daemon |
| `xpi roost daemon logs` | Print the daemon's log |
| `xpi roost daemon stop [--keep-workers]` | Stop the daemon and its sessions; with `--keep-workers` the sessions keep running and the next daemon takes them over |

The commands outside `daemon` start the agent directory's daemon when it is not running; `daemon ...` never starts one. A session is named by its id, a
unique id prefix or its name. An unknown command exits with `2`; `xpi roost hub` says the hub is not in this version yet.

After an upgrade the running daemon still has the old code, and every command warns about it until it is restarted:
run `xpi roost daemon stop --keep-workers`, then `xpi roost respawn --all`.

Requirements:

- macOS or Linux. On Windows the commands exit with a message (use WSL).
- The npm installation of xpi. A standalone binary has no Node runtime for the daemon and says to install xpi with
  `npm install -g xpi-coding-agent`.
- node-pty, an optional dependency installed with xpi, for each session's process. When it is missing
  (`--omit=optional`, `--ignore-scripts`, or a failed compile on Linux, which needs python3, make and a C++ compiler),
  `respawn` and `attach` to a session that is not running say how to reinstall it. The other commands still work, so
  the sessions a running daemon already has can be listed, read, replied to, attached to and stopped; they warn when
  the daemon itself cannot load node-pty.

Each agent directory has its own daemon, state (`<agent dir>/xpi-roost/`) and sockets. The `roost` block of
`settings.json` configures it; see [Settings](settings.md#background-sessions).
