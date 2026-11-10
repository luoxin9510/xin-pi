import type { ErrorKind } from "../types.ts";

// Provider error classification. Every provider catch path calls `classifyProviderError` once and stores the result on
// the failed message (`errorKind`, `errorStatus`, `retryAfterMs`). The session, compaction and
// `isRetryableAssistantError` / `isContextOverflow` read the kind first. The text tables below are the last step of the
// classifier and the whole story for messages without a kind (old sessions, providers not converted yet).

function buildProviderErrorPattern(patterns: readonly string[]): RegExp {
	return new RegExp(patterns.join("|"), "i");
}

// Text tables. Each group below stays because the failure carries no class, status or code the classifier can read:
// - quota and plan-limit wording (this table): servers send it with 400, 429 or 5xx and only the text tells a spent
//   quota from a throttle.
const NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN = buildProviderErrorPattern([
	// OpenCode Go/free-tier limits returned as 429 JSON error types by OpenCode's
	// Zen API. These are subscription/account limits, not transient throttles.
	"GoUsageLimitError",
	"FreeUsageLimitError",

	// OpenCode Go subscription-limit text asks users to enable available-balance
	// usage after rolling/weekly/monthly limits are reached.
	"Monthly usage limit reached",
	"available balance",

	// Generic quota/budget/billing exhaustion. `insufficient_quota` is OpenAI's
	// quota/billing error code; the other strings cover common gateway wording.
	"insufficient_quota",
	"out of budget",
	"quota exceeded",
	"billing",

	// Sign in with ChatGPT: the subscription's shared usage limit, which resets
	// after hours rather than seconds.
	"subscription_sharing_usage_limit_exceeded",
	// Sign in with ChatGPT on a ChatGPT Business plan: a usage limit set by the
	// workspace admin. Only the admin can raise it.
	"subscription_sharing_workplace_individual_usage_limit_exceeded",

	// Zhipu/Z.ai (open.bigmodel.cn) error code 1308: the plan's usage limit is
	// reached, sent as HTTP 429. It resets after hours, not seconds (#11537).
	'"code"\\s*:\\s*"?1308(?![0-9])',
]);

