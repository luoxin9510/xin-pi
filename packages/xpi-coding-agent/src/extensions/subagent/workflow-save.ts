// Saving a script as a workflow (`s` on a script row in the panel): the script's source, from the codemode call in the
// session that started it, goes to `<name>.js` with a `meta` statement in front, in the project or the user's dir.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseCodemodeSource } from "xpi-codemode";
import { getAgentDir } from "../../config.ts";
import type { ExtensionContext } from "../../core/extensions/types.ts";
import type { ScriptRecord } from "./background.ts";
import { parseWorkflow, WORKFLOW_NAME } from "./workflows.ts";

// The code of the codemode call `callId` on the session's branch, without its `// @options` line.
export function scriptSource(ctx: ExtensionContext, callId: string): string | undefined {
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		for (const part of entry.message.content) {
			if (part.type !== "toolCall" || part.id !== callId) continue;
			const code = (part.arguments as { code?: unknown }).code;
			if (typeof code !== "string") return undefined;
			try {
				return parseCodemodeSource(code).code.replace(/^\n/, "");
			} catch {
				return code;
			}
		}
	}
	return undefined;
}

// The file text: `meta` first, then the script. Throws (parseWorkflow's reason) when it would not load as a workflow.
export function workflowFile(name: string, description: string, code: string): string {
	const text = `export const meta = {\n  name: ${JSON.stringify(name)},\n  description: ${JSON.stringify(description)},\n}\n\n${code.trimEnd()}\n`;
	parseWorkflow(text, name);
	return text;
}

// Ask for a name, a description and where; confirm an overwrite; write. Returns the path written, if any.
export async function saveScriptAsWorkflow(ctx: ExtensionContext, script: ScriptRecord): Promise<string | undefined> {
	const ui = ctx.ui;
	if (script.workflow) {
		ui.notify(`subagent: script ${script.id} runs the saved workflow ${script.workflow}`, "info");
		return undefined;
	}
	const code = scriptSource(ctx, script.callId);
	if (code === undefined) {
		ui.notify(`subagent: the source of script ${script.id} is not in this session`, "warning");
		return undefined;
	}
	const name = (await ui.input("Save script as workflow: name", "lowercase-with-dashes"))?.trim();
	if (!name) return undefined;
	if (!WORKFLOW_NAME.test(name)) {
		ui.notify("subagent: a workflow name is lowercase letters, digits and dashes", "warning");
		return undefined;
	}
	const description = (await ui.input("Description", "what it does, shown in /workflows and to the model"))?.trim();
	if (!description) return undefined;
	const places = [`Project: ${join(ctx.cwd, ".pi", "workflows")}`, `User: ${join(getAgentDir(), "workflows")}`];
	const place = await ui.select("Save where?", places);
	if (place === undefined) return undefined;
	const dir = place === places[0] ? join(ctx.cwd, ".pi", "workflows") : join(getAgentDir(), "workflows");
	const path = join(dir, `${name}.js`);
	let text: string;
	try {
		text = workflowFile(name, description, code);
	} catch (err) {
		ui.notify(`subagent: script ${script.id} cannot be a workflow: ${(err as Error).message}`, "warning");
		return undefined;
	}
	if (existsSync(path) && !(await ui.confirm("Overwrite?", `${path} exists. Replace it with script ${script.id}?`)))
		return undefined;
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
	ui.notify(`subagent: saved ${path}; run it with /${name}`, "info");
	return path;
}
