import {
	type Api,
	CACHE_WARMING_MAX_AGE_MS,
	CACHE_WARMING_MAX_IDLE_AGE_MS,
	CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS,
	type CacheWarmingAction,
	type CacheWarmingDecision,
	type Context,
	evaluateCacheWarming,
	evaluateHeldPrefix,
	getCacheWarmingDelayMs,
	getCacheWarmingRequestOptions,
	getPromptCacheTtlMs,
	isCacheWarmingReplayable,
	type Message,
	type Model,
	type ModelsSimpleStreamOptions,
	type Tool,
} from "xpi-ai";
import type { ModelRuntime } from "./model-runtime.ts";
import type { SessionEntry, SessionManager, UsageEntry } from "./session-manager.ts";
import type { CacheWarmingMode } from "./settings-manager.ts";

export type { CacheWarmingAction, CacheWarmingDecision };

/** The note of the usage entry a held-prefix refresh writes, followed by the key. */
export const HELD_PREFIX_NOTE = "held prefix: ";

/** Prompt size of the most recent real request on the branch, as reported by the provider. */
function lastPromptTokens(entries: SessionEntry[]): number {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type === "message" && entry.message.role === "assistant") {
			const usage = entry.message.usage;
			return usage.input + usage.cacheRead + usage.cacheWrite;
		}
	}
	return 0;
}

/**
 * Fired before each refresh with pi's decision filled in. Everything else an
 * extension might want (model, idle state, context size) is on the context.
 */
export interface CacheWarmingDecisionEvent
	extends Pick<CacheWarmingDecision, "warmCost" | "missCost" | "continuationProbability" | "action"> {
	type: "cache_warming_decision";
	/** Set when the refresh keeps a held prefix warm: the key of the request whose prefix it is. */
	key?: string;
}

export interface CacheWarmingDecisionEventResult {
	/** Override whether this refresh is sent. "stop" ends warming until the next real request. */
	action?: CacheWarmingAction;
}

export interface CacheWarmingStatus {
	/** "scheduled": a refresh timer is armed; "refreshing": a warm request is in flight. */
	state: "inactive" | "scheduled" | "refreshing";
	/** Why nothing is scheduled. */
	reason?: string;
	nextWarmAt?: number;
	/** The pending decision, or the decision that stopped warming. */
	decision?: CacheWarmingDecision;
	/** True when an extension changed `decision.action`. */
	extensionOverride?: boolean;
}

/** The request whose prompt cache entry should be kept warm, exactly as it was sent. */
export interface CacheWarmRequest {
	model: Model<Api>;
	context: Context;
	options: ModelsSimpleStreamOptions;
}

/** A label a virtual model's route puts on a session request (`ModelRoute.cache`). */
export interface CacheRouteLabel {
	key: string;
	holdPrefix?: string;
}

/** The latest session request sent under one key: what a refresh of its prefix repeats. */
interface RememberedRequest {
	model: Model<Api>;
	systemPrompt: string | undefined;
	/**
	 * Every system message of the request, in order: the leading one (the system prompt in sections and the tools it
	 * declares) and the later ones (changes of sections and tools). A model that takes such changes in the middle of a
	 * conversation builds its prefix from the first alone; any other model folds them all into it, so a refresh must
	 * carry them all to build the same prefix.
	 */
	systems: Message[];
	tools: Tool[] | undefined;
	options: ModelsSimpleStreamOptions;
	sentAt: number;
}

/** The prefix of one key kept warm while other requests run. Separate from the ordinary run. */
interface HeldPrefix {
	key: string;
	request: RememberedRequest;
	isCurrent: () => boolean;
	prefixTokens: number;
	ttlMs: number;
	delayMs: number;
	refreshDeadlineAt: number;
	controller: AbortController;
	nextWarmAt: number;
	refreshes: number;
	/** What the refreshes of this hold have cost. */
	spent: number;
	timer?: ReturnType<typeof setTimeout>;
}

/** What `/session` shows of a held prefix. */
export interface HeldPrefixStatus {
	key: string;
	state: "scheduled" | "refreshing";
	nextWarmAt: number;
	refreshes: number;
	cost: number;
}

/** A refresh of a held prefix repeats the prefix with this one short user message. */
const HELD_PREFIX_MESSAGE = ".";

/** Characters per token for the estimate of a prefix's size. */
const CHARS_PER_TOKEN = 4;