// - transient wording (this table). It is the whole signal for (a) errors inside a 200 stream, where the status is 200
//   and only an error event or a premature end tells the stream failed, and (b) network errors that carry no `code`
//   or error class (a gateway's "upstream connect error", a bare "terminated").
const RETRYABLE_PROVIDER_ERROR_PATTERN = buildProviderErrorPattern([
	// Generic provider load, HTTP status, and server-side transient failures.
	"overloaded",
	"server_busy",
	"servers are currently busy",
	"currently experiencing high demand",
	"model is at capacity",
	"rate.?limit",
	"too many requests",
	// Status codes must not be part of a longer word or number, e.g. a request id or byte count (#11057).
	"(?<![a-z0-9])(?:429|500|502|503|504|520|524)(?![a-z0-9])",
	// Also matches "The service is temporarily unavailable" (#10965).
	"service.?(?:is.?)?(?:temporarily.?)?unavailable",
	"server.?error",
	"internal.?error",

	// Wrapper/provider text for transient upstream failures, including OpenRouter
	// "Provider returned error" responses (#2264) and gateway wording such as
	// "The upstream provider returned an error" (#10842).
	"provider.?returned.?(?:an.?)?error",
	"exceeded request buffer limit while retrying upstream",
	// Gateway failure relaying the upstream response stream, sent as an OpenAI
	// Responses `response.failed` event without an error code (#10920).
	"unable to forward upstream",
	// Other gateway upstream failures relayed as `response.failed` error codes (#10920).
	"upstream.?request.?failed",
	"upstream_stream_read_error",
	"stream was interrupted",
	"http/?2 stream failed",

	// Network, proxy, and fetch transport failures. This includes OpenAI Codex
	// raw-fetch failures such as "upstream connect", "connection refused", and
	// "reset before headers" (#733), plus OpenRouter connection drops (#3317).
	"network.?error",
	"connection.?error",
	"connection.?refused",
	"connection.?lost",
	"other side closed",
	"fetch failed",
	// node-fetch system errors, e.g. the Google ADC OAuth token refresh used by
	// google-vertex. The reason is often empty (#10996).
	"request to \\S+ failed, reason:",
	"getaddrinfo",
	"ENOTFOUND",
	"EAI_AGAIN",
	"upstream.?connect",
	"reset before headers",
	"socket hang up",
	"socket connection was closed",
	"timed? out",
	"timeout",
	"terminated",

	// WebSocket transports can report close/error text instead of HTTP/fetch text.
	"websocket.?closed",
	"websocket.?error",

	// Premature stream endings from SDKs and transports. Anthropic can throw
	// "stream ended without ..." and "Anthropic stream ended before message_stop"
	// (#4433); Bedrock/Smithy can throw an HTTP/2 no-response error (#3594).
	"ended without",
	"stream ended before message_stop",
	"stream ended before a terminal response event",
	"http2 request did not get a response",
	// Codex CLI mid-stream disconnect, relayed by proxies that wrap the Codex CLI,
	// e.g. "stream disconnected before completion: stream closed before response.completed" (#11057).
	"stream disconnected before completion",
	// Magpie gateway relaying a dropped upstream Anthropic stream, e.g.
	// "Claude Code's stream from Anthropic was cut short after the reply had begun" (#11879).
	"cut short after the reply had begun",
	// Node ERR_HTTP2_STREAM_CANCEL: the HTTP/2 session died before the request was
	// sent, e.g. after the Bedrock SDK's 5-minute session timeout (#10379).
	"pending stream has been canceled",

	// Provider-requested retry delay cap failures should flow through the outer
	// retry policy so callers can surface/abort the backoff (#1123).
	"retry delay",

	// Explicit retry guidance emitted mid-stream by OpenAI Responses and Bedrock
	// stream exceptions (#6019).
	"you can retry your request",
	"try your request again",
	"please retry your request",

	// gRPC based providers (e.g. NVIDIA NIM)
	"ResourceExhausted",

	// Sign in with ChatGPT: usage or user data temporarily unavailable. Usage
	// failures can arrive mid-stream without an HTTP 503 in the message.
	"subscription_sharing_usage_unavailable",
	"subscription_sharing_user_unavailable",
]);

/**
 * Regex patterns to detect context overflow errors from different providers.
 *
 * These stay because overflow usually arrives as a plain HTTP 400 with a free-text message and no error code: the
 * text is the only thing that tells it from any other bad request.
 *
 * These patterns match error messages returned when the input exceeds
 * the model's context window or the provider's request byte-size limit.
 *
 * Provider-specific patterns (with example error messages):
 *
 * - Anthropic: "prompt is too long: 213462 tokens > 200000 maximum"
 * - Anthropic: "413 {\"error\":{\"type\":\"request_too_large\",\"message\":\"Request exceeds the maximum size\"}}"
 * - OpenAI: "Your input exceeds the context window of this model"
 * - OpenAI/LiteLLM: "Requested token count exceeds the model's maximum context length of 131072 tokens"
 * - LiteLLM pre-call check: "litellm.ContextWindowExceededError: ... Context Window exceeded for given call."
 * - OpenAI-compatible: "Input length (265330) exceeds model's maximum context length (262144)."
 * - Google: "The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)"
 * - xAI: "This model's maximum prompt length is 131072 but the request contains 537812 tokens"
 * - Groq: "Please reduce the length of the messages or completion"
 * - OpenRouter: "This endpoint's maximum context length is X tokens. However, you requested about Y tokens"
 * - OpenRouter/Poolside: "Input length X exceeds the maximum allowed input length of Y tokens."
 * - Together AI: "The input (X tokens) is longer than the model's context length (Y tokens)."
 * - llama.cpp: "the request exceeds the available context size, try increasing it"
 * - LM Studio: "tokens to keep from the initial prompt is greater than the context length"
 * - GitHub Copilot: "prompt token count of X exceeds the limit of Y"
 * - GitHub Copilot: 'github-copilot API error (413): {"message":"failed to parse request","code":""}'
 * - MiniMax: "invalid params, context window exceeds limit"
 * - Kimi For Coding: "Your request exceeded model token limit: X (requested: Y)"
 * - DS4: "Prompt has X tokens, but the configured context size is Y tokens"
 * - Cerebras: "400/413 status code (no body)"
 * - Mistral: "Prompt contains X tokens ... too large for model with Y maximum context length"
 * - z.ai: `{"code":"1261","message":"Prompt too long"}`, `{"code":"1261","message":"Prompt exceeds max length"}` (CN endpoint), or silent overflow via usage.input > contextWindow
 * - Xiaomi MiMo: Truncates input to fill contextWindow exactly, then returns finish_reason "length"
 *   with output=0 (no room left to generate). Detected via stopReason "length" + zero output +
 *   input filling the context window.
 * - DashScope/Qwen: "Range of input length should be [1, X]" (HTTP 400 invalid_parameter_error)
 * - Ollama: Some deployments truncate silently, others return errors like "prompt too long; exceeded max context length by X tokens"
 */
