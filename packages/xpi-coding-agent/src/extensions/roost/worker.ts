/**
 * The worker role (T15): what a session the daemon started does besides being an ordinary xpi session. Loaded only in
 * such a session (`isRoostSession`). It reports its state (working, waiting, a dialog, its context use, model and
 * thinking level), takes the replies the hub and `xpi roost reply` send (steer or follow-up, acked once handed to xpi),
 * writes its slash-command list for the hub's peek, loads the conversation from before the latest compaction (M53),
 * shows a recap on attach, and turns the keys that would end or freeze it into a detach.
 *
 * Not ported (decision 6): the repaint on attach (M14), automatic naming and anything of the summary model, `handback`,
 * peers and agent items, the `roost_*` agent tools, the subagent panel, the transcript view, the concierge role,
 * pi-mobile, pull request links and `/tasks`.
 */

import { dirname, join } from "node:path";
import {
	type ContextInfo,
	CUSTOM_DIALOG_MS,
	type DeliverItem,
	FIRST_PROMPT_MS,
	hostControl,
	JOB_ENV,
	type JobIdentity,
	jobIdentity,
	PROTOCOL_VERSION,
	Reporter,
	ROOST_BUILD,
	sessionUsage,
	type UsageInfo,
	WorkerTracker,
	writeCommands,
} from "xpi-roost";
import { getKeybindings } from "xpi-tui";
import { VERSION } from "../../config.ts";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { detachKeyHandler } from "./detach-keys.ts";
import { registerEarlierHistory } from "./earlier-history.ts";
import { registerRecap, sigusr2Handled } from "./recap.ts";

const RETRY_MS = 500;
const START_WAIT_MS = 10_000;
const THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** What a reply queue needs of the session; the worker gives it the live ones. */
export interface ReplyQueueEnv {
	ctx: () => ExtensionContext | undefined;
	running: () => boolean;
	dialogOpen: () => boolean;
	ack: (seq: number) => void;
}

/**
 * Replies from the hub and `xpi roost reply`, handed to xpi one at a time (PK-2, PK-4). A prompt sent while idle starts
 * a run asynchronously; the next reply waits for that run to start and then joins it as a follow-up, because a second
 * prompt before streaming begins would be rejected. A reply is acked once xpi has it (an unacked one is sent again).
 */
export class ReplyQueue {
	private queue: DeliverItem[] = [];
	private lastSeq = 0;
	private awaitingStart = 0;
	private timer: NodeJS.Timeout | undefined;
	private readonly pi: ExtensionAPI;
	private readonly env: ReplyQueueEnv;

	constructor(pi: ExtensionAPI, env: ReplyQueueEnv) {
		this.pi = pi;
		this.env = env;
	}

	add(item: DeliverItem): void {
		const { seq } = item;
		if (seq <= this.lastSeq || this.queue.some((q) => q.seq === seq)) {
			// a resend (the ack was lost): ack it again
			if (seq <= this.lastSeq) this.env.ack(seq);
			return;
		}
		this.queue.push(item);
		this.queue.sort((a, b) => a.seq - b.seq);
		this.pump();
	}

	pump(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
		const ctx = this.env.ctx();
		while (ctx && this.queue.length > 0) {
			const next = this.queue[0]!;
			if (this.applySetting(ctx, next.text)) {
				this.done(next.seq);
				continue;
			}
			if (this.env.dialogOpen()) return; // resumed by ui_prompt_end
			const running = this.env.running();
			if (running) this.awaitingStart = 0;
			if (this.awaitingStart && Date.now() - this.awaitingStart < START_WAIT_MS) {
				this.retry();
				return;
			}
			if (running) {
				// M28: as xpi's Enter (steer) or Alt+Enter (follow-up) while it works
				void this.pi.sendUserMessage(next.text, {
					deliverAs: next.mode === "steer" ? "steer" : "followUp",
					expandPromptTemplates: true,
				});
			} else if (ctx.isIdle()) {
				void this.pi.sendUserMessage(next.text, { expandPromptTemplates: true });
				this.awaitingStart = Date.now();
			} else {
				this.retry(); // compacting: prompts are refused until it ends
				return;
			}
			this.done(next.seq);
		}
	}

	private done(seq: number): void {
		this.queue.shift();
		this.lastSeq = Math.max(this.lastSeq, seq);
		this.env.ack(seq);
	}

	private retry(): void {
		this.timer = setTimeout(() => this.pump(), RETRY_MS);
		this.timer.unref?.();
	}

