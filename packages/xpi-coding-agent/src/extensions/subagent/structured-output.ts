// Structured output: an `Agent` call with `schema` gets the child's result as a value that matches the schema.
//
// Parent side: `checkSchema` rejects a schema the child could not use. Child side: `registerStructuredOutput` adds the
// `StructuredOutput` tool whose parameters are the schema. pi validates its arguments like any tool's, so an invalid call
// goes back to the model as the tool's error and the model tries again within its own run. A valid call ends the run
// (`terminate`), and the parent's runner reads the accepted arguments from the child's event stream (runner.ts).

import { readFileSync } from "node:fs";
import { validateToolArguments } from "xpi-ai";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { STRUCTURED_OUTPUT_TOOL } from "./resolve.ts";

// The child finds the schema here (a file the runner writes next to the system prompt files).
export const SCHEMA_FILE_ENV = "XPI_SUBAGENT_SCHEMA_FILE";

// Invalid StructuredOutput calls a child may make before the call fails.
export const MAX_STRUCTURED_ATTEMPTS = 5;

// Sent once when the child ended its run without calling the tool.
export const STRUCTURED_REMINDER = `Call ${STRUCTURED_OUTPUT_TOOL} now with your result.`;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// Throws when `schema` cannot be a tool's parameters, so the call fails before a child starts instead of after five
// attempts no value could pass. pi's validator accepts almost any schema (it must take MCP servers' schemas), so the
// top level is checked here: an object with `type: "object"`, `properties` an object of schemas, `required` a list of
// names, and no required name that `additionalProperties: false` rules out. Nested schemas are left to the validator.
export function checkSchema(schema: unknown): asserts schema is Record<string, unknown> {
	if (!isObject(schema)) throw new Error("schema must be a JSON Schema object");
	if (schema.type !== "object") throw new Error('schema must have type "object" at the top');
	const { properties, required, additionalProperties } = schema;
	if (properties !== undefined && (!isObject(properties) || !Object.values(properties).every(isObject))) {
		throw new Error("schema.properties must be an object of schemas");
	}
	if (required !== undefined && (!Array.isArray(required) || !required.every((r) => typeof r === "string"))) {
		throw new Error("schema.required must be a list of property names");
	}
	if (additionalProperties === false) {
		const missing = ((required as string[] | undefined) ?? []).filter((r) => !(properties && r in properties));
		if (missing.length > 0) {
			throw new Error(
				`schema requires ${missing.map((m) => `"${m}"`).join(", ")}, which additionalProperties: false rules out`,
			);
		}
	}
	try {
		validateToolArguments(
			{ name: STRUCTURED_OUTPUT_TOOL, description: "", parameters: schema as never },
			{ type: "toolCall", id: "check", name: STRUCTURED_OUTPUT_TOOL, arguments: {} },
		);
	} catch (err) {
		// An empty object failing validation means the schema compiled.
		if ((err as Error).message.startsWith("Validation failed")) return;
		throw new Error(`schema does not compile: ${(err as Error).message}`);
	}
}

// In the child (XPI_SUBAGENT_DEPTH set): the tool, when the parent passed a schema. `model-only`: the model calls it
// directly, also when it sees only `codemode`, so the final call is a plain tool call in the event stream.
export function registerStructuredOutput(pi: ExtensionAPI): void {
	const file = process.env[SCHEMA_FILE_ENV];
	if (!file) return;
	const schema = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
	pi.registerTool({
		name: STRUCTURED_OUTPUT_TOOL,
		label: STRUCTURED_OUTPUT_TOOL,
		effect: "read",
		description:
			"Return your final result. Call it exactly once, as your last action, with the result as its arguments.",
		parameters: schema as never,
		exposure: "model-only",
		async execute(_id, params) {
			return {
				content: [{ type: "text", text: "Result accepted." }],
				details: params as never,
				terminate: true,
			};
		},
	});
}