export const OVERFLOW_PATTERNS = [
	/prompt (?:is )?too long/i, // Anthropic and z.ai token overflow
	/prompt exceeds max length/i, // z.ai CN endpoint token overflow
	/request_too_large/i, // Anthropic request byte-size overflow (HTTP 413)
	/input is too long for requested model/i, // Amazon Bedrock
	/exceeds the context window/i, // OpenAI (Completions & Responses API)
	/exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i, // OpenAI-compatible proxies (LiteLLM)
	/context window exceeded/i, // LiteLLM pre-call check (ContextWindowExceededError)
	/input token count.*exceeds the maximum/i, // Google (Gemini)
	/maximum prompt length is \d+/i, // xAI (Grok)
	/reduce the length of the messages/i, // Groq
	/maximum context length is \d+ tokens/i, // OpenRouter (most backends)
	/exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i, // OpenRouter/Poolside
	/input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i, // Together AI
	/exceeds the limit of \d+/i, // GitHub Copilot
	/exceeds the available context size/i, // llama.cpp server
	/greater than the context length/i, // LM Studio
	/context window exceeds limit/i, // MiniMax
	/exceeded model token limit/i, // Kimi For Coding
	/too large for model with \d+ maximum context length/i, // Mistral
	/prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i, // DS4 server
	/model_context_window_exceeded/i, // z.ai non-standard finish_reason surfaced as error text
	/prompt too long; exceeded (?:max )?context length/i, // Ollama explicit overflow error
	/range of input length should be/i, // DashScope / Qwen Token Plan
	/context[_ ]length[_ ]exceeded/i, // Generic fallback
	/too many tokens/i, // Generic fallback
	/token limit exceeded/i, // Generic fallback
	// HTTP 413 means request-size overflow regardless of provider or body text.
	// Match raw SDK errors and formatProviderError's prefix, not a status mentioned in the body.
	/^(?:[\w -]+ API error \(413\):|413(?:\s|:|$))/i,
];

const CEREBRAS_BODYLESS_OVERFLOW_PATTERN = /^4(?:00|13)\s*(?:status code)?\s*\(no body\)/i;

/**
 * Patterns that indicate non-overflow errors (e.g. rate limiting, server errors).
 * Error messages matching any of these are excluded from overflow detection
 * even if they also match an OVERFLOW_PATTERN.
 *
 * Example: Bedrock formats throttling errors as "ThrottlingException: Too many tokens,
 * please wait before trying again." which would match the /too many tokens/i overflow
 * pattern without this exclusion.
 */
const NON_OVERFLOW_PATTERNS = [
	// Old sessions only: messages stored before Bedrock errors were classified by exception name carry no `errorKind`
	// and start with these prefixes.
	/^(Throttling error|Service unavailable):/i,
	/rate limit/i, // Generic rate limiting
	/too many requests/i, // Generic HTTP 429 style
];

/** Text of an error message matches a known quota, billing or plan-limit failure. */
export function textIndicatesUsageLimit(text: string): boolean {
	return NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(text);
}

/** Text of an error message looks like a transient provider or transport failure (and is no usage limit). */
export function textIndicatesRetryable(text: string): boolean {
	if (NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(text)) return false;
	return RETRYABLE_PROVIDER_ERROR_PATTERN.test(text);
}

