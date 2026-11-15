// What relay needs of its host, and what one handler call carries. The built-in in the coding agent implements these on
// its extension API; porting relay to another host is implementing them. See README.md.

import type { TSchema } from "typebox";
import type { AgentMessage } from "xpi-agent-core";
import type { Api, Message, Model, ModelThinkingLevel, ToolResultSignal } from "xpi-ai";
import type { RelayEntry } from "./entry.ts";
import type { RelayState } from "./router.ts";

export type NoticeLevel = "info" | "warning" | "error";

/** What a hand tool's `execute` returns to the host: the result text, and whether it ends the turn. Errors are thrown. */
export interface ToolOutcome {
	text: string;
	/** The result ends the script and the turn. */
	terminate?: boolean;
	/**
	 * Machine-readable signal of the call (a handover is `relay.handover` with its round). The host must put it on the
	 * tool result message, where the router reads it; it is never shown to the model.
	 */
	signal?: ToolResultSignal;
}

/** A tool the host registers for relay. */
export interface ToolSpec {
	name: string;
	label: string;
	description: string;
	parameters: TSchema;
	effect: "write";
	/** `direct`: the model calls it as a tool; `deferred`: only a codemode script reaches it. */
	exposure: "direct" | "deferred";
	/** Whether the tool is listed in the prompt's tool list. */
	listed: boolean;
	/** Whether the tool is active by default. */
	defaultActive: boolean;
	/** Run the tool. The host builds the call from its own context. Throws for an error result. */
	execute(params: unknown, signal: AbortSignal | undefined, call: RelayCall): Promise<ToolOutcome>;
}

/** What relay is for the lifetime of the host's extension. */
export interface RelayHost {
	/** Append a custom entry to the session branch. */
	appendEntry(type: string, data: unknown): void;
	/** The `relay` block of the settings, read at each use. */
	settings(): unknown;
	/** `compaction.keepRecentTokens` as resolved for the relay model, read at each use. */
	keepRecentTokens(): number;
	/** `/handover` and `/handback`: a message for the model. */
	sendMessage(
		message: { customType: string; content: string; display: boolean },
		options: { triggerTurn: boolean; deliverAs?: "steer" },
	): void;
	activeTools(): string[];
	setActiveTools(names: string[]): void;
	/** Called at the start and again when the exposure changes (codemode switched on or off). */
	registerTools(specs: ToolSpec[]): void;
}

/** One handler call. The getters are read at each use: the branch can grow while a call is awaiting. */
export interface RelayCall {
	/** The session branch. */
	readonly entries: readonly RelayEntry[];
	/** The selected model, for "is relay selected". */
	readonly model: { provider: string; id: string } | undefined;
	readonly cwd: string;
	readonly signal: AbortSignal | undefined;
	/** The catalog's full model for a `provider/model` reference. */
	findModel(ref: string): Model<Api> | undefined;
	/** A line for the user: a notification in the UI, stderr in print mode with --verbose. Never a message. */
	notify(text: string, level?: NoticeLevel): void;
	isIdle(): boolean;
}

export interface RelayRouteRequest {
	reason: "user" | "continuation" | "retry" | "direct";
	/** The router state last stored on this branch. */
	state?: RelayState;
	messages: readonly Message[];
}

export interface RelayRoute {
	model: Model<Api>;
	thinkingLevel: ModelThinkingLevel;
	state?: RelayState;
	/** Prompt tokens the request's context should stay under; absent when the phase has no limit (off, or lifted). */
	contextLimit?: number;
}

/** What relay reads of the host's `request_start` event: the router states around one request. */
export interface RelayRequestStart {
	/** The state stored for this request. */
	routerState?: unknown;
	/** The state stored before it. */
	previousRouterState?: unknown;
}

/** What relay reads of the end of a run. */
export interface SettleEvent {
	outcome: string;
	/** The messages of the context that is settled, oldest first. */
	contextMessages: readonly AgentMessage[];
}

/** An entry relay asks the host to write at the end of a run. */
export type RelayDraft =
	| { type: "custom"; customType: string; data?: unknown }
	| { type: "custom_message"; customType: string; display: boolean; content: string }
	| { type: "compaction"; summary: string; firstKeptEntryId: null; details: { relay: true; round: number } };

export interface SettleResult {
	/** Entries to write after the ones other handlers drafted. */
	entries: RelayDraft[];
	/** False when there are entries to write but the run ends, as after a voided handover. */
	continue: boolean;
}

/** The `relay` section of the system prompt: `text` undefined means no section. */
export interface RelaySection {
	text: string | undefined;
}

export interface HandoverParams {
	plan: string;
	acceptance?: string[];
	criteria?: string;
	findings?: string;
	stopWhen?: string;
}

export interface HandbackParams {
	status: "done" | "blocked";
	report: string;
}

export interface CommandStatus {
	text: string;
	level: "info" | "error";
}
