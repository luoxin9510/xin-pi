// Saved workflows: codemode scripts `<name>.js`, run as `/<name> args` (specs 02 and 06 in
// .scratch/xin-pi-workflows/). They are read from `.pi/workflows/` and Claude Code's `.claude/workflows/` in the project
// (closest wins), then `<agent dir>/workflows/` and `~/.claude/workflows/`. The file format is Claude Code's: the first
// statement is `export const meta = { name, description, phases? }`, a plain literal, then the script body.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "../../config.ts";
import { projectDirs } from "./discovery.ts";

export const WORKFLOW_NAME = /^[a-z0-9][a-z0-9-]*$/;

export interface WorkflowMeta {
	name: string;
	description: string;
	phases?: string[];
}

export interface Workflow {
	meta: WorkflowMeta;
	path: string;
	source: "project" | "user";
	// The script the sandbox runs: the file without its `meta` statement, which is replaced by as many line breaks, so a
	// line number in an error is the file's.
	body: string;
}

export interface WorkflowDiscovery {
	workflows: Map<string, Workflow>;
	warnings: string[];
}

// --- the `meta` literal: JSON-like, as a person writes it in JS (quotes of any kind, bare keys, trailing commas). It is
// parsed, never run, so a file cannot execute code by being listed.

class LiteralParser {
	private pos = 0;
	private readonly text: string;
	constructor(text: string) {
		this.text = text;
	}

	get end(): number {
		return this.pos;
	}

	private fail(what: string): never {
		throw new Error(`${what} at offset ${this.pos}`);
	}

	private skip(): void {
		for (;;) {
			const rest = this.text.slice(this.pos);
			const ws = /^(\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)/.exec(rest);
			if (!ws) return;
			this.pos += ws[0].length;
		}
	}

	value(): unknown {
		this.skip();
		const c = this.text[this.pos];
		if (c === "{") return this.object();
		if (c === "[") return this.array();
		if (c === '"' || c === "'" || c === "`") return this.string();
		const word = /^(true|false|null|-?\d+(\.\d+)?([eE][+-]?\d+)?)/.exec(this.text.slice(this.pos));
		if (!word) this.fail("expected a plain value (string, number, boolean, null, array or object)");
		this.pos += word[0].length;
		return word[1] === "true" ? true : word[1] === "false" ? false : word[1] === "null" ? null : Number(word[0]);
	}

	private string(): string {
		const quote = this.text[this.pos++];
		let out = "";
		while (this.pos < this.text.length) {
			const c = this.text[this.pos++];
			if (c === quote) return out;
			if (quote === "`" && c === "$" && this.text[this.pos] === "{")
				this.fail("template expressions are not allowed");
			if (c === "\\") {
				const e = this.text[this.pos++];
				out += e === "n" ? "\n" : e === "t" ? "\t" : e;
			} else out += c;
		}
		return this.fail("unterminated string");
	}

	private array(): unknown[] {
		this.pos++;
		const out: unknown[] = [];
		for (;;) {
			this.skip();
			if (this.text[this.pos] === "]") {
				this.pos++;
				return out;
			}
			out.push(this.value());
			this.skip();
			if (this.text[this.pos] === ",") this.pos++;
			else if (this.text[this.pos] !== "]") this.fail("expected , or ]");
		}
	}

	private object(): Record<string, unknown> {
		this.pos++;
		const out: Record<string, unknown> = {};
		for (;;) {
			this.skip();
			if (this.text[this.pos] === "}") {
				this.pos++;
				return out;
			}
			const c = this.text[this.pos];
			let key: string;
			if (c === '"' || c === "'") key = this.string();
			else {
				const id = /^[A-Za-z_$][\w$]*/.exec(this.text.slice(this.pos));
				if (!id) this.fail("expected a property name");
				key = id[0];
				this.pos += key.length;
			}
			this.skip();
			if (this.text[this.pos++] !== ":") this.fail("expected :");
			out[key] = this.value();
			this.skip();
			if (this.text[this.pos] === ",") this.pos++;
			else if (this.text[this.pos] !== "}") this.fail("expected , or }");
		}
	}
}