/** Text of an error message looks like a context or request size overflow. */
export function textIndicatesOverflow(text: string, provider?: string): boolean {
	if (NON_OVERFLOW_PATTERNS.some((p) => p.test(text))) return false;
	if (OVERFLOW_PATTERNS.some((p) => p.test(text))) return true;
	return provider === "cerebras" && CEREBRAS_BODYLESS_OVERFLOW_PATTERN.test(text);
}

export interface ErrorClassification {
	kind: ErrorKind;
	/** HTTP status found on the error or its cause chain. */
	status?: number;
	/** Wait the provider asked for, from `retry-after-ms` or `retry-after` on the error's response headers. */
	retryAfterMs?: number;
}

export interface ClassifyOptions {
	/** Provider id, for the few text rules that are provider specific. */
	provider?: string;
	/**
	 * Display text of the failure (what ends up in `errorMessage`, body included). Defaults to the error's message.
	 * Only the last classification step reads it, plus provider codes quoted inside it.
	 */
	text?: string;
}

const MAX_CHAIN_DEPTH = 5;

/** Error codes of connection-level failures (Node, undici, HTTP/2). Matched on every error in the cause chain. */
const NETWORK_ERROR_CODES = new Set([
	"ECONNRESET",
	"ECONNREFUSED",
	"ECONNABORTED",
	"ETIMEDOUT",
	"ENOTFOUND",
	"EAI_AGAIN",
	"EPIPE",
	"ENETUNREACH",
	"EHOSTUNREACH",
	"UND_ERR_SOCKET",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_HEADERS_TIMEOUT",
	"UND_ERR_BODY_TIMEOUT",
	"UND_ERR_REQ_RETRY",
	"ERR_HTTP2_STREAM_CANCEL",
	"ERR_HTTP2_STREAM_ERROR",
	"ERR_HTTP2_SESSION_ERROR",
	"ERR_STREAM_PREMATURE_CLOSE",
]);

/** Error class names of connection-level failures (`openai`, `@anthropic-ai/sdk`, fetch). */
const NETWORK_ERROR_NAMES = new Set(["APIConnectionError", "APIConnectionTimeoutError", "TimeoutError"]);

/** Provider error codes (`error.type` / `error.code` in bodies and SSE error events) with a decided kind. */
const PROVIDER_CODE_KINDS: Record<string, ErrorKind> = {
	// Anthropic
	overloaded_error: "transient",
	api_error: "transient",
	timeout_error: "transient",
	rate_limit_error: "rate_limit",
	authentication_error: "auth",
	permission_error: "auth",
	billing_error: "usage_limit",
	request_too_large: "context_overflow",
	// OpenAI and compatible
	server_error: "transient",
	service_unavailable_error: "transient",
	server_is_overloaded: "transient",
	slow_down: "rate_limit",
	rate_limit_exceeded: "rate_limit",
	insufficient_quota: "usage_limit",
	context_length_exceeded: "context_overflow",
	invalid_api_key: "auth",
	// Codex (ChatGPT backend): the plan's usage is spent
	usage_limit_reached: "usage_limit",
	usage_not_included: "usage_limit",
};

/**
 * Exception names of the AWS SDK (Bedrock). Decided before the status and the text: a stream exception carries no
 * status, and `ThrottlingException: Too many tokens, please wait` must not read as overflow. `ValidationException`
 * is left out on purpose: it is a plain bad request unless its text says overflow (see the text step).
 */
const EXCEPTION_NAME_KINDS: Record<string, ErrorKind> = {
	ThrottlingException: "rate_limit",
	ServiceQuotaExceededException: "usage_limit",
	AccessDeniedException: "auth",
	UnrecognizedClientException: "auth",
	ExpiredTokenException: "auth",
	InternalServerException: "transient",
	ServiceUnavailableException: "transient",
	ModelNotReadyException: "transient",
	ModelTimeoutException: "transient",
	ModelStreamErrorException: "transient",
};

function chainOf(error: unknown): object[] {
	const chain: object[] = [];
	let current: unknown = error;
	for (let depth = 0; depth < MAX_CHAIN_DEPTH && typeof current === "object" && current !== null; depth++) {
		chain.push(current);
		current = (current as { cause?: unknown }).cause;
	}
	return chain;
}