function prefixTokensOf(request: RememberedRequest): number {
	// The system messages declare the tools that reach the provider; `tools` alone counts when they do not.
	const declared = request.systems.some((system) => system.role === "system" && system.toolsAdded !== undefined);
	const chars =
		(request.systemPrompt?.length ?? 0) +
		request.systems.reduce((sum, system) => sum + JSON.stringify({ ...system, timestamp: undefined }).length, 0) +
		(!declared && request.tools ? JSON.stringify(request.tools).length : 0);
	return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * The context of a refresh of a prefix: the system prompt, the tools and every system message of the remembered
 * request, then one short user message. A new request, not a replay of the conversation.
 */
export function heldPrefixContext(request: Pick<RememberedRequest, "systemPrompt" | "systems" | "tools">): Context {
	const message: Message = { role: "user", content: HELD_PREFIX_MESSAGE, timestamp: Date.now() };
	return {
		...(request.systemPrompt !== undefined ? { systemPrompt: request.systemPrompt } : {}),
		...(request.tools ? { tools: request.tools } : {}),
		messages: [...request.systems, message],
	};
}

interface ActiveRun extends CacheWarmRequest {
	/** False once the session's model or messages no longer match the request. */
	isCurrent: () => boolean;
	ttlMs: number;
	delayMs: number;
	/** Latest safe time to send this refresh, leaving half the original expiry margin. */
	refreshDeadlineAt: number;
	startedAt: number;
	controller: AbortController;
	phase: "streaming" | "idle";
	nextWarmAt: number;
	/** Set while a refresh that an extension forced is in flight. */
	extensionOverride: boolean;
	timer?: ReturnType<typeof setTimeout>;
}

/**
 * Keeps one prompt cache entry alive by re-sending its request with a
 * one-token output cap before the entry expires. `start` replaces any
 * previous run; warm requests never extend the fixed safety windows.
 */
export class CacheWarmer {
	private run?: ActiveRun;
	private inactive: CacheWarmingStatus;
	private pendingLabel?: CacheRouteLabel;
	private readonly remembered = new Map<string, RememberedRequest>();
	private held?: HeldPrefix;
	private readonly models: Pick<ModelRuntime, "streamSimple">;
	private readonly sessionManager: Pick<SessionManager, "appendUsage" | "getBranch">;
	private readonly getMode: () => CacheWarmingMode;
	/** Lets extensions override `event.action`; failures fall back to pi's decision. */
	private readonly decide: (event: CacheWarmingDecisionEvent) => Promise<CacheWarmingAction>;
	/** Called with the persisted usage entry after each successful refresh. */
	onWarmed?: (entry: UsageEntry) => void;

	constructor(
		models: Pick<ModelRuntime, "streamSimple">,
		sessionManager: Pick<SessionManager, "appendUsage" | "getBranch">,
		getMode: () => CacheWarmingMode,
		decide: (event: CacheWarmingDecisionEvent) => Promise<CacheWarmingAction> = async (event) => event.action,
	) {
		this.models = models;
		this.sessionManager = sessionManager;
		this.getMode = getMode;
		this.decide = decide;
		this.inactive = { state: "inactive", reason: "waiting for first request" };
	}

	get status(): CacheWarmingStatus {
		if (this.getMode() === "off") return { state: "inactive", reason: "cache warming disabled" };
		const run = this.run;
		if (!run) return this.inactive;
		if (!run.isCurrent()) return { state: "inactive", reason: "conversation context changed" };
		const decision = this.evaluate(run);
		const refreshing = run.timer === undefined;
		if (!decision.economicsAvailable && !refreshing) {
			return { state: "inactive", reason: "cache economics unavailable" };
		}
		return {
			state: refreshing ? "refreshing" : "scheduled",
			nextWarmAt: run.nextWarmAt,
			decision,
			extensionOverride: run.extensionOverride,
		};
	}

	/**
	 * The label the route of the next session request carries, or none. Set at the end of request preparation and
	 * consumed by the next `start`; a request that does not come through `start` never sees it.
	 */
	setRouteCache(label: CacheRouteLabel | undefined): void {
		this.pendingLabel = label;
	}

	/** The held prefix, when there is one. */
	get heldStatus(): HeldPrefixStatus | undefined {
		const held = this.held;
		if (!held) return undefined;
		return {
			key: held.key,
			state: held.timer === undefined ? "refreshing" : "scheduled",
			nextWarmAt: held.nextWarmAt,
			refreshes: held.refreshes,
			cost: held.spent,
		};
	}

	/**
	 * Keep the prompt cache entry written by `request` warm while `isCurrent` holds. `heldIsCurrent` is the same test for
	 * a held prefix: it concerns the selection and the branch, not the routed model.
	 */
	start(request: CacheWarmRequest, isCurrent: () => boolean, heldIsCurrent: () => boolean = isCurrent): void {
		const label = this.pendingLabel;
		this.pendingLabel = undefined;
		if (label) this.applyLabel(label, request, heldIsCurrent);
		this.clearRun();
		const mode = this.getMode();
		if (mode === "off") {
			this.stop("cache warming disabled");
			return;
		}
		if (!isCacheWarmingReplayable(request.model, request.options)) {
			this.stop("request cannot be replayed safely");
			return;
		}
		const ttlMs = getPromptCacheTtlMs(request.model, request.options);
		if (ttlMs === undefined) {
			this.stop(
				request.options.cacheRetention === "none"
					? "request disabled prompt caching"
					: "cache lifetime unavailable",
			);
			return;
		}
		const delayMs = getCacheWarmingDelayMs(ttlMs);
		if (delayMs === undefined) {
			this.stop("cache lifetime unavailable");
			return;
		}
		this.run = {
			...request,
			isCurrent,
			ttlMs,
			delayMs,
			refreshDeadlineAt: 0,
			startedAt: Date.now(),
			controller: new AbortController(),
			phase: "streaming",
			nextWarmAt: 0,
			extensionOverride: false,
		};
		this.schedule(this.run);
	}

	onAgentSettled(): void {
		this.endHeld();
		const run = this.run;
		if (!run) return;
		if (this.getMode() === "streaming") {
			this.stop("agent run settled");
			return;
		}
		run.phase = "idle";
		const deadline = run.startedAt + CACHE_WARMING_MAX_IDLE_AGE_MS;
		if (run.nextWarmAt > deadline || Date.now() >= deadline) {
			this.stop("30-minute idle safety limit reached");
		}
	}

	/** Reconcile an active run after the persisted warming mode changes. */
	onModeChanged(): void {
		if (this.held && this.getMode() === "off") this.endHeld();
		const run = this.run;
		if (!run) return;
		const reason = this.getModeStopReason(run);
		if (reason) this.stop(reason);
	}

	cancel(): void {
		this.pendingLabel = undefined;
		this.remembered.clear();
		this.endHeld();
		this.stop("inactive");
	}

	/** End the hold of a prefix, if there is one, and abort a refresh in flight. */
	endHeld(): void {
		const held = this.held;
		if (!held) return;
		this.held = undefined;
		if (held.timer) clearTimeout(held.timer);
		held.controller.abort();
	}

	private applyLabel(label: CacheRouteLabel, request: CacheWarmRequest, heldIsCurrent: () => boolean): void {
		this.remembered.set(label.key, {
			model: request.model,
			systemPrompt: request.context.systemPrompt,
			systems: request.context.messages.filter((message) => message.role === "system"),
			tools: request.context.tools,
			options: request.options,
			sentAt: Date.now(),
		});
		// A request under the held key reads the prefix itself; one that does not hold it ends the hold.
		if (this.held && (this.held.key === label.key || this.held.key !== label.holdPrefix)) this.endHeld();
		if (label.holdPrefix && !this.held) this.beginHold(label.holdPrefix, heldIsCurrent);
	}

	private beginHold(key: string, isCurrent: () => boolean): void {
		const request = this.remembered.get(key);
		if (!request || this.getMode() === "off") return;
		if (!isCacheWarmingReplayable(request.model, request.options)) return;
		const ttlMs = getPromptCacheTtlMs(request.model, request.options);
		const delayMs = ttlMs === undefined ? undefined : getCacheWarmingDelayMs(ttlMs);
		if (ttlMs === undefined || delayMs === undefined) return;
		const held: HeldPrefix = {
			key,
			request,
			isCurrent,
			prefixTokens: prefixTokensOf(request),
			ttlMs,
			delayMs,
			refreshDeadlineAt: 0,
			controller: new AbortController(),
			nextWarmAt: 0,
			refreshes: 0,
			spent: 0,
		};
		this.held = held;
		// The entry was last read when the request was sent, not when the hold began.
		this.scheduleHeld(held, request.sentAt);
	}

	private scheduleHeld(held: HeldPrefix, from: number): void {
		held.nextWarmAt = from + held.delayMs;
		held.refreshDeadlineAt = held.nextWarmAt + Math.floor((held.ttlMs - held.delayMs) / 2);
		if (held.nextWarmAt > held.request.sentAt + CACHE_WARMING_MAX_AGE_MS) {
			this.endHeld();
			return;
		}
		held.timer = setTimeout(() => void this.refreshHeld(held), Math.max(0, held.nextWarmAt - Date.now()));
		held.timer.unref?.();
	}

	private heldStillValid(held: HeldPrefix): boolean {
		if (this.held !== held) return false;
		if (this.getMode() === "off" || !held.isCurrent()) {
			this.endHeld();
			return false;
		}
		return true;
	}

	private async refreshHeld(held: HeldPrefix): Promise<void> {
		held.timer = undefined;
		if (!this.heldStillValid(held)) return;
		if (Date.now() > held.refreshDeadlineAt) {
			this.endHeld();
			return;
		}
		const { request } = held;
		const decision = evaluateHeldPrefix(request.model, held.prefixTokens, held.spent);
		let action = decision.action;
		try {
			action = await this.decide({
				type: "cache_warming_decision",
				key: held.key,
				warmCost: decision.warmCost,
				missCost: decision.saving,
				continuationProbability: 1,
				action,
			});
		} catch {
			// Extension failures fall back to pi's own decision.
		}
		if (!this.heldStillValid(held)) return;
		if (Date.now() > held.refreshDeadlineAt || action === "stop") {
			this.endHeld();
			return;
		}
		// A new request, not a replay of the conversation: the prefix and one short message.
		const context = heldPrefixContext(request);
		try {
			const result = await this.models
				.streamSimple(
					request.model,
					context,
					getCacheWarmingRequestOptions(request.options, held.controller.signal),
				)
				.result();
			if (this.held !== held) return;
			if (result.stopReason !== "error" && result.stopReason !== "aborted") {
				const entry = this.sessionManager.appendUsage(
					"cache_warm",
					result.provider,
					result.responseModel ?? result.model,
					result.usage,
					`${HELD_PREFIX_NOTE}${held.key}`,
				);
				held.refreshes++;
				held.spent += result.usage.cost.total > 0 ? result.usage.cost.total : decision.warmCost;
				this.onWarmed?.(entry);
			}
		} catch {
			// Cache warming is best-effort and must not affect the active agent run.
		}
		if (this.held === held) this.scheduleHeld(held, Date.now());
	}

	private clearRun(): void {
		const run = this.run;
		if (!run) return;
		this.run = undefined;
		if (run.timer) clearTimeout(run.timer);
		run.controller.abort();
	}

	private stop(reason: string, stopped?: Pick<CacheWarmingStatus, "decision" | "extensionOverride">): void {
		this.clearRun();
		this.inactive = { state: "inactive", reason, ...stopped };
	}

	private schedule(run: ActiveRun): void {
		run.extensionOverride = false;
		run.nextWarmAt = Date.now() + run.delayMs;
		// A timer can run late after sleep or event-loop blockage. Keep half of
		// the planned pre-expiry margin for that delay and request dispatch; a
		// late refresh is likely a full-price cache write, not a cache warm.
		run.refreshDeadlineAt = run.nextWarmAt + Math.floor((run.ttlMs - run.delayMs) / 2);
		const deadline =
			run.startedAt + (run.phase === "idle" ? CACHE_WARMING_MAX_IDLE_AGE_MS : CACHE_WARMING_MAX_AGE_MS);
		if (run.nextWarmAt > deadline || Date.now() >= deadline) {
			this.stop(run.phase === "idle" ? "30-minute idle safety limit reached" : "one-hour safety limit reached");
			return;
		}
		run.timer = setTimeout(() => void this.refresh(run), Math.max(0, run.nextWarmAt - Date.now()));
		run.timer.unref?.();
	}

	private async refresh(run: ActiveRun): Promise<void> {
		run.timer = undefined;
		if (!this.validateRun(run)) return;
		if (this.refreshDeadlineMissed(run)) return;
		const decision = this.evaluate(run);
		const { warmCost, missCost, continuationProbability } = decision;
		let action = decision.action;
		try {
			action = await this.decide({
				type: "cache_warming_decision",
				warmCost,
				missCost,
				continuationProbability,
				action,
			});
		} catch {
			// Extension failures fall back to pi's own decision.
		}
		if (!this.validateRun(run) || this.refreshDeadlineMissed(run)) return;
		const extensionOverride = action !== decision.action;
		if (action === "stop") {
			const reason = extensionOverride
				? "stopped by extension"
				: decision.economicsAvailable
					? "expected savings below threshold"
					: "cache economics unavailable";
			this.stop(reason, { decision, extensionOverride });
			return;
		}

		run.extensionOverride = extensionOverride;
		try {
			const message = await this.models
				.streamSimple(run.model, run.context, getCacheWarmingRequestOptions(run.options, run.controller.signal))
				.result();
			if (!this.validateRun(run)) return;
			if (message.stopReason !== "error" && message.stopReason !== "aborted") {
				const entry = this.sessionManager.appendUsage(
					"cache_warm",
					message.provider,
					message.responseModel ?? message.model,
					message.usage,
					extensionOverride ? "extension override" : undefined,
				);
				this.onWarmed?.(entry);
			}
		} catch {
			// Cache warming is best-effort and must not affect the active agent run.
		}
		if (this.run === run) this.schedule(run);
	}

	private refreshDeadlineMissed(run: ActiveRun): boolean {
		if (Date.now() <= run.refreshDeadlineAt) return false;
		this.stop("cache refresh deadline missed");
		return true;
	}

	private validateRun(run: ActiveRun): boolean {
		if (this.run !== run) return false;
		const reason = this.getModeStopReason(run) ?? (!run.isCurrent() ? "conversation context changed" : undefined);
		if (!reason) return true;
		this.stop(reason);
		return false;
	}

	private getModeStopReason(run: ActiveRun): string | undefined {
		const mode = this.getMode();
		if (mode === "off") return "cache warming disabled";
		if (mode === "streaming" && run.phase === "idle") return "agent run settled";
		return undefined;
	}

	private evaluate(run: ActiveRun): CacheWarmingDecision {
		return evaluateCacheWarming(run.model, lastPromptTokens(this.sessionManager.getBranch()), run.phase);
	}
}

function formatDollars(value: number): string {
	return value < 0 ? `-$${Math.abs(value).toFixed(3)}` : `$${value.toFixed(3)}`;
}

function formatCacheWarmingEconomics(decision: CacheWarmingDecision): string {
	if (!decision.economicsAvailable) return "cache economics unavailable";
	const probability = Math.round(decision.continuationProbability * 100);
	const probabilityText =
		decision.phase === "streaming"
			? `${probability}% continuation probability while agent is running`
			: `${probability}% continuation probability`;
	const comparison = decision.action === "warm" ? ">=" : "<";
	return `${probabilityText}, expected savings ${formatDollars(decision.expectedSavings)} ${comparison} $${CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS.toFixed(3)}`;
}

function formatCacheWarmingDecisionTime(nextWarmAt: number | undefined, now: number): string {
	if (nextWarmAt === undefined || nextWarmAt <= now) return "Decision now";
	let remainingSeconds = Math.ceil((nextWarmAt - now) / 1000);
	const hours = Math.floor(remainingSeconds / 3600);
	remainingSeconds %= 3600;
	const minutes = Math.floor(remainingSeconds / 60);
	const seconds = remainingSeconds % 60;
	const parts: string[] = [];
	if (hours > 0) parts.push(`${hours}h`);
	if (minutes > 0) parts.push(`${minutes}m`);
	if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
	return `Decision in ${parts.join(" ")}`;
}

/** One-line status for `/session`. */
export function formatCacheWarmingStatus(status: CacheWarmingStatus, now = Date.now()): string {
	const decision = status.decision;
	// A decision is attached once pi (or an extension) acted on it; "inactive"
	// without one never got that far.
	if (!decision || (status.state === "inactive" && !decision.economicsAvailable && !status.extensionOverride)) {
		return `Inactive (${status.reason ?? "unknown reason"})`;
	}
	const details = status.extensionOverride
		? `extension override, ${formatCacheWarmingEconomics(decision)}`
		: `${formatCacheWarmingEconomics(decision)} -> ${decision.action}`;
	if (status.state === "inactive") return `Stopped (${details})`;
	if (status.state === "refreshing") return `Warming cache (${details})`;
	return `${formatCacheWarmingDecisionTime(status.nextWarmAt, now)} (${details})`;
}

/** One line for `/session` about a held prefix. */
export function formatHeldPrefixStatus(status: HeldPrefixStatus, now = Date.now()): string {
	const spent = `${status.refreshes} refresh${status.refreshes === 1 ? "" : "es"}, ${formatDollars(status.cost)}`;
	const when =
		status.state === "refreshing" ? "refreshing now" : formatCacheWarmingDecisionTime(status.nextWarmAt, now);
	return `${status.key}: ${when}; ${spent}`;
}

/** One-line transcript text for the total cost of one or more consecutive cache warms. */
export function formatCacheWarmingUsage(totalCost: number, note?: string): string {
	const noteText = note ? ` (${note})` : "";
	const cost = totalCost.toFixed(6).replace(/(\.\d{3}\d*?)0+$/, "$1");
	return `Cache warmed${noteText}: $${cost}`;
}
