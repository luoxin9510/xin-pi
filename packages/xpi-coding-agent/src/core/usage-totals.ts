import type { ModelUsage, Usage } from "xpi-ai";
import type { SessionEntry } from "./session-manager.ts";

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export function createUsageTotals(): UsageTotals {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
	};
}

export function addUsageToTotals(totals: UsageTotals, usage: Usage): void {
	totals.input += usage.input;
	totals.output += usage.output;
	totals.cacheRead += usage.cacheRead;
	totals.cacheWrite += usage.cacheWrite;
	totals.cost += usage.cost.total;
}

/** Sum of two usages, keeping the optional token splits when either side reports them. */
export function combineUsage(first: Usage, second: Usage): Usage {
	return {
		input: first.input + second.input,
		output: first.output + second.output,
		cacheRead: first.cacheRead + second.cacheRead,
		cacheWrite: first.cacheWrite + second.cacheWrite,
		...(first.cacheWrite1h !== undefined || second.cacheWrite1h !== undefined
			? { cacheWrite1h: (first.cacheWrite1h ?? 0) + (second.cacheWrite1h ?? 0) }
			: {}),
		...(first.reasoning !== undefined || second.reasoning !== undefined
			? { reasoning: (first.reasoning ?? 0) + (second.reasoning ?? 0) }
			: {}),
		totalTokens: first.totalTokens + second.totalTokens,
		cost: {
			input: first.cost.input + second.cost.input,
			output: first.cost.output + second.cost.output,
			cacheRead: first.cost.cacheRead + second.cost.cacheRead,
			cacheWrite: first.cost.cacheWrite + second.cost.cacheWrite,
			total: first.cost.total + second.cost.total,
			// A sum is provider-reported only when every part is.
			totalFromProvider: first.cost.totalFromProvider === true && second.cost.totalFromProvider === true,
		},
	};
}

/** `provider`/`model` of a usage entry that holds nested usage no model could be named for. */
export const UNATTRIBUTED_PROVIDER = "unknown";
export const UNATTRIBUTED_MODEL = "unattributed";

/** Both lists merged, usage of the same model summed. Undefined when both are empty. */
export function mergeModelUsage(
	first: readonly ModelUsage[] | undefined,
	second: readonly ModelUsage[] | undefined,
): ModelUsage[] | undefined {
	const merged: ModelUsage[] = [];
	for (const part of [...(first ?? []), ...(second ?? [])]) {
		const same = merged.find((known) => known.provider === part.provider && known.model === part.model);
		if (same) same.usage = combineUsage(same.usage, part.usage);
		else merged.push({ ...part });
	}
	return merged.length > 0 ? merged : undefined;
}

/** `usage` less the attributed parts: what no model is named for. Undefined when nothing is left. */
export function unattributedUsage(usage: Usage, byModel: readonly ModelUsage[] | undefined): Usage | undefined {
	const left: Usage = {
		...usage,
		cost: { ...usage.cost },
	};
	for (const part of byModel ?? []) {
		left.input -= part.usage.input;
		left.output -= part.usage.output;
		left.cacheRead -= part.usage.cacheRead;
		left.cacheWrite -= part.usage.cacheWrite;
		left.totalTokens -= part.usage.totalTokens;
		left.cost.input -= part.usage.cost.input;
		left.cost.output -= part.usage.cost.output;
		left.cost.cacheRead -= part.usage.cost.cacheRead;
		left.cost.cacheWrite -= part.usage.cost.cacheWrite;
		left.cost.total -= part.usage.cost.total;
	}
	// Rounding of summed floats: a cent's fraction of a millionth is nothing.
	const clamp = (value: number) => (value > 1e-9 ? value : 0);
	left.input = clamp(left.input);
	left.output = clamp(left.output);
	left.cacheRead = clamp(left.cacheRead);
	left.cacheWrite = clamp(left.cacheWrite);
	left.totalTokens = clamp(left.totalTokens);
	left.cost = {
		...left.cost,
		input: clamp(left.cost.input),
		output: clamp(left.cost.output),
		cacheRead: clamp(left.cost.cacheRead),
		cacheWrite: clamp(left.cost.cacheWrite),
		total: clamp(left.cost.total),
	};
	delete left.cacheWrite1h;
	delete left.reasoning;
	const empty = left.input + left.output + left.cacheRead + left.cacheWrite === 0 && left.cost.total === 0;
	return empty ? undefined : left;
}

export interface UsageCostBreakdownEntry {
	key: string;
	cost: number;
	tokens: number;
}

/** Group model-attributed usage by model and all other usage into a separate bucket. */
export function getUsageCostBreakdown(entries: SessionEntry[]): UsageCostBreakdownEntry[] {
	const totalsByKey = new Map<string, UsageTotals>();
	const count = (key: string, usage: Usage | undefined) => {
		if (!usage) return;
		let totals = totalsByKey.get(key);
		if (!totals) {
			totals = createUsageTotals();
			totalsByKey.set(key, totals);
		}
		addUsageToTotals(totals, usage);
	};

	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			count(`${entry.message.provider}/${entry.message.responseModel ?? entry.message.model}`, entry.message.usage);
		} else if (entry.type === "usage") {
			const unattributed = entry.provider === UNATTRIBUTED_PROVIDER && entry.model === UNATTRIBUTED_MODEL;
			count(unattributed ? "Tools/unattributed" : `${entry.provider}/${entry.model}`, entry.usage);
		} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
			// A tool's usage under the models that spent it; what it cannot name, apart.
			const byModel = entry.message.usageByModel;
			for (const part of byModel ?? []) count(`${part.provider}/${part.model}`, part.usage);
			count("Tools/unattributed", unattributedUsage(entry.message.usage, byModel));
		} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
			count("Tools/summaries", entry.usage);
		}
	}

	return Array.from(totalsByKey, ([key, totals]) => ({
		key,
		cost: totals.cost,
		tokens: totals.input + totals.output + totals.cacheRead + totals.cacheWrite,
	}))
		.filter((entry) => entry.cost > 0 || entry.tokens > 0)
		.sort((a, b) => b.cost - a.cost);
}
