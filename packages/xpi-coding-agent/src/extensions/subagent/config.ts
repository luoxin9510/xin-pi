// The `subagent` settings block (spec 3). This is a boundary: wrong types throw, naming the key.

export interface Config {
	models: Record<string, string>;
	defaultModel: string;
	toolMap: Record<string, string>;
	maxConcurrent: number;
	maxAgentsPerScript: number; // agents one script run may start; the next Agent call throws
	piCommand?: string; // unset: children run the build of this process (invocation.ts)
	childCodemode: "only" | "inherit";
	backgroundScripts: boolean; // a script that starts an Agent moves to the background
	fork: boolean; // the "fork" agent type and /subtask
	staggerStart: boolean; // siblings with the same prompt prefix wait for the first one's response to begin (stagger.ts)
	shutdownGraceMs: number; // how long a stopped child may take to shut down (SIGTERM) before SIGKILL
	panelLingerMs: number; // how long a finished subagent stays in the panel
}

// Claude Code model aliases -> the same-name Anthropic models. Settings override per alias.
export const DEFAULT_MODELS: Record<string, string> = {
	opus: "anthropic/claude-opus-5-5",
	sonnet: "anthropic/claude-sonnet-5-5",
	haiku: "anthropic/claude-haiku-5-5",
	fable: "anthropic/claude-fable-5-1",
};

function stringMap(value: unknown, key: string, prefix = "subagent."): Record<string, string> {
	if (value === undefined) return {};
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${prefix}${key} must be an object of strings`);
	}
	for (const [k, v] of Object.entries(value)) {
		if (typeof v !== "string") throw new Error(`${prefix}${key}.${k} must be a string`);
	}
	return value as Record<string, string>;
}

function optionalString(value: unknown, key: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value === "") throw new Error(`subagent.${key} must be a non-empty string`);
	return value;
}

// `sharedModels` is the top-level `models` setting (alias to model reference), shared with ctx.complete. Alias lookup
// order: `subagent.models`, then `models`, then the built-in aliases.
export function readConfig(raw: unknown, sharedModels?: unknown): Config {
	if (raw === undefined) raw = {};
	if (typeof raw !== "object" || raw === null || Array.isArray(raw))
		throw new Error("subagent settings must be an object");
	const r = raw as Record<string, unknown>;

	const maxConcurrent = r.maxConcurrent ?? 20;
	if (!Number.isInteger(maxConcurrent) || (maxConcurrent as number) < 1) {
		throw new Error("subagent.maxConcurrent must be a positive integer");
	}

	const maxAgentsPerScript = r.maxAgentsPerScript ?? 1000;
	if (!Number.isInteger(maxAgentsPerScript) || (maxAgentsPerScript as number) < 1) {
		throw new Error("subagent.maxAgentsPerScript must be a positive integer");
	}

	const childCodemode = r.childCodemode ?? "only";
	if (childCodemode !== "only" && childCodemode !== "inherit") {
		throw new Error(`subagent.childCodemode must be "only" or "inherit", got ${JSON.stringify(childCodemode)}`);
	}

	const panelLingerMs = r.panelLingerMs ?? 30_000;
	if (typeof panelLingerMs !== "number" || !(panelLingerMs >= 0))
		throw new Error("subagent.panelLingerMs must be a number of milliseconds, 0 or more");

	const shutdownGraceMs = r.shutdownGraceMs ?? 10_000;
	if (typeof shutdownGraceMs !== "number" || !Number.isFinite(shutdownGraceMs) || shutdownGraceMs < 0)
		throw new Error("subagent.shutdownGraceMs must be a number of milliseconds, 0 or more");

	const backgroundScripts = r.backgroundScripts ?? true;
	if (typeof backgroundScripts !== "boolean")
		throw new Error(`subagent.backgroundScripts must be true or false, got ${JSON.stringify(backgroundScripts)}`);

	const fork = r.fork ?? true;
	if (typeof fork !== "boolean") throw new Error(`subagent.fork must be true or false, got ${JSON.stringify(fork)}`);

	const staggerStart = r.staggerStart ?? false;
	if (typeof staggerStart !== "boolean")
		throw new Error(`subagent.staggerStart must be true or false, got ${JSON.stringify(staggerStart)}`);

	return {
		panelLingerMs,
		shutdownGraceMs,
		backgroundScripts,
		staggerStart,
		fork,
		models: { ...DEFAULT_MODELS, ...stringMap(sharedModels, "models", ""), ...stringMap(r.models, "models") },
		defaultModel: optionalString(r.defaultModel, "defaultModel") ?? "haiku",
		toolMap: stringMap(r.toolMap, "toolMap"),
		maxConcurrent: maxConcurrent as number,
		maxAgentsPerScript: maxAgentsPerScript as number,
		piCommand: optionalString(r.piCommand, "piCommand"),
		childCodemode,
	};
}
