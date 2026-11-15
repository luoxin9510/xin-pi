// The context limit of a role: what the settings say, read against the model catalog. See docs/relay.md.

import type { Model } from "xpi-ai";
import type { ContextConfig } from "./config.ts";

/** What a compaction needs beyond `compaction.keepRecentTokens`: the system prompt, the summary and the next turn. */
export const LIMIT_ROOM = 20_000;

type Tiered = Pick<Model<string>, "cost"> | undefined;

/** The lowest `inputTokensAbove` of a model's price tiers (the catalog promises no order); undefined without tiers. */
export function firstTier(model: Tiered): number | undefined {
	const tiers = model?.cost?.tiers ?? [];
	return tiers.length > 0 ? Math.min(...tiers.map((tier) => tier.inputTokensAbove)) : undefined;
}

/**
 * The limit in prompt tokens for a model, or undefined for no limit: `"off"`, a model without tiers or outside the
 * catalog under `"tier"`. A limit a compaction cannot get under (below `keepRecentTokens` plus room) is an error that
 * names the key.
 */
export function contextLimitOf(
	config: ContextConfig,
	key: "workerContext" | "leadContext",
	model: Tiered,
	keepRecentTokens: number,
): number | undefined {
	if (config.limit === "off") return undefined;
	let limit: number;
	let source: string;
	if (config.limit === "tier") {
		const tier = firstTier(model);
		if (tier === undefined) return undefined;
		limit = Math.floor(tier * config.tierFraction);
		source = `relay.${key}.tierFraction ${config.tierFraction} of the first price tier (${tier} tokens), set by relay.${key}.limit "tier"`;
	} else {
		limit = config.limit;
		source = `relay.${key}.limit`;
	}
	const minimum = keepRecentTokens + LIMIT_ROOM;
	if (limit < minimum) {
		throw new Error(
			`${source} gives a context limit of ${limit} tokens, below the minimum of ${minimum} (compaction.keepRecentTokens ${keepRecentTokens} + ${LIMIT_ROOM}): a compaction could not get under it`,
		);
	}
	return limit;
}
