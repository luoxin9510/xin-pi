// The `relay` settings block. This is a boundary: wrong types throw, naming the key.

import type { ModelThinkingLevel } from "xpi-ai";

export interface RelayConfig {
	lead: string; // "provider/model": explores, plans, reviews
	worker: string; // "provider/model": carries the plan out
	leadThinking: { plan: ModelThinkingLevel; review: ModelThinkingLevel };
	workerThinking: ModelThinkingLevel;
	maxRounds: number; // times failed acceptance commands go back to the worker before the lead is woken
	acceptanceTimeoutMs: number; // per acceptance command
	diffChars: number; // how much of the diff goes into the hand-back record
	objective: string; // what the user optimizes for; the lead decides with it
	workerRecord?: string; // what is known about the worker's ability, told to the lead
	minuteCost?: number; // what a minute of the user's waiting is worth, in dollars of tokens; unset: time is not counted
}

export const DEFAULT_OBJECTIVE =
	"the user wants a correct result for as few of your (lead) tokens as possible. Worker tokens are not counted.";

function text(value: unknown, key: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.trim() === "") throw new Error(`relay.${key} must be a non-empty string`);
	return value.trim();
}

export const DEFAULT_LEAD = "anthropic/claude-opus-5-5";
export const DEFAULT_WORKER = "anthropic/claude-haiku-5-5";

const LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function modelRef(value: unknown, key: string, fallback: string): string {
	if (value === undefined) return fallback;
	if (typeof value !== "string" || !/^[^/\s]+\/\S+$/.test(value)) {
		throw new Error(`relay.${key} must be "provider/model", got ${JSON.stringify(value)}`);
	}
	return value;
}

function level(value: unknown, key: string, fallback: ModelThinkingLevel): ModelThinkingLevel {
	if (value === undefined) return fallback;
	if (!LEVELS.includes(value as ModelThinkingLevel)) {
		throw new Error(`relay.${key} must be one of ${LEVELS.join(", ")}, got ${JSON.stringify(value)}`);
	}
	return value as ModelThinkingLevel;
}

function count(value: unknown, key: string, fallback: number, min: number): number {
	if (value === undefined) return fallback;
	if (!Number.isInteger(value) || (value as number) < min) {
		throw new Error(`relay.${key} must be an integer, ${min} or more`);
	}
	return value as number;
}

function minuteCost(value: unknown): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new Error("relay.minuteCost must be a number of dollars, 0 or more");
	}
	return value;
}

export function readRelayConfig(raw: unknown): RelayConfig {
	if (raw === undefined) raw = {};
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new Error("relay settings must be an object");
	}
	const r = raw as Record<string, unknown>;
	const thinking = r.leadThinking ?? {};
	if (typeof thinking !== "object" || thinking === null || Array.isArray(thinking)) {
		throw new Error("relay.leadThinking must be an object with plan and review");
	}
	const t = thinking as Record<string, unknown>;
	return {
		lead: modelRef(r.lead, "lead", DEFAULT_LEAD),
		worker: modelRef(r.worker, "worker", DEFAULT_WORKER),
		leadThinking: {
			plan: level(t.plan, "leadThinking.plan", "high"),
			review: level(t.review, "leadThinking.review", "medium"),
		},
		workerThinking: level(r.workerThinking, "workerThinking", "medium"),
		maxRounds: count(r.maxRounds, "maxRounds", 3, 0),
		acceptanceTimeoutMs: count(r.acceptanceTimeoutMs, "acceptanceTimeoutMs", 600_000, 1000),
		diffChars: count(r.diffChars, "diffChars", 20_000, 0),
		objective: text(r.objective, "objective") ?? DEFAULT_OBJECTIVE,
		workerRecord: text(r.workerRecord, "workerRecord"),
		minuteCost: minuteCost(r.minuteCost),
	};
}

/** Split "provider/model" at the first slash: model ids may contain slashes. */
export function splitModelRef(ref: string): { provider: string; id: string } {
	const slash = ref.indexOf("/");
	return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
}
