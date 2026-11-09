// The `pipipi` settings block (spec 3). This is a boundary: wrong types throw, naming the key.

export interface Config {
	models: Record<string, string>;
	defaultModel: string;
	toolMap: Record<string, string>;
	maxConcurrent: number;
	piCommand?: string; // unset: children run the build of this process (invocation.ts)
	childCodemode: "only" | "inherit";
	backgroundScripts: boolean; // a script that starts an Agent moves to the background
	panelLingerMs: number; // how long a finished subagent stays in the panel
}

// Claude Code model aliases -> the same-name Anthropic models. Settings override per alias.
export const DEFAULT_MODELS: Record<string, string> = {
	opus: "anthropic/claude-opus-5-5",
	sonnet: "anthropic/claude-sonnet-5-5",
	haiku: "anthropic/claude-haiku-5-5",
	fable: "anthropic/claude-fable-5-1",
};

function stringMap(value: unknown, key: string): Record<string, string> {
	if (value === undefined) return {};
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`pipipi.${key} must be an object of strings`);
	}
	for (const [k, v] of Object.entries(value)) {
		if (typeof v !== "string") throw new Error(`pipipi.${key}.${k} must be a string`);
	}
	return value as Record<string, string>;
}

function optionalString(value: unknown, key: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value === "") throw new Error(`pipipi.${key} must be a non-empty string`);
	return value;
}

export function readConfig(raw: unknown): Config {
	if (raw === undefined) raw = {};
	if (typeof raw !== "object" || raw === null || Array.isArray(raw))
		throw new Error("pipipi settings must be an object");
	const r = raw as Record<string, unknown>;

	const maxConcurrent = r.maxConcurrent ?? 20;
	if (!Number.isInteger(maxConcurrent) || (maxConcurrent as number) < 1) {
		throw new Error("pipipi.maxConcurrent must be a positive integer");
	}

	const childCodemode = r.childCodemode ?? "only";
	if (childCodemode !== "only" && childCodemode !== "inherit") {
		throw new Error(`pipipi.childCodemode must be "only" or "inherit", got ${JSON.stringify(childCodemode)}`);
	}

	const panelLingerMs = r.panelLingerMs ?? 30_000;
	if (typeof panelLingerMs !== "number" || !(panelLingerMs >= 0))
		throw new Error("pipipi.panelLingerMs must be a number of milliseconds, 0 or more");

	const backgroundScripts = r.backgroundScripts ?? true;
	if (typeof backgroundScripts !== "boolean")
		throw new Error(`pipipi.backgroundScripts must be true or false, got ${JSON.stringify(backgroundScripts)}`);

	return {
		panelLingerMs,
		backgroundScripts,
		models: { ...DEFAULT_MODELS, ...stringMap(r.models, "models") },
		defaultModel: optionalString(r.defaultModel, "defaultModel") ?? "haiku",
		toolMap: stringMap(r.toolMap, "toolMap"),
		maxConcurrent: maxConcurrent as number,
		piCommand: optionalString(r.piCommand, "piCommand"),
		childCodemode,
	};
}
