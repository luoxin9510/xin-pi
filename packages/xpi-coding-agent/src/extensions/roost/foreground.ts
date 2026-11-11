/**
 * T19: the foreground role, in an xpi session the daemon does not run (pi-roost's `adapters/pi/foreground.ts`, without
 * peers, agent tools, worktrees, the quit offer, the footer and `defaultToAgentsView`).
 *
 * - `/bg [prompt]` (alias `/background`) hands this conversation to the daemon and opens the hub. A turn that is
 *   running gets up to TOOL_WAIT_MS for its tool to finish (the left arrow again skips the wait), is interrupted, and
 *   picks up again in the background with "Continue where you left off." The session file is left first (its write
 *   lock goes with it) and only then does the daemon start the one new writer.
 * - `/bg-fork [prompt]` copies the conversation into a new background session; this one carries on.
 * - The left arrow on an empty prompt (`leftArrowOpensAgents`, on by default) submits `/bg`: a conversation with
 *   messages moves, an empty one just opens the hub. A fixed key, listed in AGENTS.md's exemptions.
 *
 * Nothing connects to the daemon until one of these is used.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DaemonClient } from "xpi-roost";
import { isScratchSession, scratchDir } from "xpi-roost/session";
import { type Component, isKeyRelease, Key, matchesKey, type TUI } from "xpi-tui";
import { getAgentDir, getRoostEntries } from "../../config.ts";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../../core/extensions/types.ts";
import { SessionManager } from "../../core/session-manager.ts";
import { type Settings, SettingsManager } from "../../core/settings-manager.ts";
import type { HandoffInput } from "./handoff.ts";
import { loadHandoff, loadOpenView } from "./hub.lazy.ts";
import { NO_PTY_MESSAGE, ptyInstalled, roostUnavailable } from "./messages.ts";
import type { OpenViewOptions } from "./open-view.ts";
import { agentViewOpen } from "./view-state.ts";

// Static imports stay light (every foreground session loads this): xpi-roost's client, launch builder and hub load
// when /bg, /bg-fork or the left arrow is used.

export const TOOL_WAIT_MS = 10_000; // BG-2
export const SETTLE_GRACE_MS = 250;
const PENDING_MS = 2_000;
export const CONTINUE = "Continue where you left off.";
const STATUS_KEY = "xpi-roost";
const PROBE_KEY = "xpi-roost-focus";

const noop = () => {};

/** The main prompt editor, told apart from xpi's selectors and extension UIs that take its place. */
export function isPromptEditor(c: Component | null | undefined): boolean {
	const e = c as { getText?: unknown; setText?: unknown; onSubmit?: unknown } | null | undefined;
	return !!e && typeof e.getText === "function" && typeof e.setText === "function" && "onSubmit" in e;
}

/** The focused component: xpi-tui's TUI interface does not declare the getter its implementations have. */
export function focusedOf(tui: TUI | undefined): Component | null | undefined {
	return (tui as (TUI & { getFocusedComponent?: () => Component | null }) | undefined)?.getFocusedComponent?.();
}

/** Run a UI call that may hit a context xpi has already replaced. */
function safely(fn: () => void): void {
	try {
		fn();
	} catch {
		// stale context after a session switch or shutdown
	}
}

/** What every hub this xpi opens gets: its slash commands and its event bus. */
export function hubContext(pi: ExtensionAPI): Pick<OpenViewOptions, "commands" | "events"> {
	return {
		commands: () => pi.getCommands().map((c) => ({ name: c.name, source: c.source })),
		events: pi.events,
	};
}

/** Why roost cannot start a session from here, or undefined. */
export function startProblem(
	o: { platform?: NodeJS.Platform; entries?: ReturnType<typeof getRoostEntries>; ptyFound?: () => boolean } = {},
): string | undefined {
	const entries = "entries" in o ? o.entries : getRoostEntries();
	const problem = roostUnavailable({ platform: o.platform ?? process.platform, entries });
	if (problem) return problem;
	return (o.ptyFound ?? ptyInstalled)() ? undefined : NO_PTY_MESSAGE.replace(/^xpi --bg: /, "");
}