function statusOf(error: object): number | undefined {
	const e = error as {
		status?: unknown;
		statusCode?: unknown;
		$metadata?: { httpStatusCode?: unknown };
		$response?: { statusCode?: unknown };
	};
	for (const value of [e.statusCode, e.status, e.$metadata?.httpStatusCode, e.$response?.statusCode]) {
		if (typeof value === "number") return value;
	}
	return undefined;
}

function headerValue(headers: unknown, name: string): string | undefined {
	if (typeof headers !== "object" || headers === null) return undefined;
	const getter = (headers as { get?: unknown }).get;
	if (typeof getter === "function") {
		const value: unknown = getter.call(headers, name);
		return typeof value === "string" ? value : undefined;
	}
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === name && typeof value === "string") return value;
	}
	return undefined;
}

/** Parse `retry-after-ms`, then `retry-after` (seconds or HTTP date) from response headers. */
export function parseRetryAfterMs(headers: unknown): number | undefined {
	const ms = headerValue(headers, "retry-after-ms");
	if (ms) {
		const value = Number.parseFloat(ms);
		if (Number.isFinite(value) && value >= 0) return Math.ceil(value);
	}
	const after = headerValue(headers, "retry-after");
	if (after) {
		const seconds = Number.parseFloat(after);
		const delayMs = Number.isNaN(seconds) ? Date.parse(after) - Date.now() : seconds * 1000;
		if (Number.isFinite(delayMs)) return Math.max(0, Math.ceil(delayMs));
	}
	return undefined;
}

function codeKindOf(code: unknown): ErrorKind | undefined {
	return typeof code === "string" ? PROVIDER_CODE_KINDS[code.toLowerCase()] : undefined;
}

/** `type` / `code` on the error and on its parsed body (`error.error`, `error.error.error`). */
function bodyCodeKinds(error: object): ErrorKind[] {
	const kinds: ErrorKind[] = [];
	let current: unknown = error;
	for (let depth = 0; depth < 3 && typeof current === "object" && current !== null; depth++) {
		const record = current as { type?: unknown; code?: unknown; error?: unknown };
		for (const value of [record.code, record.type]) {
			const kind = codeKindOf(value);
			if (kind) kinds.push(kind);
		}
		current = record.error;
	}
	return kinds;
}

/** Codes quoted in failure text: JSON bodies (`"type":"overloaded_error"`) and `code: message` prefixes. */
function textCodeKinds(text: string): ErrorKind[] {
	const kinds: ErrorKind[] = [];
	for (const match of text.matchAll(/"(?:type|code)"\s*:\s*"([^"]+)"/g)) {
		const kind = codeKindOf(match[1]);
		if (kind) kinds.push(kind);
	}
	const prefix = /^(?:Error Code )?([a-z0-9_]+):/i.exec(text);
	const prefixKind = codeKindOf(prefix?.[1]);
	if (prefixKind) kinds.push(prefixKind);
	return kinds;
}

const RATE_LIMIT_TEXT_PATTERN = /rate.?limit|too many requests|(?<![a-z0-9])429(?![a-z0-9])|overloaded/i;

/** Last step: classify by message text only. Also the whole classification of a message without a kind. */
export function classifyErrorText(text: string, provider?: string): ErrorKind {
	if (textIndicatesOverflow(text, provider)) return "context_overflow";
	if (textIndicatesUsageLimit(text)) return "usage_limit";
	if (textIndicatesRetryable(text)) return RATE_LIMIT_TEXT_PATTERN.test(text) ? "rate_limit" : "transient";
	return "unknown";
}

/**
 * Classify a provider failure once. Order:
 * 0. AWS SDK exception name (Bedrock): decides before everything else.
 * 1. Error class or `code` on the cause chain: connection-level failures are `transient`.
 * 2. HTTP status (after overflow and quota codes or text, which win at any status). 401/403 `auth`, 402 `usage_limit`, 408/409/425/5xx `transient`, 413 `context_overflow`, 429
 *    `rate_limit`, other 4xx `invalid_request`; 400/422 go on to steps 3 and 4 because the same status carries
 *    overflow, quota and bad-request errors. A provider code that names a quota or overflow wins over the status
 *    (a 429 with `insufficient_quota` is `usage_limit`), and so does a quota text on 402/403/429.
 * 3. Provider error code in the body or in a streamed error event.
 * 4. Text fallback ({@link classifyErrorText}), for errors that carry nothing else.
 */
