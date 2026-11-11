import type { InlineExtension } from "../core/extensions/types.ts";
import codemodeExtension from "./codemode/index.ts";
import commitExtension from "./commit/index.ts";
import llamaExtension from "./llama/index.ts";
import mcpExtension from "./mcp/index.ts";
import relayExtension from "./relay/index.ts";
import roostExtension from "./roost/index.ts";
import subagentExtension from "./subagent/index.ts";
import toolSearchExtension from "./tool-search/index.ts";
import upstreamExtension from "./upstream/index.ts";

export const builtInExtensions: InlineExtension[] = [
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
	// Not replaceable. Disable it with `-builtin:upstream`.
	{ name: "upstream", factory: upstreamExtension, builtin: true },
	// Not replaceable. Disable it with `-builtin:commit`.
	{ name: "commit", factory: commitExtension, builtin: true },
	// Not replaceable. Background sessions (xpi roost): the session write lock, `--bg`, the worker role in a session the
	// daemon runs. Disable it with `-builtin:roost`.
	{ name: "roost", factory: roostExtension, builtin: true },
];
