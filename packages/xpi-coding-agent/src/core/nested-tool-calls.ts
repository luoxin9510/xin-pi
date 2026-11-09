/**
 * Tool calls that a tool makes while it runs (`ctx.executeTool()`), for example from codemode
 * scripts. The agent loop does not know about them: the session runs each one through the agent's
 * tool pipeline (`runToolCall`) with its own hooks, emits `tool_execution_*` events with
 * `parentToolCallId`, and records the calls and their usage on the model-issued call's tool result
 * message.
 *
 * Nothing here runs until a tool calls `ctx.executeTool()`.
 */

import type {
	AgentTool,
	AgentToolCall,
	AgentToolCallOutcome,
	AgentToolResult,
	AgentToolUpdateCallback,
} from "xpi-agent-core";
import type { JsonObject, NestedToolCallRecord, NestedToolCalls, TextContent, Usage } from "xpi-ai";
import { combineUsage } from "./usage-totals.ts";

/**
 * Limits of the nested-call record on a tool result: arguments
 * over the per-call or total size are omitted, calls beyond the count are dropped, and the record
 * is marked incomplete when any of that happens.
 */
export const NESTED_CALL_LIMITS = {
	maxCalls: 256,
	maxArgumentBytesPerCall: 8 * 1024,
	maxArgumentBytesTotal: 32 * 1024,
	maxErrorChars: 500,
} as const;

const encoder = new TextEncoder();

/** What the nested calls of one model-issued tool call leave on its tool result message. */
export interface NestedCallSummary {
	/** Becomes `nestedCalls`. Undefined when no nested call was made. */
	calls: NestedToolCalls | undefined;
	/** Summed `usage` of the nested results, added to the message's `usage`. */
	usage: Usage | undefined;
}

/**
 * Collects the nested calls of one model-issued tool call, including calls made by nested tools.
 * The snapshot becomes `nestedCalls` on the tool result message.
 */
export class NestedCallRecorder {
	private readonly calls: NestedToolCallRecord[] = [];
	private readonly startedAt = new Map<NestedToolCallRecord, number>();
	private complete = true;
	private argumentBytes = 0;
	/** Summed usage of every nested result, including calls dropped from the record. */
	private usage: Usage | undefined;
	/** The part of `usage` that no `takeUnreportedUsage()` has handed out yet. */
	private unreported: Usage | undefined;

	/** Record a call as it starts. Returns undefined when the call is dropped. */
	start(toolCall: AgentToolCall): NestedToolCallRecord | undefined {
		if (this.calls.length >= NESTED_CALL_LIMITS.maxCalls) {
			this.complete = false;
			return undefined;
		}
		const record: NestedToolCallRecord = { id: toolCall.id, name: toolCall.name, status: "unfinished" };
		const json = JSON.stringify(toolCall.arguments ?? {});
		const bytes = encoder.encode(json).length;
		if (
			bytes > NESTED_CALL_LIMITS.maxArgumentBytesPerCall ||
			this.argumentBytes + bytes > NESTED_CALL_LIMITS.maxArgumentBytesTotal
		) {
			record.argumentsBytes = bytes;
			this.complete = false;
		} else {
			record.arguments = JSON.parse(json) as JsonObject;
			this.argumentBytes += bytes;
		}
		this.calls.push(record);
		this.startedAt.set(record, performance.now());
		return record;
	}

	finish(record: NestedToolCallRecord | undefined, isError: boolean, errorText: string): void {
		if (!record) return;
		record.status = isError ? "error" : "ok";
		record.durationMs = Math.round(performance.now() - (this.startedAt.get(record) ?? performance.now()));
		this.startedAt.delete(record);
		if (isError && errorText) record.error = errorText.slice(0, NESTED_CALL_LIMITS.maxErrorChars);
	}

