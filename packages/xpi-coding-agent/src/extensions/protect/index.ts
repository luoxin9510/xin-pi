// protect extension entry: blocks file tools from reading secrets and from writing protected paths. Patterns are
// gitignore patterns from the `protect` settings, after the defaults below. A backstop against mistakes, not a sandbox:
// `bash` and codemode `exec` commands are not parsed. `/protect off` and `/protect on` switch it for this session.

import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { SETTINGS_DEFAULTS } from "../../core/settings-defaults.ts";
import { type ProtectLevel, type ProtectRules, protectLevel, validEntries } from "./match.ts";

const SCHEME = /^@?[a-z][a-z0-9+.-]*:\/\//i;

/** The effective lists: defaults, then the user's entries, then the project's (the settings layers arrive concatenated). */
function readRules(pi: ExtensionAPI): ProtectRules {
	const settings = pi.getSettings().protect;
	const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
	return {
		secret: [...SETTINGS_DEFAULTS.protect.secret, ...list(settings?.secret)],
		readOnly: [...SETTINGS_DEFAULTS.protect.readOnly, ...list(settings?.readOnly)],
	};
}

function reasonFor(path: string, level: ProtectLevel): string {
	return level === "secret"
		? `\`${path}\` is protected (secret): it cannot be read or written. If it is needed, ask the user.`
		: `\`${path}\` is protected (read-only): it cannot be written. If a change is needed, ask the user.`;
}

export default function protect(pi: ExtensionAPI) {
	// In memory, for this session only: a new or resumed session starts on.
	let enabled = true;
	let warnedBadEntries = false;

	function say(ctx: ExtensionContext, message: string, level: "info" | "warning" = "info"): void {
		const text = `protect: ${message}`;
		if (ctx.hasUI) ctx.ui.notify(text, level);
		else if (level === "info") console.log(text);
		else console.error(text);
	}

	pi.on("session_start", () => {
		enabled = true;
		warnedBadEntries = false;
	});

	pi.on("tool_call", (event, ctx) => {
		if (!enabled) return undefined;
		if (event.effect !== "read" && event.effect !== "write") return undefined;
		const path = (event.input as Record<string, unknown>).path;
		if (typeof path !== "string" || path === "" || SCHEME.test(path)) return undefined;
		const rules = readRules(pi);
		if (!warnedBadEntries) {
			const lists = pi.getSettings().protect;
			const notLists = [lists?.secret, lists?.readOnly].filter(
				(value) => value !== undefined && !Array.isArray(value),
			).length;
			const skipped = validEntries(rules.secret).skipped + validEntries(rules.readOnly).skipped + notLists;
			if (skipped > 0) {
				warnedBadEntries = true;
				say(
					ctx,
					`${skipped} entr${skipped === 1 ? "y" : "ies"} in the protect settings are not strings (or a list is not an array) and are skipped`,
					"warning",
				);
			}
		}
		const level = protectLevel(rules, path, ctx.cwd);
		if (level === undefined) return undefined;
		if (event.effect === "read" && level !== "secret") return undefined;
		if (ctx.hasUI)
			ctx.ui.notify(
				`protect: blocked ${event.effect} of ${path} (${level === "secret" ? "secret" : "read-only"})`,
				"warning",
			);
		return { block: true, reason: reasonFor(path, level) };
	});

	pi.registerCommand("protect", {
		description: "Show the protected paths, or turn the protection off or on for this session [off|on]",
		handler: async (args, ctx) => {
			const word = args.trim();
			if (word === "off" || word === "on") {
				enabled = word === "on";
				say(ctx, `${word} for this session`);
				return;
			}
			if (word !== "") return say(ctx, "usage: /protect [off|on]", "warning");
			const rules = readRules(pi);
			const show = (list: readonly unknown[]) => validEntries(list).entries.join(", ") || "(none)";
			say(
				ctx,
				[
					`${enabled ? "on" : "off"} for this session`,
					`secret (no read, no write): ${show(rules.secret)}`,
					`read-only (no write): ${show(rules.readOnly)}`,
				].join("\n"),
			);
		},
	});
}