	/** /name, /compact, /thinking and /model run at once; true when the text was one of them. */
	private applySetting(ctx: ExtensionContext, text: string): boolean {
		const [cmd, ...rest] = text.split(/\s+/);
		const arg = rest.join(" ").trim();
		const warn = (m: string) => {
			try {
				ctx.ui.notify(`xpi roost: ${m}`, "warning");
			} catch {
				// a stale ctx (the session switched while setModel ran): nobody to tell
			}
		};
		if (cmd === "/name") {
			if (arg) this.pi.setSessionName(arg);
			else warn("/name needs a name");
			return true;
		}
		if (cmd === "/compact") {
			// M48: /compact from a peek: xpi's own compaction, started here, not awaited
			try {
				ctx.compact();
			} catch (err) {
				warn(`cannot compact: ${String(err)}`);
			}
			return true;
		}
		if (cmd === "/thinking") {
			if (THINKING.has(arg)) this.pi.setThinkingLevel(arg as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
			else warn(`/thinking needs one of ${[...THINKING].join(", ")}`);
			return true;
		}
		if (cmd === "/model") {
			const slash = arg.indexOf("/");
			const model = slash > 0 ? ctx.modelRegistry.find(arg.slice(0, slash), arg.slice(slash + 1)) : undefined;
			if (!model) warn(`unknown model "${arg}" (use provider/id)`);
			// false (or a throw) when this process has no credentials for it; the hub sees the row keep its old model
			else {
				void this.pi
					.setModel(model)
					.then((ok) => {
						if (ok === false)
							warn(`cannot switch to ${arg}: no credentials for ${model.provider} in this session`);
					})
					.catch((err: unknown) => warn(`cannot switch model: ${String(err)}`));
			}
			return true;
		}
		return false;
	}
}

/** M24: the session's usage as xpi's footer counts it; a subscription marks it notional. */
export function usageOf(ctx: ExtensionContext, now = Date.now()): UsageInfo | null {
	try {
		const m = ctx.model;
		const provider = m
			? (ctx.modelRegistry.getProvider(m.provider) as
					| { auth?: { oauth?: { isSubscription?: boolean } } }
					| undefined)
			: undefined;
		// as xpi's footer: OAuth to a provider that marks its OAuth a subscription
		const sub = m
			? m.provider === "kimi-coding" ||
				(ctx.modelRegistry.isUsingOAuth(m) && provider?.auth?.oauth?.isSubscription === true)
			: false;
		return sessionUsage(ctx.sessionManager.getEntries(), now, sub);
	} catch {
		return null; // a stale ctx after a session switch
	}
}

/** M8: the context window in use, for the row; null when the model has no known window. */
export function contextOf(ctx: ExtensionContext): ContextInfo | null {
	try {
		const u = ctx.getContextUsage();
		if (!u || !(u.contextWindow > 0)) return null;
		const tokens = typeof u.tokens === "number" ? Math.round(u.tokens) : null;
		const percent = typeof u.percent === "number" ? Math.round(u.percent * 10) / 10 : null;
		return { tokens, window: u.contextWindow, percent };
	} catch {
		return null; // a stale ctx after a session switch
	}
}

function thinkingOf(pi: ExtensionAPI): string | null {
	try {
		return pi.getThinkingLevel() ?? null;
	} catch {
		return null;
	}
}

function lastAssistant(
	ctx: ExtensionContext,
): { content?: unknown; stopReason?: string; errorMessage?: string } | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const e = branch[i]!;
		if (e.type === "message" && e.message.role === "assistant") return e.message as never;
	}
	return undefined;
}

export interface WorkerOptions {
	/** The job (tests); otherwise read from the environment the host set. */
	job?: JobIdentity;
	/** Row text and context use alone go out at most this often (tests shorten it). */
	reportIntervalMs?: number;
	/** Detach the attached terminal (tests); otherwise the host is asked to. */
	detach?: () => void;
}