const META_START = /^\s*(?:(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/)\s*)*export\s+const\s+meta\s*=\s*/;
// `import` statements and `import()` calls: a workflow cannot load modules (the sandbox has none).
const IMPORT = /(^|[^\w$.])import\s*(\(|[\s{*'"])/m;

// The script with its string literals, template literals and comments blanked out, so the word "import" in a prompt
// or a comment is not taken for an import. Code inside a template's `${}` is blanked with it: a module loaded from
// there fails when the script runs, which is the sandbox's own error.
function codeOnly(text: string): string {
	let out = "";
	for (let i = 0; i < text.length; ) {
		const c = text[i]!;
		if (c === "/" && text[i + 1] === "/") {
			const end = text.indexOf("\n", i);
			i = end === -1 ? text.length : end;
		} else if (c === "/" && text[i + 1] === "*") {
			const end = text.indexOf("*/", i + 2);
			i = end === -1 ? text.length : end + 2;
			out += " ";
		} else if (c === '"' || c === "'" || c === "`") {
			let j = i + 1;
			while (j < text.length && text[j] !== c) j += text[j] === "\\" ? 2 : 1;
			i = j + 1;
			out += '""';
		} else {
			out += c;
			i++;
		}
	}
	return out;
}

// Parse a workflow file. Throws with the reason when it is not one.
export function parseWorkflow(text: string, fileName: string): { meta: WorkflowMeta; body: string } {
	const start = META_START.exec(text);
	if (!start) throw new Error("the first statement must be `export const meta = { name, description }`");
	const parser = new LiteralParser(text.slice(start[0].length));
	let raw: unknown;
	try {
		raw = parser.value();
	} catch (err) {
		throw new Error(`meta is not a plain literal: ${(err as Error).message}`);
	}
	const metaEnd = start[0].length + parser.end;
	const after = /^[ \t]*;?/.exec(text.slice(metaEnd))![0].length;
	const head = text.slice(0, metaEnd + after);
	const body = "\n".repeat(head.split("\n").length - 1) + text.slice(metaEnd + after);
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("meta must be an object");
	const m = raw as Record<string, unknown>;
	if (typeof m.name !== "string" || !WORKFLOW_NAME.test(m.name)) {
		throw new Error("meta.name must be lowercase letters, digits and dashes, starting with a letter or digit");
	}
	if (m.name !== fileName) throw new Error(`meta.name "${m.name}" differs from the file name "${fileName}"`);
	if (typeof m.description !== "string" || m.description.trim() === "") {
		throw new Error("meta.description must be a non-empty string");
	}
	if (m.phases !== undefined && (!Array.isArray(m.phases) || !m.phases.every((p) => typeof p === "string"))) {
		throw new Error("meta.phases must be a list of strings");
	}
	if (IMPORT.test(codeOnly(body))) throw new Error("a workflow cannot import modules");
	return {
		meta: { name: m.name, description: m.description, ...(m.phases ? { phases: m.phases as string[] } : {}) },
		body,
	};
}

function scan(dir: string, source: Workflow["source"], found: Map<string, Workflow>, warnings: string[]): void {
	if (!existsSync(dir)) return;
	let entries: string[];
	try {
		entries = readdirSync(dir).sort();
	} catch (err) {
		warnings.push(`cannot read workflow directory ${dir}: ${(err as NodeJS.ErrnoException).code}`);
		return;
	}
	for (const entry of entries) {
		if (!entry.endsWith(".js")) continue;
		const path = join(dir, entry);
		const name = entry.slice(0, -3);
		if (found.has(name)) continue; // a closer or higher-priority source has it
		try {
			if (!statSync(path).isFile()) continue;
			const { meta, body } = parseWorkflow(readFileSync(path, "utf8"), name);
			found.set(name, { meta, path, source, body });
		} catch (err) {
			warnings.push(`workflow ${path} skipped: ${(err as Error).message}`);
		}
	}
}

// Highest priority first, the same order as agent files: the project's `.pi/workflows` then `.claude/workflows` (each
// from cwd up to the repo root, closest wins; only in a trusted project), then the user's `<agentDir>/workflows` and
// `~/.claude/workflows`. A name found earlier hides the same name later.
export function discoverWorkflows(
	cwd: string,
	trusted: boolean,
	agentDir = getAgentDir(),
	claudeDir = join(homedir(), ".claude"),
): WorkflowDiscovery {
	const workflows = new Map<string, Workflow>();
	const warnings: string[] = [];
	if (trusted) {
		for (const config of [".pi", ".claude"]) {
			for (const dir of projectDirs(cwd)) scan(join(dir, config, "workflows"), "project", workflows, warnings);
		}
	}
	scan(join(agentDir, "workflows"), "user", workflows, warnings);
	scan(join(claudeDir, "workflows"), "user", workflows, warnings);
	return { workflows, warnings };
}

// What follows `/name`: JSON when it parses, else the text; undefined when there is none.
export function parseArgs(text: string): unknown {
	const trimmed = text.trim();
	if (trimmed === "") return undefined;
	try {
		return JSON.parse(trimmed);
	} catch {
		return trimmed;
	}
}
