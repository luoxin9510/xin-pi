import type { AssistantMessage } from "../types.ts";
import { isRetryableErrorKind, textIndicatesRetryable } from "./error-kind.ts";

/**
 * Retry policy: bounded attempts with exponential backoff (`baseDelayMs * 2^(attempt-1)`).
 * `maxAgentDelayMs` caps each computed delay and defaults to 60 seconds.
 * Matches `settings.retry` (`enabled`, `maxRetries`, `baseDelayMs`, `maxAgentDelayMs`) in coding-agent; kept
 * here so the classifier and the policy-driven retry loop live together and stay reusable
 * by the SDK and other callers.
 */
export interface RetryPolicy {
	enabled: boolean;
	/** Max retry attempts (0 = no retries). The initial call never counts as a retry. */
	maxRetries: number;
	/** Base delay in ms. Per-attempt delay is `baseDelayMs * 2^(attempt-1)` before jitter. */
	baseDelayMs: number;
	/** Optional cap for agent-level retry delays in ms. Defaults to 60 seconds. */
	maxAgentDelayMs?: number;
}

export const DEFAULT_MAX_AGENT_RETRY_DELAY_MS = 60_000;

export function retryDelayMs(policy: Pick<RetryPolicy, "baseDelayMs" | "maxAgentDelayMs">, attempt: number): number {
	const delay = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1);
	const safeDelay = Number.isSafeInteger(delay) ? delay : Number.MAX_SAFE_INTEGER;
	return Math.min(safeDelay, policy.maxAgentDelayMs ?? DEFAULT_MAX_AGENT_RETRY_DELAY_MS);
}

/** Optional callbacks emitted by {@link retryAssistantCall} around each retry. */
export interface RetryCallbacks {
	/** Emitted before the backoff sleep of each retry attempt (1-indexed). */
	onRetryScheduled?: (
		attempt: number,
		maxAttempts: number,
		delayMs: number,
		errorMessage: string,
	) => void | Promise<void>;
	/** Emitted after the backoff sleep, immediately before the retried call starts. */
	onRetryAttemptStart?: () => void | Promise<void>;
	/** Emitted once when the loop ends: success if a later call completed normally. */
	onRetryFinished?: (success: boolean, attempt: number, finalError?: string) => void | Promise<void>;
}

class RetrySleepAbortError extends Error {
	constructor() {
		super("Aborted");
	}
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new RetrySleepAbortError());
			return;
		}
		const timeout = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timeout);
				reject(new RetrySleepAbortError());
			},
			{ once: true },
		);
	});
}

/**
 * Run a single assistant-producing call with bounded retry on transient errors.
 *
 * Behavior:
 * - A successful response is returned immediately. Aborts are terminal and never
 *   retried, but reported as unsuccessful if they happen after a retry was scheduled.
 *   Aborts during the backoff sleep are normalized to an aborted `AssistantMessage`
 *   too, so callers do not need to care when cancellation happened.
 * - A non-retryable error (per {@link isRetryableAssistantError}, including quota/
 *   billing exhaustion) is returned immediately so deterministic errors fail fast.
 * - Otherwise retries up to `maxRetries` times with exponential backoff, emitting
 *   `onRetryScheduled` before each sleep, `onRetryAttemptStart` after each sleep before
 *   the retried call starts, and `onRetryFinished` once at the end (whether the loop
 *   ends in success, exhausted retries, or an aborted backoff).
 *
 * When `policy` is undefined or disabled, the first response is returned unchanged
 * (equivalent to calling `produce()` directly).
 */