	addUsage(usage: Usage): void {
		this.usage = this.usage ? combineUsage(this.usage, usage) : usage;
		this.unreported = this.unreported ? combineUsage(this.unreported, usage) : usage;
	}

	/** Usage added since the last call of this method (or since the start): what no result message has counted yet. */
	takeUnreportedUsage(): Usage | undefined {
		const usage = this.unreported;
		this.unreported = undefined;
		return usage;
	}

	get totalUsage(): Usage | undefined {
		return this.usage;
	}

	/** Copy of the record so far, or undefined when no nested call was made. */
	snapshot(): NestedToolCalls | undefined {
		if (this.calls.length === 0 && this.complete) return undefined;
		const calls = this.calls.map((call) => ({ ...call }));
		return { calls, complete: this.complete && calls.every((call) => call.status !== "unfinished") };
	}
}

export interface NestedToolCallOptions {
	/** Defaults to the calling tool's signal. */
	signal?: AbortSignal;
	/** Receives partial results of the nested tool, in addition to `tool_execution_update` events. */
	onUpdate?: AgentToolUpdateCallback;
}

/** `tool_execution_*` events of nested calls. */
export type NestedToolExecutionEvent =
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown; parentToolCallId: string }
	| {
			type: "tool_execution_update";
			toolCallId: string;
			toolName: string;
			args: unknown;
			partialResult: AgentToolResult<unknown>;
			parentToolCallId: string;
	  }
	| {
			type: "tool_execution_end";
			toolCallId: string;
			toolName: string;
			result: AgentToolResult<unknown>;
			isError: boolean;
			durationMs?: number;
			parentToolCallId: string;
	  };

export interface NestedToolCallHost {
	/** Tools nested calls resolve against. */
	getTools(): readonly AgentTool[];
	/** Whether every nested call runs exclusively, as when the agent executes tool calls sequentially. */
	isSequential(): boolean;
	/**
	 * Run the call through the tool pipeline, with hooks that report `parentToolCallId`. `origin` is what `captureOrigin()`
	 * returned when the scope was detached (undefined for calls of a scope that never was).
	 */
	runToolCall(
		toolCall: AgentToolCall,
		parentToolCallId: string,
		signal: AbortSignal | undefined,
		onUpdate: (partialResult: AgentToolResult<unknown>) => Promise<void>,
		origin?: unknown,
	): Promise<AgentToolCallOutcome>;
	/**
	 * The context the originating model turn gave its tool call (its assistant message and messages). Called when a scope is
	 * detached, so that calls made after the turn moved on still run against the turn they belong to.
	 */
	captureOrigin?(): unknown;
	emit(event: NestedToolExecutionEvent): Promise<void>;
}

/** Calls below one model-issued call share its recorder. */
interface CallScope {
	recorder: NestedCallRecorder;
	nextId: number;
	/** Set inside a call that holds the exclusive queue, so its own nested calls do not wait on it. */
	holdsQueue: boolean;
	/**
	 * The calling tool returned early and keeps running (a codemode script moved to the background).
	 * The scope outlives `takeRecord()` and `clear()` until `release()`, so ids keep counting and
	 * later calls and their usage keep going into the same recorder.
	 */
	detached?: boolean;
	/** Identifies the tool call (its generation) that owns a detached scope: a reused tool call id is another one. */
	token?: string | object;
	/** The result message took the record: a released scope is then dropped for good. */
	taken?: boolean;
	/** The exclusive queue the scope's calls wait on: the runner's, or the scope's own once detached. */
	queue: ExclusiveQueue;
	/** `captureOrigin()` at detach. */
	origin?: unknown;
}

interface ExclusiveQueue {
	tail: Promise<void>;
}

/** Resolves true when `previous` is over, false when `signal` aborts first. */
function waitFor(previous: Promise<void>, signal: AbortSignal | undefined): Promise<boolean> {
	if (!signal) return previous.then(() => true);
	if (signal.aborted) return Promise.resolve(false);
	return new Promise((resolve) => {
		const onAbort = () => resolve(false);
		signal.addEventListener("abort", onAbort, { once: true });
		void previous.then(() => {
			signal.removeEventListener("abort", onAbort);
			resolve(true);
		});
	});
}