/**
 * `leftArrowOpensAgents` (default on): a project's value over the user's, as xpi-roost merges the `"roost"` section
 * (it is not one of the user-only keys). Read here without loading xpi-roost.
 */
export function leftArrowSetting(s: { getGlobalSettings(): Settings; getProjectSettings(): Settings }): boolean {
	const value = (settings: Settings) => {
		const section = (settings as { roost?: unknown }).roost;
		const v =
			section && typeof section === "object" ? (section as Record<string, unknown>).leftArrowOpensAgents : undefined;
		return typeof v === "boolean" ? v : undefined;
	};
	return value(s.getProjectSettings()) ?? value(s.getGlobalSettings()) ?? true;
}

export interface ForegroundDeps {
	/** Opens the hub (tests). */
	openHub?: (ctx: ExtensionContext, opts?: OpenViewOptions) => Promise<void>;
	/** Why a session cannot be started (tests). */
	problem?: () => string | undefined;
	/** The daemon connection (tests). */
	connect?: () => Promise<Pick<DaemonClient, "request" | "close">>;
}

export function registerForeground(pi: ExtensionAPI, deps: ForegroundDeps = {}): void {
	const openHub = async (ctx: ExtensionContext, opts: OpenViewOptions = {}) => {
		const all = { ...hubContext(pi), ...opts };
		if (deps.openHub) return deps.openHub(ctx, all);
		const { openAgentView } = await loadOpenView();
		return openAgentView(ctx, all);
	};
	const problem = deps.problem ?? (() => startProblem());
	const connect =
		deps.connect ??
		(async () => {
			const { connectRoost } = await loadHandoff();
			return connectRoost();
		});

	let running = false;
	let compacting = false;
	let toolsRunning = 0;
	let dialogs = 0;
	/** Set while a move is under way; `skip` ends the tool wait (BG-2). */
	let moving: { skip: () => void } | undefined;
	/** The left arrow was turned into a submitted /bg that has not reached the command yet. */
	let pendingUntil = 0;
	const settledWaiters = new Set<(aborted: boolean) => void>();
	const toolWaiters = new Set<() => void>();
	let stopKeys: (() => void) | undefined;

	/**
	 * M8: the model and thinking level this xpi runs now, and its answer about the project folder (the session gets
	 * `--approve` or `--no-approve`, so it never waits at the trust question where nobody sees it).
	 */
	const current = (ctx: ExtensionContext): Pick<HandoffInput, "model" | "thinking" | "trusted"> => {
		const out: Pick<HandoffInput, "model" | "thinking" | "trusted"> = {};
		if (ctx.model) out.model = `${ctx.model.provider}/${ctx.model.id}`;
		try {
			out.thinking = pi.getThinkingLevel();
		} catch {
			// no session: leave it to the session file
		}
		const isTrusted = trusted(ctx);
		if (isTrusted !== undefined) out.trusted = isTrusted;
		return out;
	};

	const trusted = (ctx: ExtensionContext): boolean | undefined => {
		try {
			return ctx.isProjectTrusted();
		} catch {
			return undefined;
		}
	};

	pi.on("agent_start", () => {
		running = true;
		compacting = false;
	});
	pi.on("agent_settled", (event) => {
		running = false;
		toolsRunning = 0;
		for (const w of [...settledWaiters]) w(event.aborted);
		for (const w of [...toolWaiters]) w();
	});
	pi.on("tool_execution_start", (event) => {
		if (!event.parentToolCallId) toolsRunning++;
	});
	pi.on("tool_execution_end", (event) => {
		if (event.parentToolCallId) return;
		toolsRunning = Math.max(0, toolsRunning - 1);
		if (toolsRunning === 0) for (const w of [...toolWaiters]) w();
	});
	pi.on("ui_prompt_start", () => {
		dialogs++;
	});
	pi.on("ui_prompt_end", () => {
		dialogs = Math.max(0, dialogs - 1);
	});
	pi.on("session_before_compact", () => {
		compacting = true;
	});
	pi.on("session_compact", () => {
		compacting = false;
	});
	pi.on("session_compact_failed", () => {
		compacting = false;
	});

	pi.on("session_start", (_event, ctx) => {
		dialogs = 0;
		compacting = false;
		pendingUntil = 0;
		stopKeys?.();
		stopKeys = undefined;
		if (!ctx.hasUI || typeof pi.getFlag("bg") === "string") return;
		if (isScratchSession(ctx.sessionManager.getSessionFile(), getAgentDir())) return;
		let leftArrow = true;
		try {
			leftArrow = leftArrowSetting(
				SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: trusted(ctx) ?? false }),
			);
		} catch {
			// unreadable settings: the default
		}
		if (!leftArrow) return;
		// No focus API for extensions: an empty widget below the editor hands over the TUI.
		let tui: TUI | undefined;
		ctx.ui.setWidget(
			PROBE_KEY,
			(t) => {
				tui = t;
				return { render: () => [], invalidate: noop };
			},
			{ placement: "belowEditor" },
		);
		stopKeys = ctx.ui.onTerminalInput((data) => {
			if (isKeyRelease(data) || !matchesKey(data, Key.left)) return undefined;
			if (dialogs > 0) return undefined; // a dialog may open while a tool is awaited
			if (moving) {
				moving.skip(); // BG-2: the left arrow again skips the wait
				return { consume: true };
			}
			if (Date.now() < pendingUntil) return { consume: true };
			if (agentViewOpen() || !isPromptEditor(focusedOf(tui))) return undefined;
			if (ctx.ui.getEditorText().length > 0) return undefined;
			// Only commands get a context that can switch sessions: submit /bg instead.
			ctx.ui.setEditorText("/bg");
			pendingUntil = Date.now() + PENDING_MS;
			return { data: "\r" };
		});
	});
	pi.on("session_shutdown", () => {
		stopKeys?.();
		stopKeys = undefined;
	});

	const handler = async (args: string, ctx: ExtensionCommandContext) => {
		pendingUntil = 0;
		if (moving) return;
		moving = { skip: noop };
		let switched = false;
		try {
			switched = await moveToBackground(ctx, args.trim());
		} finally {
			moving = undefined;
			// after a switch ctx belongs to a runtime that is gone
			if (!switched) safely(() => ctx.ui.setStatus(STATUS_KEY, undefined));
		}
	};
	pi.registerCommand("bg", { description: "Move this conversation to the background [prompt]", handler });
	pi.registerCommand("background", { description: "Move this conversation to the background [prompt]", handler });
	// BG-8: a copy of this conversation works in the background; this one carries on
	// (named bg-fork: xpi's /fork branches from an earlier message)
	pi.registerCommand("bg-fork", {
		description: "Copy this conversation into a background session [prompt]",
		handler: async (args, ctx) => {
			const why = problem();
			if (why) return ctx.ui.notify(why, "error");
			const file = ctx.sessionManager.getSessionFile();
			if (!file || !existsSync(file))
				return ctx.ui.notify("nothing to fork yet: the session has no saved messages", "warning");
			let client: Pick<DaemonClient, "request" | "close"> | undefined;
			try {
				const copy = SessionManager.forkFrom(file, ctx.cwd, dirname(file)).getSessionFile();
				if (!copy) throw new Error("could not create the copy");
				const { conversationName, handoffRequest } = await loadHandoff();
				const request = handoffRequest(ctx, {
					task: args.trim(),
					sessionFile: copy,
					name: `${conversationName(ctx)} (fork)`,
					origin: "fork",
					...current(ctx),
				});
				client = await connect();
				const { id, name } = await client.request("dispatch", request);
				ctx.ui.notify(`session running · ${name} · ${id}: open it from /agents`, "info");
			} catch (err) {
				ctx.ui.notify(`could not fork: ${(err as Error).message}`, "error");
			} finally {
				client?.close();
			}
		},
	});

	/** Returns whether the session was switched (ctx is stale from then on). */
	async function moveToBackground(ctx: ExtensionCommandContext, prompt: string): Promise<boolean> {
		const original = ctx.sessionManager.getSessionFile();
		const refuse = (text: string, level: "info" | "warning" | "error" = "warning") => {
			ctx.ui.notify(text, level);
			return false;
		};
		const why = problem();
		if (why) return refuse(why, "error");
		if (!original) return refuse("this session is not saved (--no-session); nothing to move");
		if (isScratchSession(original, getAgentDir())) return refuse("this is an empty hand-off session", "info");
		if (dialogs > 0) return refuse("answer the open dialog first");
		if (compacting) return refuse("the conversation is being compacted; try again when it is done");

		// xpi writes a session file with its first reply: before that there is nothing to move, and the left arrow
		// simply opens the hub.
		if (!existsSync(original)) {
			if (running) return refuse("wait for the first reply, then move this conversation", "info");
			await openHub(ctx);
			return false;
		}

		let firstPrompt = prompt;
		if (running) {
			let userStopped = false;
			let onSettled: ((aborted: boolean) => void) | undefined;
			const settled = new Promise<void>((resolve) => {
				onSettled = (aborted) => {
					if (aborted) userStopped = true;
					resolve();
				};
				settledWaiters.add(onSettled);
			});
			const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
			try {
				if (toolsRunning > 0) {
					ctx.ui.setStatus(STATUS_KEY, "Moving to the background after the current tool… (← again to skip)");
					let onTool: (() => void) | undefined;
					let timer: NodeJS.Timeout | undefined;
					await new Promise<void>((resolve) => {
						timer = setTimeout(resolve, TOOL_WAIT_MS);
						onTool = resolve;
						toolWaiters.add(onTool);
						moving = { skip: resolve };
					});
					clearTimeout(timer);
					if (onTool) toolWaiters.delete(onTool);
					moving = { skip: noop };
				}
				// A user's Esc ends the tool first and settles the run a moment later: give that a chance to arrive
				// before deciding the turn is still ours to interrupt.
				if (running && !userStopped) await Promise.race([settled, sleep(SETTLE_GRACE_MS)]);
				if (userStopped) return refuse("you stopped the turn; the conversation stays here", "info");
				if (dialogs > 0) return refuse("a dialog opened; answer it first");
				if (running) {
					ctx.abort();
					await Promise.race([settled, ctx.waitForIdle()]);
					// BG-4: an interrupted turn picks up again in the background
					firstPrompt = prompt ? `${CONTINUE}\n\n${prompt}` : CONTINUE;
				}
			} finally {
				if (onSettled) settledWaiters.delete(onSettled);
			}
			// Let xpi finish delivering agent_settled before tearing the session down.
			await ctx.waitForIdle();
			await new Promise((r) => setImmediate(r));
		}

		const { conversationName, handoffRequest } = await loadHandoff();
		const cwd = ctx.cwd;
		// before the switch: ctx is stale after it
		const request = handoffRequest(ctx, {
			task: firstPrompt,
			sessionFile: original,
			name: conversationName(ctx),
			origin: "adopt",
			...current(ctx),
		});
		const scratchRoot = scratchDir(getAgentDir());
		mkdirSync(scratchRoot, { recursive: true, mode: 0o700 });
		const scratch = join(scratchRoot, `${Date.now()}-${process.pid}.jsonl`);

		// C4: leave the file first (its write lock goes with session_shutdown), then let the daemon start the one new
		// writer. The scratch session is never written.
		const result = await ctx.switchSession(scratch, {
			withSession: async (next) => {
				let id: string;
				let client: Pick<DaemonClient, "request" | "close"> | undefined;
				try {
					client = await connect();
					({ id } = await client.request("dispatch", request));
				} catch (err) {
					next.ui.notify(`could not move to the background: ${(err as Error).message}`, "error");
					await next.switchSession(original);
					return;
				} finally {
					client?.close();
				}
				try {
					await openHub(next, { origin: id, banner: "Your conversation moved to the background" });
				} catch (err) {
					next.ui.notify(`the hub failed: ${(err as Error).message}`, "error");
				}
				// Leave the hand-off session for a fresh conversation beside the moved one (newSession would stay in the
				// scratch directory). Written lazily, as usual.
				const fresh = SessionManager.create(cwd, dirname(original)).getSessionFile();
				let left = false;
				try {
					left = !!fresh && !(await next.switchSession(fresh)).cancelled;
				} catch {
					// said below
				}
				// the original belongs to the daemon's session now: say how to get out of the hand-off session
				if (!left) next.ui.notify("could not open a fresh session; use /new", "warning");
			},
		});
		if (result.cancelled) return refuse("another extension cancelled the switch");
		return true;
	}
}