export function classifyProviderError(error: unknown, options: ClassifyOptions = {}): ErrorClassification {
	const chain = chainOf(error);
	const text = options.text ?? (error instanceof Error ? error.message : String(error));

	let status: number | undefined;
	let retryAfterMs: number | undefined;
	for (const entry of chain) {
		status ??= statusOf(entry);
		const e = entry as { headers?: unknown; $response?: { headers?: unknown } };
		retryAfterMs ??= parseRetryAfterMs(e.headers ?? e.$response?.headers);
	}
	const result = (kind: ErrorKind): ErrorClassification => {
		const classification: ErrorClassification = { kind };
		if (status !== undefined) classification.status = status;
		if (retryAfterMs !== undefined) classification.retryAfterMs = retryAfterMs;
		return classification;
	};

	const codeKinds = [...chain.flatMap((entry) => bodyCodeKinds(entry)), ...textCodeKinds(text)];

	// 0. AWS SDK exception names.
	for (const entry of chain) {
		const name = (entry as { name?: unknown }).name;
		const kind = typeof name === "string" ? EXCEPTION_NAME_KINDS[name] : undefined;
		if (kind) return result(kind);
	}

	// 1. Connection-level failures: no response to read a status from.
	if (status === undefined) {
		for (const entry of chain) {
			const e = entry as { code?: unknown; name?: unknown };
			const isNetwork =
				(typeof e.code === "string" && NETWORK_ERROR_CODES.has(e.code)) ||
				(typeof e.name === "string" && NETWORK_ERROR_NAMES.has(e.name)) ||
				NETWORK_ERROR_NAMES.has(entry.constructor.name);
			if (isNetwork) return result("transient");
		}
	}

	// 2. HTTP status.
	// Overflow and quota outrank the status whatever its value: servers send them with 400, 429 and 5xx, and the
	// session must compact (overflow) or stop (quota) instead of retrying.
	let specific = codeKinds.find((kind) => kind === "usage_limit" || kind === "context_overflow");
	if (!specific && textIndicatesOverflow(text, options.provider)) specific = "context_overflow";
	if (!specific && textIndicatesUsageLimit(text)) specific = "usage_limit";
	if (status !== undefined) {
		if (specific) return result(specific);
		if (status === 402 || status === 403 || status === 429) {
			if (textIndicatesUsageLimit(text)) return result("usage_limit");
			return result(status === 402 ? "usage_limit" : status === 403 ? "auth" : "rate_limit");
		}
		if (status === 401) return result("auth");
		if (status === 413) return result("context_overflow");
		if (status === 408 || status === 409 || status === 425 || status >= 500) return result("transient");
		if (status !== 400 && status !== 422) return result("invalid_request");
	}

	// 3. Provider error code.
	if (codeKinds.length > 0) return result(codeKinds[0]);

	// 4. Text.
	const byText = classifyErrorText(text, options.provider);
	const isValidationException = chain.some((entry) => (entry as { name?: unknown }).name === "ValidationException");
	if (byText === "unknown" && (status !== undefined || isValidationException)) return result("invalid_request");
	return result(byText);
}

/** Only `transient` and `rate_limit` failures are retried. */
export function isRetryableErrorKind(kind: ErrorKind): boolean {
	return kind === "transient" || kind === "rate_limit";
}

/** Fill `errorKind`, `errorStatus` and `retryAfterMs` on a failed message from the error its provider caught. */
export function applyErrorClassification(
	message: { errorKind?: ErrorKind; errorStatus?: number; retryAfterMs?: number },
	error: unknown,
	options: ClassifyOptions = {},
): void {
	const classification = classifyProviderError(error, options);
	message.errorKind = classification.kind;
	if (classification.status !== undefined) message.errorStatus = classification.status;
	if (classification.retryAfterMs !== undefined) message.retryAfterMs = classification.retryAfterMs;
}
