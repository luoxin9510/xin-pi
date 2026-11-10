// What the lead is told. No rule says when to hand over: the lead gets the objective, the facts a decision needs
// (who the worker is, what each side's tokens cost, what a handover does and what comes back, how long things took)
// and decides. The facts are computed from the model catalog and the session, so they stay true when the models
// change.

import type { AssistantMessage, Model } from "xpi-ai";
import type { SessionEntry } from "../../core/session-manager.ts";
import type { RelayConfig } from "./config.ts";
import { HANDBACK_TOOL, HANDOVER_TOOL } from "./router.ts";

type Priced = Pick<Model<string>, "cost"> | undefined;
type Cost = Model<string>["cost"];

const dollars = (value: number) => `$${Number(value.toFixed(4))}`;

function ratio(lead: number | undefined, worker: number | undefined): string | undefined {
	if (!lead || !worker) return undefined;
	const value = lead / worker;
	return value >= 10 ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, "");
}

function priceList(cost: Pick<Cost, "input" | "output" | "cacheRead" | "cacheWrite">): string {
	return `input ${dollars(cost.input)}, cached input ${dollars(cost.cacheRead)}, cache write ${dollars(cost.cacheWrite)}, output ${dollars(cost.output)}`;
}

function describePrices(cost: Cost): string {
	const tiers = (cost.tiers ?? []).map(
		(tier) => `; with more than ${tier.inputTokensAbove.toLocaleString("en-US")} prompt tokens: ${priceList(tier)}`,
	);
	return `${priceList(cost)}${tiers.join("")}`;
}

/**
 * The catalog's list prices of both models, per million tokens, and how they compare. Undefined when a price is not
 * known (a local model, a model outside the catalog).
 */
export function priceFact(lead: Priced, worker: Priced): string | undefined {
	const input = ratio(lead?.cost.input, worker?.cost.input);
	const output = ratio(lead?.cost.output, worker?.cost.output);
	if (!lead || !worker || !input || !output) return undefined;
	return `API list prices per million tokens. You: ${describePrices(lead.cost)}. The worker: ${describePrices(worker.cost)}. At the base prices one of your input tokens costs ${input} times a worker input token, one of your output tokens ${output} times a worker output token`;
}

/** The objective, with the price of the user's time when one is set. */
export function objectiveFact(config: RelayConfig): string {
	if (config.minuteCost === undefined) return config.objective;
	return `${config.objective} The user's waiting time counts as well: one minute of wall-clock time is worth ${dollars(config.minuteCost)} of tokens to the user.`;
}

/** The lead's part of the system prompt while the relay model is selected. Every line names the tool it is about. */
export function leadFacts(config: RelayConfig, lead: Priced, worker: Priced): string[] {
	const price = priceFact(lead, worker);
	const charged = `What you read and write is charged at your prices; what the worker reads and writes after ${HANDOVER_TOOL} is charged at its prices.`;
	const lines = [
		`Relay mode. You are the lead model (${config.lead}). A second model, the worker (${config.worker}), can take over this conversation when you call ${HANDOVER_TOOL}. Whether and when to call ${HANDOVER_TOOL} is your decision; nothing requires it.`,
		`Relay objective: ${objectiveFact(config)}`,
		price ? `Relay prices: ${price}. ${charged}` : `Relay prices: not known for this pair of models. ${charged}`,
		`What ${HANDOVER_TOOL} does: the worker continues from this exact conversation and reads all of it, so nothing is lost in a brief. It works until it calls ${HANDBACK_TOOL} or stops. The acceptance commands you gave are then run; when one fails, its output goes back to the worker, at most ${config.maxRounds} time(s).`,
		`What you get back after ${HANDOVER_TOOL}: this conversation is replaced by a record. Kept as written: the user's messages, your replies to the user, your handover note. New: the worker's report, the diff since the handover, the acceptance output. Not kept: the worker's own steps, and the tool output you read before the handover (what you need from it belongs in the note's findings).`,
		`Time with ${HANDOVER_TOOL}: a round adds the worker's first read of the conversation, its work, the acceptance commands, and your reading of the record. Each hand back reports how long the round took and how fast each model has been in this session.`,
		`After a hand back nothing is final: you can read files, change them yourself, or call ${HANDOVER_TOOL} again.`,
	];
	if (config.workerRecord) lines.push(`About the worker, for your ${HANDOVER_TOOL} decision: ${config.workerRecord}`);
	return lines;
}

interface Spend {
	requests: number;
	fresh: number; // input and cache write
	cacheRead: number;
	output: number;
	cost: number;
	ms: number; // time spent in requests
	timedOutput: number; // output tokens of the requests whose duration is known
}

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export function clock(ms: number): string {
	const seconds = Math.round(ms / 1000);
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

function describeSpend(spend: Spend): string {
	const cost = spend.cost > 0 ? `, $${spend.cost.toFixed(spend.cost < 1 ? 3 : 2)}` : "";
	const speed =
		spend.ms >= 1000
			? `, ${clock(spend.ms)} in requests (${Math.round(spend.timedOutput / (spend.ms / 1000))} output tokens/s)`
			: "";
	return `${spend.requests} request(s), ${k(spend.fresh)} input and cache-write tokens, ${k(spend.cacheRead)} cache-read, ${k(spend.output)} output${cost}${speed}`;
}

/**
 * What each role has used on this branch so far, in tokens, cost and time, read from the responses. When both roles
 * are the same model the split is not known and one line is given.
 */
export function spendFact(branch: readonly SessionEntry[], config: RelayConfig): string {
	const byModel = new Map<string, Spend>();
	for (const entry of branch) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const message = entry.message as AssistantMessage;
		if (!message.usage) continue;
		const key = `${message.provider}/${message.model}`;
		const spend = byModel.get(key) ?? {
			requests: 0,
			fresh: 0,
			cacheRead: 0,
			output: 0,
			cost: 0,
			ms: 0,
			timedOutput: 0,
		};
		spend.requests++;
		spend.fresh += message.usage.input + message.usage.cacheWrite;
		spend.cacheRead += message.usage.cacheRead;
		spend.output += message.usage.output;
		spend.cost += message.usage.cost?.total ?? 0;
		if (message.durationMs) {
			spend.ms += message.durationMs;
			spend.timedOutput += message.usage.output;
		}
		byModel.set(key, spend);
	}
	const lead = byModel.get(config.lead);
	const worker = byModel.get(config.worker);
	if (config.lead === config.worker) return lead ? `Used so far in this session: ${describeSpend(lead)}.` : "";
	const parts = [
		lead && `you (the lead) ${describeSpend(lead)}`,
		worker && `the worker ${describeSpend(worker)}`,
	].filter(Boolean);
	return parts.length > 0 ? `Used so far in this session: ${parts.join("; ")}.` : "";
}

/** How long a round took from the handover to the hand back, and how much of it the acceptance commands took. */
export function roundTimeFact(
	round: number,
	startedAt: number | undefined,
	acceptanceMs: number,
	now = Date.now(),
): string {
	if (!startedAt || now <= startedAt) return "";
	const acceptance = acceptanceMs >= 1000 ? `, ${clock(acceptanceMs)} of it in the acceptance commands` : "";
	return `Round ${round} took ${clock(now - startedAt)} from the handover to this hand back${acceptance}.`;
}
