// Find agent definitions in the five sources (spec 4.2), highest priority first.

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getPackageDir } from "../../config.ts";
import { type AgentDefinition, definitionFromFields, inertNotice, parseDefinition } from "./definition.ts";

// The built-in agent definitions ship as assets next to the extension's source (or its build output).
const packageDir = getPackageDir();
export const BUILTIN_DIR = join(
	packageDir,
	existsSync(join(packageDir, "src")) ? "src" : "dist",
	"extensions",
	"subagent",
	"builtin",
);

export interface Discovery {
	agents: Map<string, AgentDefinition>;
	warnings: string[];
}

// cwd, then each parent up to the nearest ancestor containing .git. Never includes the home directory (its
// .pi/.claude folders are user sources). Without a repo, only cwd.
export function projectDirs(cwd: string): string[] {
	// Compare real paths: HOME may carry a trailing slash or be a symlink. The returned paths keep cwd's spelling.
	const real = (p: string) => (existsSync(p) ? realpathSync(p) : resolve(p));
	const home = real(homedir());
	const isHome = (dir: string) => real(dir) === home;
	const dirs: string[] = [];
	for (let dir = cwd; !isHome(dir); dir = dirname(dir)) {
		dirs.push(dir);
		if (existsSync(join(dir, ".git"))) return dirs;
		if (dirname(dir) === dir) break;
	}
	return isHome(cwd) ? [] : [cwd];
}

export const MAX_SCAN_DEPTH = 6; // levels below a source root
export const MAX_SCAN_ENTRIES = 5000; // per source root

// Symlinked directories are followed (like skills); realpath keeps a loop from repeating. Dot directories and
// node_modules are not entered. An entry that cannot be read is skipped with a warning.
function markdownFiles(root: string, warnings: string[]): string[] {
	if (!existsSync(root)) return [];
	const files: string[] = [];
	const seen = new Set<string>();
	let count = 0;
	const walk = (dir: string, depth: number): boolean => {
		let entries: string[];
		try {
			const real = realpathSync(dir);
			if (seen.has(real)) return true;
			seen.add(real);
			entries = readdirSync(dir).sort();
		} catch (err) {
			warnings.push(`cannot read agent directory ${dir}: ${(err as NodeJS.ErrnoException).code}`);
			return true;
		}
		for (const e of entries) {
			if (++count > MAX_SCAN_ENTRIES) {
				warnings.push(`stopped scanning ${root}: more than ${MAX_SCAN_ENTRIES} entries`);
				return false;
			}
			const path = join(dir, e);
			let stat: ReturnType<typeof statSync>;
			try {
				stat = statSync(path, { throwIfNoEntry: false }); // a dangling symlink is skipped
			} catch (err) {
				warnings.push(`cannot read ${path}: ${(err as NodeJS.ErrnoException).code}`);
				continue;
			}
			if (stat?.isDirectory()) {
				if (depth < MAX_SCAN_DEPTH && !e.startsWith(".") && e !== "node_modules" && !walk(path, depth + 1))
					return false;
			} else if (stat?.isFile() && e.endsWith(".md")) files.push(path);
		}
		return true;
	};
	walk(root, 0);
	return files;
}

export function agentSources(cwd: string): string[] {
	const project = projectDirs(cwd);
	return [
		...project.map((d) => join(d, ".pi", "agents")),
		...project.map((d) => join(d, ".claude", "agents")),
		join(homedir(), ".pi", "agent", "agents"),
		join(homedir(), ".claude", "agents"),
		BUILTIN_DIR,
	];
}

// Agents given on the command line (`--agents`): they rank above every file and live for the process.
let cliAgents: AgentDefinition[] = [];
export const CLI_SOURCE = "--agents";

// Parse the value of `--agents`: a JSON object (or the path of a file holding one) whose keys are agent names and whose
// values are definitions, Claude Code's shape: `prompt` is the system prompt, the other keys are the agent-file fields.
// Throws when it is not such an object; an entry that is not a valid agent is skipped with a warning.
export function setCliAgents(value: string | undefined, cwd: string): string[] {
	cliAgents = [];
	if (value === undefined || value.trim() === "") return [];
	let text = value.trim();
	if (!text.startsWith("{")) {
		const path = resolve(cwd, text);
		try {
			text = readFileSync(path, "utf8");
		} catch (err) {
			throw new Error(
				`--agents: cannot read ${path}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`,
			);
		}
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		throw new Error(`--agents: invalid JSON: ${(err as Error).message}`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("--agents: expected a JSON object whose keys are agent names");
	}
	const warnings: string[] = [];
	for (const [name, raw] of Object.entries(parsed)) {
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
			warnings.push(`skipped --agents entry "${name}": its value must be an object`);
			continue;
		}
		const { prompt, ...fields } = raw as Record<string, unknown>;
		if (prompt !== undefined && typeof prompt !== "string") {
			warnings.push(`skipped --agents entry "${name}": "prompt" must be a string`);
			continue;
		}
		const result = definitionFromFields(CLI_SOURCE, { ...fields, name }, (prompt ?? "").trim());
		if (result.ok) cliAgents.push(result.def);
		else warnings.push(`skipped --agents entry "${name}": ${result.reason}`);
	}
	return warnings;
}

export function discoverAgents(cwd: string): Discovery {
	const agents = new Map<string, AgentDefinition>();
	const warnings: string[] = [];
	const fromCli = new Set<string>();
	for (const def of cliAgents) {
		agents.set(def.name, def);
		fromCli.add(def.name);
		for (const w of def.warnings) warnings.push(`${def.name}: ${w}`);
		for (const field of def.inert) warnings.push(`${def.name}: ${inertNotice(field)}`);
	}

	const projectSources = new Set(agentSources(cwd).slice(0, 2 * projectDirs(cwd).length));
	const winners = new Map<string, { dir: string; path: string }>();
	for (const dir of agentSources(cwd)) {
		const seen = new Map<string, string>(); // name -> path, within this source
		for (const path of markdownFiles(dir, warnings)) {
			const result = parseDefinition(path, readFileSync(path, "utf8"));
			if (!result.ok) {
				warnings.push(`skipped agent file ${path}: ${result.reason}`);
				continue;
			}
			const def = result.def;
			const first = seen.get(def.name);
			if (first) {
				warnings.push(`agent "${def.name}" is defined twice: ${first} wins over ${path}`);
				continue;
			}
			seen.set(def.name, path);
			if (fromCli.has(def.name)) continue; // --agents ranks above every file
			const winner = winners.get(def.name);
			if (winner) {
				// a higher-priority source already defined it
				if (dir === BUILTIN_DIR && projectSources.has(winner.dir)) {
					warnings.push(`project agent "${def.name}" overrides the built-in (${winner.path})`);
				}
				continue;
			}
			winners.set(def.name, { dir, path });
			agents.set(def.name, dir === BUILTIN_DIR ? { ...def, source: `builtin:${def.name}` } : def);
			for (const w of def.warnings) warnings.push(`${def.name}: ${w}`);
			for (const field of def.inert) warnings.push(`${def.name}: ${inertNotice(field)}`);
		}
	}
	return { agents, warnings };
}
