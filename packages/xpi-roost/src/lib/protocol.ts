import { StringDecoder } from "node:string_decoder";
import type { ContextInfo, JobRow, OpArgs, OpResults, ReplyMode } from "./protocol-schema.ts";

// The ops' arguments and results, and the types of their parts, are schemas
// (protocol-schema.ts); the types are derived from them and re-exported here.
export type {
	ContextInfo,
	DaemonStatus,
	DispatchArgs,
	DispatchOrigin,
	HelloArgs,
	HelloResult,
	JobRow,
	JobStateName,
	JobStatus,
	OpArgs,
	OpResults,
	ReplyMode,
	WaitingFor,
	WorkerReport,
} from "./protocol-schema.ts";
export { ArgSchemas, OPS, ResultSchemas } from "./protocol-schema.ts";

/** M31: the protocol version this daemon and these clients speak (docs/protocol.md). */
export const PROTOCOL_VERSION = 1;

/**
 * M31: what an agent can do, said in its hello. Unknown ones are ignored; the list only
 * grows with a protocol version.
 */
export const AGENT_CAPABILITIES = [
	"report",
	"replies",
	"steer",
	"usage",
	"context",
	"model-switch",
	"transcript",
] as const;
export type AgentCapability = (typeof AGENT_CAPABILITIES)[number];

/** M31: what the daemon offers agents beyond report, ack and hello (its hello answers with it). */
export const DAEMON_CAPABILITIES = ["replies", "steer", "events"] as const;
export type DaemonCapability = (typeof DAEMON_CAPABILITIES)[number];

export type Op = keyof OpArgs;

export type RequestOf<O extends Op> = { id: number; op: O; args?: OpArgs[O] };
export type Request = { [O in Op]: RequestOf<O> }[Op];
export type ArgsOf<O extends Op> = OpArgs[O];
export type ResultOf<O extends Op> = OpResults[O];

export type OkResponse<O extends Op = Op> = { id: number; ok: true; result: OpResults[O] };
export type ErrResponse = { id: number; ok: false; error: string; code?: string };
export type Response<O extends Op = Op> = OkResponse<O> | ErrResponse;

export type Event =
	| { event: "job"; job: JobRow }
	| { event: "removed"; id: string }
	/** Daemon → worker, on the connection the worker reports on: a user's reply. */
	| {
			event: "deliver";
			id: string;
			seq: number;
			text: string;
			/** M28: how a user reply joins a running turn. */
			mode?: ReplyMode;
	  };

/** A ContextInfo from untrusted JSON (a report, state.json), or null. */
export function contextFrom(v: unknown): ContextInfo | null {
	if (!v || typeof v !== "object") return null;
	const o = v as Record<string, unknown>;
	const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : null);
	const raw = num(o.window);
	const window = raw === null ? 0 : Math.round(raw);
	if (window <= 0) return null;
	const tokens = num(o.tokens);
	const percent = num(o.percent);
	return {
		tokens: tokens === null ? null : Math.round(tokens),
		window,
		percent: percent === null ? null : Math.min(percent, 999),
	};
}

/** M49: a line longer than this (in characters) is not a message of this protocol: the reader gives the stream up. */
export const LINE_MAX = 64 * 1024 * 1024;

export class LineTooLong extends Error {
	constructor(max: number) {
		super(`a line longer than ${max} characters`);
		this.name = "LineTooLong";
	}
}

/**
 * Splits a stream into lines. Only what just arrived is scanned for newlines (a long
 * line in progress is not read again on every chunk). A line past `max` throws
 * LineTooLong once; after that the reader takes nothing more.
 */
export class LineReader {
	private decoder = new StringDecoder("utf8");
	private partial = "";
	private dead = false;
	private readonly max: number;

	constructor(max = LINE_MAX) {
		this.max = max;
	}

	push(chunk: Buffer | string): string[] {
		if (this.dead) return [];
		const text = typeof chunk === "string" ? chunk : this.decoder.write(chunk);
		const lines: string[] = [];
		let start = 0;
		for (;;) {
			const nl = text.indexOf("\n", start);
			if (nl < 0) break;
			const line = this.partial + text.slice(start, nl);
			this.partial = "";
			start = nl + 1;
			if (line.length > this.max) return this.giveUp();
			lines.push(line);
		}
		this.partial += text.slice(start);
		if (this.partial.length > this.max) return this.giveUp();
		return lines;
	}

	private giveUp(): never {
		this.dead = true;
		this.partial = "";
		throw new LineTooLong(this.max);
	}
}

export function encodeLine(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
}
