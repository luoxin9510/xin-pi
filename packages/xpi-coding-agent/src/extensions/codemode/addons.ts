/**
 * Script add-ons: what an extension adds to every codemode script, built on the tools the script can already call.
 * An add-on has a prelude (JavaScript run before the script, on its first line, so the script's line numbers do not
 * change) and host globals the prelude may use (functions cannot cross into the sandbox, so helpers that take
 * callbacks live in the prelude and call the host through these).
 *
 * `codemodeAddons` is a process-wide singleton, like `codemodeScripts`.
 */

import type { CodemodeTool } from "xpi-codemode";

/** What an add-on's host globals get for one script run. */
export interface CodemodeAddonScript {
	/** The `codemode` tool call id. */
	toolCallId: string;
	/** Call one of the script's tools as `tools.<name>(args)` would: a nested call row, the same value or error. */
	callTool(name: string, args: unknown, signal: AbortSignal): Promise<unknown>;
}

export interface CodemodeAddon {
	/** Unique; registering the same name again replaces the earlier add-on. */
	name: string;
	/** Whether a script with these callable tools gets the add-on. */
	applies(toolNames: readonly string[]): boolean;
	/** One line of JavaScript (no line break). It runs in the script's scope before the script. */
	prelude: string;
	/** Host globals for one script run. Their names must not clash with other globals. */
	globals?(script: CodemodeAddonScript): CodemodeTool[];
}

const addons = new Map<string, CodemodeAddon>();

export const codemodeAddons = {
	/** Add (or replace) an add-on. Returns the disposer, which removes it if it is still the registered one. */
	register(addon: CodemodeAddon): () => void {
		if (addon.prelude.includes("\n")) throw new Error(`codemode add-on ${addon.name}: the prelude must be one line`);
		addons.set(addon.name, addon);
		return () => {
			if (addons.get(addon.name) === addon) addons.delete(addon.name);
		};
	},
	/** The add-ons a script with these callable tools gets. */
	for(toolNames: readonly string[]): CodemodeAddon[] {
		return [...addons.values()].filter((addon) => addon.applies(toolNames));
	},
};
