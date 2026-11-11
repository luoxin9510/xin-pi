/**
 * T17: `/agents`, the hub inside an xpi session (`ctx.ui.custom`), over the conversation when the `fullscreen` setting
 * is on (the default) or in place of the editor. Loaded only when it opens, with xpi-tui's hub (`xpi-roost/hub`).
 */

import { AgentView, setJobEventBus } from "xpi-roost/hub";
import { getAgentDir } from "../../config.ts";
import type { ExtensionContext } from "../../core/extensions/types.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { hubOptions } from "./hub-options.ts";
import { roostSettings } from "./settings.ts";
import { viewOpened } from "./view-state.ts";

export interface OpenViewOptions {
	/** This xpi's slash commands (DI-5: skills and prompt templates become first prompts). */
	commands?: () => { name: string; source: string }[];
	/** BG-5: the session just handed over: Esc goes back into it, its row stays bold. */
	origin?: string;
	/** Shown above the list until the user returns to the origin. */
	banner?: string;
	/** NT-2: where a session that needs input or finished is announced (`pi.events`). */
	events?: { emit(channel: string, data: unknown): void };
}

// covers the conversation; percentages follow terminal resizes
const FULLSCREEN = { width: "100%", maxHeight: "100%", row: 0, col: 0 } as const;

/** Show the hub until the user leaves it. */
export async function openAgentView(ctx: ExtensionContext, opts: OpenViewOptions = {}): Promise<void> {
	if (!ctx.hasUI) return;
	const agentDir = getAgentDir();
	let trusted: boolean | undefined;
	try {
		trusted = ctx.isProjectTrusted();
	} catch {
		trusted = undefined;
	}
	const config = roostSettings(SettingsManager.create(ctx.cwd, agentDir, { projectTrusted: trusted ?? false }));
	const options = hubOptions({
		cwd: ctx.cwd,
		agentDir,
		argv: process.argv,
		...(trusted !== undefined ? { projectTrusted: trusted } : {}),
		commands: () => opts.commands?.() ?? [],
		models: () => {
			try {
				return ctx.modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`);
			} catch {
				return [];
			}
		},
		scopedModels: () => {
			try {
				return ctx.scopedModels.map((m) => `${m.model.provider}/${m.model.id}`);
			} catch {
				return [];
			}
		},
		currentSession: () => {
			try {
				return ctx.sessionManager.getSessionFile();
			} catch {
				return undefined;
			}
		},
		sessionDir: () => {
			try {
				return ctx.sessionManager.getSessionDir();
			} catch {
				return undefined;
			}
		},
	});
	if (opts.events) setJobEventBus(opts.events);
	const closed = viewOpened();
	try {
		await ctx.ui.custom<void>(
			(tui, theme, _keybindings, done) => {
				const view = new AgentView({
					tui,
					theme,
					...options,
					...(opts.origin ? { origin: opts.origin, highlightId: opts.origin } : {}),
					...(opts.banner ? { banner: opts.banner } : {}),
					setTitle: (title) => ctx.ui.setTitle(title),
					done: () => done(),
				});
				void view.start();
				return view;
			},
			config.fullscreen ? { overlay: true, overlayOptions: FULLSCREEN } : undefined,
		);
	} finally {
		closed();
	}
}
