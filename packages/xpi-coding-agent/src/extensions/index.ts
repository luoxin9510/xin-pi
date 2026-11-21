import type { InlineExtension } from "../core/extensions/types.ts";
import checksExtension from "./checks/index.ts";
import codemodeExtension from "./codemode/index.ts";
import commitExtension from "./commit/index.ts";
import graphExtension from "./graph/index.ts";
import llamaExtension from "./llama/index.ts";
import mcpExtension from "./mcp/index.ts";
import protectExtension from "./protect/index.ts";
import relayExtension from "./relay/index.ts";
import roostExtension from "./roost/index.ts";
import shadowGitExtension from "./shadow-git/index.ts";
import subagentExtension from "./subagent/index.ts";
import toolSearchExtension from "./tool-search/index.ts";
import upstreamExtension from "./upstream/index.ts";
import waitExtension from "./wait/index.ts";

export const builtInExtensions: InlineExtension[] = [
	// First: its `session_start` sets GIT_DIR and GIT_WORK_TREE, and the `session_start` of the extensions after it (mcp
	// starts servers, codemode and subagents start children) must already see them. Handlers run in this order. It acts
	// only when the session's cwd is in a registered shadow-git workspace or XPI_SG_SANDBOX is set. Not replaceable.
	// Disable it with `-builtin:shadow-git`.
	{ name: "shadow-git", factory: shadowGitExtension, builtin: true },
	{ name: "llama.cpp", factory: llamaExtension, builtin: true },
	// Replaceable: an extension that registers `codemode`, `tool_search`, or `/mcp` (such as a third-party
	// MCP extension) takes over instead of running alongside the built-in one.
	{ name: "codemode", factory: codemodeExtension, replaceable: true, builtin: true },
	{ name: "tool-search", factory: toolSearchExtension, replaceable: true, builtin: true },
	{ name: "mcp", factory: mcpExtension, replaceable: true, builtin: true },
	// Not replaceable: subagent must never be silently dropped. Disable it with `-builtin:subagent`.
	{ name: "subagent", factory: subagentExtension, builtin: true },
	// Not replaceable. Disable it with `-builtin:relay`.
	{ name: "relay", factory: relayExtension, builtin: true },
	// Not replaceable. Waits that do not hold a process (`tools.wait`, `/wait`). Before graph: graph reads the wait it
	// writes at the end of a run. Disable it with `-builtin:wait`.
	{ name: "wait", factory: waitExtension, builtin: true },
	// Not replaceable. Flow control by a graph (`/graph`, the `graph/auto` model). It does nothing until `/graph start`.
	// Disable it with `-builtin:graph`.
	{ name: "graph", factory: graphExtension, builtin: true },
	// Not replaceable. Disable it with `-builtin:upstream`.
	{ name: "upstream", factory: upstreamExtension, builtin: true },
	// Not replaceable. Disable it with `-builtin:commit`.
	{ name: "commit", factory: commitExtension, builtin: true },
	// Not replaceable. Runs the `checks.commands` settings after a turn that changed something. Off without commands.
	// Disable it with `-builtin:checks`.
	{ name: "checks", factory: checksExtension, builtin: true },
	// Not replaceable. Blocks the file tools from reading secrets and writing protected paths (the `protect` settings).
	// On by default. Disable it with `-builtin:protect`.
	{ name: "protect", factory: protectExtension, builtin: true },
	// Not replaceable. Background sessions (xpi roost): the session write lock, `--bg`, the worker role in a session the
	// daemon runs. Disable it with `-builtin:roost`.
	{ name: "roost", factory: roostExtension, builtin: true },
];
