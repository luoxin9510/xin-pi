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
	};
}

/** Split "provider/model" at the first slash: model ids may contain slashes. */
export function splitModelRef(ref: string): { provider: string; id: string } {
	const slash = ref.indexOf("/");
	return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
}