const MAX_STICKY_IDS = 1000;

function textOf(result: AgentToolResult<unknown>): string {
	return (result.content ?? [])
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

export class NestedToolCallRunner {
	private readonly host: NestedToolCallHost;
	/** Scopes by the id of the calling tool call. */
	private readonly scopes = new Map<string, CallScope>();
	/** Detached scopes by the token of the tool call that owns them (the id alone can be reused by a later call). */
	private readonly detachedScopes = new Map<string | object, CallScope>();
	/** Serializes nested calls that must not run concurrently. Detached scopes use their own queue. */
	private readonly queue: ExclusiveQueue = { tail: Promise.resolve() };
	/** Last nested id number handed out below caller ids that were ever detached: later calls with that id never repeat one. */
	private readonly sticky = new Map<string, number>();

	constructor(host: NestedToolCallHost) {
		this.host = host;
	}

	/**
	 * Run `name` on behalf of the call `callerId`. The nested call gets the id `<callerId>/<n>`.
	 * Never rejects for tool failures: they come back as `isError: true`.
	 */
	async execute(
		callerId: string,
		name: string,
		args: unknown,
		options: NestedToolCallOptions = {},
		token?: string | object,
	): Promise<AgentToolCallOutcome> {
		const scope = this.scopeFor(callerId, token ?? callerId);
		const toolCall: AgentToolCall = {
			type: "toolCall",
			id: `${callerId}/${this.nextNumber(callerId, scope)}`,
			name,
			arguments: (args ?? {}) as AgentToolCall["arguments"],
		};
		const record = scope.recorder.start(toolCall);
		await this.host.emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: name,
			args: toolCall.arguments,
			parentToolCallId: callerId,
		});

		const exclusive =
			!scope.holdsQueue &&
			(this.host.isSequential() ||
				this.host.getTools().find((tool) => tool.name === name)?.executionMode === "sequential");
		let release: (() => void) | undefined;
		let acquired = true;
		if (exclusive) {
			const previous = scope.queue.tail;
			scope.queue.tail = new Promise((resolve) => {
				release = resolve;
			});
			acquired = await waitFor(previous, options.signal);
			// Aborted while waiting: leave the queue in order, without running.
			if (!acquired) {
				const free = release;
				release = undefined;
				void previous.then(() => free?.());
			}
		}
		this.scopes.set(toolCall.id, {
			recorder: scope.recorder,
			nextId: 1,
			holdsQueue: scope.holdsQueue || exclusive,
			queue: scope.queue,
			...(scope.origin === undefined ? {} : { origin: scope.origin }),
		});
		let outcome: AgentToolCallOutcome;
		try {
			outcome = acquired
				? await this.host.runToolCall(
						toolCall,
						callerId,
						options.signal,
						async (partialResult) => {
							options.onUpdate?.(partialResult);
							await this.host.emit({
								type: "tool_execution_update",
								toolCallId: toolCall.id,
								toolName: name,
								args: toolCall.arguments,
								partialResult,
								parentToolCallId: callerId,
							});
						},
						scope.origin,
					)
				: {
						toolCall,
						result: {
							content: [{ type: "text", text: "Aborted while waiting for other tool calls" }],
							details: {},
						},
						isError: true,
					};
		} finally {
			this.scopes.delete(toolCall.id);
			release?.();
		}

		scope.recorder.finish(record, outcome.isError, textOf(outcome.result));
		// Nested results are not persisted, so their usage is only counted through the recorder.
		if (outcome.result.usage) scope.recorder.addUsage(outcome.result.usage);
		await this.host.emit({
			type: "tool_execution_end",
			toolCallId: toolCall.id,
			toolName: name,
			result: outcome.result,
			isError: outcome.isError,
			...(outcome.durationMs === undefined ? {} : { durationMs: outcome.durationMs }),
			parentToolCallId: callerId,
		});
		return outcome;
	}

	/** Remove and return the record of the nested calls a model-issued call made. */
	takeRecord(toolCallId: string): NestedCallSummary | undefined {
		const scope = this.scopes.get(toolCallId);
		if (!scope) return undefined;
		// A detached scope stays reachable through its token: the calling tool is still running and makes more calls. It leaves
		// the id map, so a later call that reuses the id starts a scope of its own.
		this.scopes.delete(toolCallId);
		if (scope.detached) scope.taken = true;
		return {
			calls: scope.recorder.snapshot(),
			usage: scope.detached ? scope.recorder.takeUnreportedUsage() : scope.recorder.totalUsage,
		};
	}

	/**
	 * Keep the scope of `callerId` alive after its tool call returned early. Call it before the tool result is emitted;
	 * `release()` ends it when the tool really finishes. `token` names this tool call (default: the id): a later call that
	 * reuses the id gets a scope of its own, and the ids already handed out are never repeated.
	 */
	detach(callerId: string, token: string | object = callerId): void {
		let scope = this.scopes.get(callerId);
		if (!scope || (scope.token !== undefined && scope.token !== token)) {
			scope = this.newScope(callerId);
			this.scopes.set(callerId, scope);
		}
		scope.detached = true;
		scope.token = token;
		scope.queue = { tail: Promise.resolve() }; // its calls never wait behind (or hold up) foreground calls
		scope.origin = this.host.captureOrigin?.();
		this.detachedScopes.set(token, scope);
		this.sticky.set(callerId, Math.max(this.sticky.get(callerId) ?? 0, scope.nextId - 1));
		if (this.sticky.size > MAX_STICKY_IDS) this.sticky.delete(this.sticky.keys().next().value as string);
	}

	/**
	 * End a detached scope. Returns the calls it recorded over its whole life and the usage no result message has counted
	 * yet. Undefined when nothing is detached under `token`, or when the result message has not taken the record yet (it
	 * will then take everything).
	 */
	release(callerId: string, token: string | object = callerId): NestedCallSummary | undefined {
		const scope = this.detachedScopes.get(token);
		if (!scope) return undefined;
		this.detachedScopes.delete(token);
		scope.detached = false;
		if (!scope.taken) return undefined;
		return { calls: scope.recorder.snapshot(), usage: scope.recorder.takeUnreportedUsage() };
	}

	/** Drop every scope except those of calls running below a detached one (detached scopes are kept apart). */
	clear(): void {
		const kept = [...this.detachedScopes.values()].map((scope) => scope.recorder);
		for (const [id, scope] of [...this.scopes]) {
			if (!scope.detached && !kept.includes(scope.recorder)) this.scopes.delete(id);
		}
	}

	private newScope(callerId: string): CallScope {
		return {
			recorder: new NestedCallRecorder(),
			nextId: (this.sticky.get(callerId) ?? 0) + 1,
			holdsQueue: false,
			queue: this.queue,
		};
	}

	/** The scope for a call of `callerId` made by the tool call `token`. */
	private scopeFor(callerId: string, token: string | object): CallScope {
		const detached = this.detachedScopes.get(token);
		if (detached) return detached;
		const existing = this.scopes.get(callerId);
		if (existing && (existing.token === undefined || existing.token === token)) return existing;
		const scope = this.newScope(callerId);
		this.scopes.set(callerId, scope);
		return scope;
	}

	private nextNumber(callerId: string, scope: CallScope): number {
		if (!this.sticky.has(callerId)) return scope.nextId++;
		const next = (this.sticky.get(callerId) ?? 0) + 1;
		this.sticky.set(callerId, next);
		scope.nextId = next + 1;
		return next;
	}
}