export async function retryAssistantCall(
	produce: () => Promise<AssistantMessage>,
	policy: RetryPolicy | undefined,
	signal: AbortSignal | undefined,
	callbacks?: RetryCallbacks,
): Promise<AssistantMessage> {
	const maxAttempts = policy?.enabled ? policy.maxRetries : 0;

	let attempt = 0;
	let lastRetry: { attempt: number; errorMessage: string } | undefined;
	for (;;) {
		const response = await produce();

		// Abort: terminal but not successful. Never retry an aborted message.
		if (response.stopReason === "aborted") {
			if (lastRetry) await callbacks?.onRetryFinished?.(false, lastRetry.attempt);
			return response;
		}

		// Success: non-error, non-abort responses return as-is.
		if (response.stopReason !== "error") {
			if (lastRetry) await callbacks?.onRetryFinished?.(true, lastRetry.attempt);
			return response;
		}

		// Non-retryable, or budget exhausted: return the final error message.
		if (attempt >= maxAttempts || !isRetryableAssistantError(response)) {
			if (lastRetry) await callbacks?.onRetryFinished?.(false, lastRetry.attempt, response.errorMessage);
			return response;
		}

		const wait = retryWait(response, policy!, attempt + 1);
		if (wait.tooLong) {
			const errorMessage = retryWaitTooLongMessage(response, policy!);
			if (lastRetry) await callbacks?.onRetryFinished?.(false, lastRetry.attempt, errorMessage);
			return { ...response, errorMessage };
		}

		attempt++;
		lastRetry = { attempt, errorMessage: response.errorMessage || "Unknown error" };
		const delayMs = wait.delayMs;
		await callbacks?.onRetryScheduled?.(attempt, maxAttempts, delayMs, lastRetry.errorMessage);

		// Normalize aborts during retry backoff to the same AssistantMessage shape as
		// provider stream aborts, so callers do not need to care when cancellation happened.
		try {
			await sleep(delayMs, signal);
		} catch (error) {
			await callbacks?.onRetryFinished?.(false, attempt, lastRetry.errorMessage);
			if (error instanceof RetrySleepAbortError) {
				const {
					errorMessage: _errorMessage,
					errorKind: _errorKind,
					errorStatus: _errorStatus,
					retryAfterMs: _retryAfterMs,
					...rest
				} = response;
				return { ...rest, stopReason: "aborted" };
			}
			throw error;
		}
		await callbacks?.onRetryAttemptStart?.();
	}
}

/**
 * Classifies whether a failed assistant message looks like a transient provider
 * or transport error, so callers can decide if the last assistant turn should be
 * restarted.
 *
 * Reads `errorKind` when the provider set one (`transient` and `rate_limit` retry); messages without a kind fall
 * back to matching the error text.
 *
 * This does not implement retry policy. Callers should first handle context
 * overflow separately, then apply their own retry budget, backoff, and reporting
 * before restarting the assistant turn.
 */
export function isRetryableAssistantError(message: AssistantMessage): boolean {
	if (message.stopReason !== "error" || !message.errorMessage) return false;
	if (message.errorKind !== undefined) return isRetryableErrorKind(message.errorKind);
	return textIndicatesRetryable(message.errorMessage);
}

/**
 * Wait before the next retry of a failed message: the provider's `retryAfterMs` replaces the computed backoff.
 * `tooLong` is set when that wait exceeds `maxAgentDelayMs`; the caller then stops instead of retrying.
 */
export function retryWait(
	message: AssistantMessage,
	policy: Pick<RetryPolicy, "baseDelayMs" | "maxAgentDelayMs">,
	attempt: number,
): { delayMs: number; tooLong: boolean } {
	if (message.retryAfterMs === undefined) return { delayMs: retryDelayMs(policy, attempt), tooLong: false };
	const cap = policy.maxAgentDelayMs ?? DEFAULT_MAX_AGENT_RETRY_DELAY_MS;
	return { delayMs: message.retryAfterMs, tooLong: message.retryAfterMs > cap };
}

/** The error text of a message that is not retried because the provider asked for a wait over the limit. */
export function retryWaitTooLongMessage(
	message: AssistantMessage,
	policy: Pick<RetryPolicy, "maxAgentDelayMs">,
): string {
	const cap = policy.maxAgentDelayMs ?? DEFAULT_MAX_AGENT_RETRY_DELAY_MS;
	const wait = Math.ceil((message.retryAfterMs ?? 0) / 1000);
	return `${message.errorMessage ?? "Unknown error"}\nThe provider asked to wait ${wait}s, longer than the retry limit of ${Math.ceil(cap / 1000)}s (retry.maxAgentDelayMs). Not retrying.`;
}