/** The worker role in a session the daemon started. Returns false when this process has no job identity. */
export function registerWorker(pi: ExtensionAPI, opts: WorkerOptions = {}): boolean {
	const job = opts.job ?? jobIdentity();
	if (!job) return false;
	// Commands the agent runs do not inherit the token (same-user processes can still read it from the job's files: a
	// guard against accidents, not a boundary). jobIdentity() keeps it for a /reload.
	delete process.env[JOB_ENV.token];

	const tracker = new WorkerTracker();
	let reporter: Reporter | undefined;
	let firstPromptTimer: NodeJS.Timeout | undefined;
	let customTimer: NodeJS.Timeout | undefined;
	let customPending = false;
	let stopKeys: (() => void) | undefined;
	let current: ExtensionContext | undefined;
	let dialogOpen = 0;
	const replies = new ReplyQueue(pi, {
		ctx: () => current,
		running: () => tracker.isRunning(),
		dialogOpen: () => dialogOpen > 0,
		ack: (seq) => reporter?.ack(seq),
	});
	// attachSignal: the host sends SIGUSR2 on attach and detach only to a session that handles it (decision 11)
	const send = (urgent = false) => reporter?.update({ ...tracker.report(), attachSignal: sigusr2Handled() }, urgent);
	const detach =
		opts.detach ??
		(() => {
			// the host's socket is next to the daemon's this session reports to
			void hostControl(join(dirname(job.socket), `host-${job.id}.sock`), "detach").catch(() => {});
		});

	pi.on("session_start", (event, ctx) => {
		current = ctx;
		dialogOpen = 0;
		stopKeys?.();
		stopKeys = ctx.hasUI
			? ctx.ui.onTerminalInput(
					detachKeyHandler({
						keybindings: () => getKeybindings(),
						detach,
						dialogOpen: () => dialogOpen > 0,
						editorText: () => ctx.ui.getEditorText(),
						setEditorText: (text) => ctx.ui.setEditorText(text),
						notify: (message) => ctx.ui.notify(message, "info"),
					}),
				)
			: undefined;
		// M31: xpi says what it can do, as any agent does
		reporter = new Reporter(job, (item) => replies.add(item), opts.reportIntervalMs, {
			protocol: PROTOCOL_VERSION,
			agent: { name: "xpi", version: VERSION, ...(ROOST_BUILD ? { build: ROOST_BUILD } : {}) },
			capabilities: ["report", "replies", "steer", "usage", "context", "model-switch", "transcript"],
		});
		// M61: the session's slash commands, for the hub's peek menu (never breaks the worker)
		try {
			writeCommands(job.id, pi.getCommands());
		} catch {}
		tracker.start({
			name: ctx.sessionManager.getSessionName() ?? null,
			model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
			thinking: thinkingOf(pi),
			context: contextOf(ctx),
			// a reload keeps the run going; any other start is a different conversation
			fresh: event.reason !== "reload",
		});
		// respawned without a prompt (reaped, restarted, replied to): no turn will start
		if (event.reason === "startup" && process.env.ROOST_RESTORE === "1") tracker.restore(lastAssistant(ctx));
		tracker.setUsage(usageOf(ctx)); // M24: what it spent before this start
		send();
		clearTimeout(firstPromptTimer);
		firstPromptTimer = setTimeout(() => {
			tracker.firstPromptTimeout(ctx.sessionManager.getBranch().filter((e) => e.type === "message").length);
			send();
		}, FIRST_PROMPT_MS);
		firstPromptTimer.unref?.();
	});

	pi.on("agent_start", () => {
		tracker.agentStart();
		send();
		replies.pump();
	});
	pi.on("tool_execution_start", (event, ctx) => {
		if (event.parentToolCallId) return;
		tracker.toolStart(event.toolName);
		// the tool call's message is saved by now
		tracker.setContext(contextOf(ctx));
		send();
	});
	pi.on("tool_execution_end", (event) => {
		if (event.parentToolCallId) return;
		tracker.toolEnd();
		send();
	});
	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		tracker.assistantMessage(event.message);
		send();
		// xpi saves the message after its message_end handlers: read the context use once it is in the session, or the
		// share is one model request behind
		setImmediate(() => {
			const a = tracker.setContext(contextOf(ctx));
			const b = tracker.setUsage(usageOf(ctx)); // M24
			if (a || b) send();
		});
	});
	pi.on("agent_settled", (event, ctx) => {
		tracker.agentSettled(event.aborted);
		tracker.setContext(contextOf(ctx));
		send();
		replies.pump();
	});
	pi.on("ui_prompt_start", (event) => {
		dialogOpen++;
		clearTimeout(customTimer);
		if (event.kind !== "custom") {
			tracker.dialogStart(event.kind, event.title);
			send();
			return;
		}
		// custom() is also used for non-blocking widgets: count it only once it lingers (R6)
		customPending = true;
		customTimer = setTimeout(() => {
			customPending = false;
			tracker.dialogStart(event.kind, event.title);
			send();
		}, CUSTOM_DIALOG_MS);
		customTimer.unref?.();
	});
	pi.on("ui_prompt_end", () => {
		dialogOpen = Math.max(0, dialogOpen - 1);
		clearTimeout(customTimer);
		if (customPending)
			customPending = false; // a short custom() was never counted
		else {
			tracker.dialogEnd();
			send();
		}
		if (dialogOpen === 0) replies.pump();
	});
	pi.on("session_info_changed", (event) => {
		tracker.rename(event.name);
		send();
	});
	pi.on("model_select", (event, ctx) => {
		tracker.setModel(`${event.model.provider}/${event.model.id}`);
		// a model with another window changes the share in use; xpi may clamp the thinking level
		tracker.setContext(contextOf(ctx));
		tracker.setThinking(thinkingOf(pi));
		send();
	});
	pi.on("thinking_level_select", (event) => {
		tracker.setThinking(event.level);
		send();
	});
	// a compaction shrinks the context: the row should not keep the old share
	pi.on("session_compact", (_event, ctx) => {
		if (tracker.setContext(contextOf(ctx))) send();
	});
	// /tree moves to another branch, with another context
	pi.on("session_tree", (_event, ctx) => {
		if (tracker.setContext(contextOf(ctx))) send();
	});
	// After the tracker's handlers: xpi runs handlers in registration order, and the recap reads the tracker's view of the
	// same event.
	registerRecap(pi, { report: () => tracker.report(), ctx: () => current });
	// M53: the conversation from before the latest compaction, loaded as the transcript scrolls up
	registerEarlierHistory(pi);

	pi.on("session_shutdown", async () => {
		current = undefined;
		stopKeys?.();
		stopKeys = undefined;
		clearTimeout(firstPromptTimer);
		clearTimeout(customTimer);
		const closing = reporter;
		reporter = undefined;
		await closing?.close();
	});
	return true;
}
