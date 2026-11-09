// Find skills to preload into a child's system prompt (spec 5, System prompt).

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { MAX_SCAN_DEPTH, MAX_SCAN_ENTRIES, projectDirs } from "./discovery.ts";

function frontmatterName(text: string): string | undefined {
	const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
	if (!m) return undefined;
	try {
		const fm = parseYaml(m[1]!) as { name?: unknown } | null;
		return typeof fm?.name === "string" ? fm.name : undefined;
	} catch {
		return undefined; // a broken skill file is a missing skill, reported by the caller
	}
}

function skillDirs(cwd: string): string[] {
	const project = projectDirs(cwd);
	return [
		...project.flatMap((d) => [join(d, ".pi", "skills"), join(d, ".agents", "skills"), join(d, ".claude", "skills")]),
		join(homedir(), ".pi", "agent", "skills"),
		join(homedir(), ".agents", "skills"),
		join(homedir(), ".claude", "skills"),
	];
}

// Directories holding SKILL.md, found recursively like pi does. Symlinks are followed; a skill directory is not
// searched further (its subdirectories are the skill's own files). The walk is bounded like the agent scan, and an
// entry that cannot be read is skipped: its skill is just not found.
function skillFiles(root: string): string[] {
	const files: string[] = [];
	const seen = new Set<string>();
	let count = 0;
	const walk = (dir: string, depth: number): boolean => {
		let entries: string[];
		try {
			const real = realpathSync(dir);
			if (seen.has(real)) return true;
			seen.add(real);
			const own = join(dir, "SKILL.md");
			if (existsSync(own) && statSync(own).isFile()) {
				files.push(own);
				return true;
			}
			entries = readdirSync(dir).sort();
		} catch {
			return true; // an unreadable directory holds no skills
		}
		for (const e of entries) {
			if (++count > MAX_SCAN_ENTRIES) return false;
			if (e.startsWith(".") || e === "node_modules" || depth >= MAX_SCAN_DEPTH) continue;
			const path = join(dir, e);
			try {
				if (statSync(path).isDirectory() && !walk(path, depth + 1)) return false;
			} catch {
				// dangling or looping symlink, no permission: not a skill directory
			}
		}
		return true;
	};
	if (existsSync(root)) walk(root, 0);
	return files;
}

// Matched by frontmatter name, else the directory name. Earlier dirs win.
export function findSkill(name: string, cwd: string): string | undefined {
	for (const dir of skillDirs(cwd)) {
		for (const file of skillFiles(dir)) {
			const text = readFileSync(file, "utf8");
			if ((frontmatterName(text) ?? basename(dirname(file))) === name) return text;
		}
	}
	return undefined;
}
