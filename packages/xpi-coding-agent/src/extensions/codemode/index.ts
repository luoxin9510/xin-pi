/**
 * The `codemode` tool as an extension. The CLI loads it as a built-in extension; SDK users
 * add `createCodemodeExtension()` to their extension factories.
 *
 * `codemode` is one of the default tools (`DEFAULT_TOOL_NAMES`), so it is active unless `--tools`, the
 * `defaultTools` setting or `setActiveTools()` leave it out; the MCP extension activates it again when MCP tools
 * are only reachable from scripts. `defaultActive: false` keeps it from activating on registration in a session
 * whose tool selection does not name it.
 */

import type { ExtensionAPI, ExtensionFactory } from "../../core/extensions/types.ts";
import { SETTINGS_DEFAULTS } from "../../core/settings-defaults.ts";
import type { CodemodeMode } from "../../core/settings-manager.ts";
import { createCodemodeToolDefinition } from "./tool.ts";

export interface CodemodeExtensionOptions {
	/** Overrides the `codemode.mode` setting. */
	mode?: CodemodeMode;
	/** Overrides the `codemode.inlineBudget` setting. */
	inlineBudget?: number;
	/** Expose the model catalog and classifiers to scripts as `models`. Default: `true`. */
	models?: boolean;
}

function readMode(pi: ExtensionAPI): CodemodeMode {
	return pi.getSettings().codemode?.mode === "only" ? "only" : SETTINGS_DEFAULTS.codemode.mode;
}

function readInlineBudget(pi: ExtensionAPI): number | undefined {
	const budget = pi.getSettings().codemode?.inlineBudget;
	return typeof budget === "number" && Number.isFinite(budget) && budget >= 0 ? budget : undefined;
}

export function createCodemodeExtension(options: CodemodeExtensionOptions = {}): ExtensionFactory {
	return (pi) => {
		// Add-ons describe themselves per session (`describe(sessionId)`); the loadout has no session id, so it is kept here.
		let sessionId: string | undefined;
		pi.on("session_start", (_event, ctx) => {
			sessionId = ctx.sessionManager.getSessionId();
		});
		pi.registerTool({
			...createCodemodeToolDefinition({
				appendEntry: (customType, data) => pi.appendEntry(customType, data),
				models: options.models ?? true,
				getToolNamespace: (name) => pi.getAllTools().find((tool) => tool.name === name)?.namespace,
				getToolGuidelines: () =>
					new Map(pi.getAllTools().map((tool) => [tool.name, tool.promptGuidelines ?? []] as const)),
				getMode: () => options.mode ?? readMode(pi),
				getInlineBudget: () => options.inlineBudget ?? readInlineBudget(pi),
				getSessionId: () => sessionId,
			}),
			defaultActive: false,
		});
	};
}

export default createCodemodeExtension();
