import { describe, expect, test } from "vitest";
import { getSystemMessageRegions } from "xpi-ai";
import type { Skill } from "../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import {
	buildSystemPrompt,
	buildSystemPromptCacheBreakpoints,
	buildSystemPromptSections,
	displayContextPath,
} from "../src/core/system-prompt.ts";

const testSkill: Skill = {
	name: "test-skill",
	description: "A test skill.",
	filePath: "/skills/test-skill/SKILL.md",
	baseDir: "/skills/test-skill",
	sourceInfo: createSyntheticSourceInfo("/skills/test-skill/SKILL.md", { source: "test" }),
	disableModelInvocation: false,
};

describe("buildSystemPrompt", () => {
	describe("empty tools", () => {
		test("shows (none) for empty tools list", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("<tools>\n(none)\n");
		});

		test("shows file paths guideline even with no tools", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Show file paths clearly");
		});
	});

	describe("prompt structure", () => {
		test("keeps the default and custom prompt prefixes exact", () => {
			const defaultPrompt = buildSystemPrompt({ cwd: "/tmp", selectedTools: [], contextFiles: [], skills: [] });
			const customPrompt = buildSystemPrompt({
				customPrompt: "You are Exact.",
				cwd: "/tmp",
				selectedTools: [],
				contextFiles: [],
				skills: [],
			});

			expect(defaultPrompt.startsWith("You are a coding assistant running inside pi, a coding agent harness.")).toBe(
				true,
			);
			expect(customPrompt.startsWith("You are Exact.\n\n<cwd>")).toBe(true);
		});

		test("preserves an exact forced prompt without sections", () => {
			expect(buildSystemPrompt({ forceSystemPrompt: "exact", cwd: "/tmp" })).toBe("exact");
		});

		test("maps appended instructions and project context to stable sections", () => {
			const prompt = buildSystemPrompt({
				customPrompt: "You are Exact.",
				appendSystemPrompt: "Additional instructions.",
				contextFiles: [{ path: "/tmp/AGENTS.md", content: "Project instructions." }],
				selectedTools: [],
				skills: [],
				cwd: "/tmp",
			});

			expect(prompt).toContain("<addendum>\nAdditional instructions.\n</addendum>");
			expect(prompt).toContain(
				'<project_context>\nProject-specific instructions and guidelines:\n\n<project_instructions path="AGENTS.md">',
			);
			expect(prompt).toContain("<cwd>\n/tmp\n</cwd>");
		});
	});

	describe("default tools", () => {
		test("includes all default tools when snippets are provided", () => {
			const prompt = buildSystemPrompt({
				toolSnippets: {
					read: "Read file contents",
					bash: "Execute bash commands",
					edit: "Make surgical edits",
					write: "Create or overwrite files",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- read:");
			expect(prompt).toContain("- bash:");
			expect(prompt).toContain("- edit:");
			expect(prompt).toContain("- write:");
		});

		test.each([
			[["powershell"], "Use PowerShell for file operations"],
			[["bash", "powershell"], "Use bash or PowerShell for file operations"],
		] as const)("uses shell-specific guidance for %j", (selectedTools, expected) => {
			const prompt = buildSystemPrompt({
				selectedTools: [...selectedTools],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain(expected);
		});

		test("instructs models to resolve pi docs and examples under absolute base paths", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain(
				"- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory",
			);
			expect(prompt).toContain("environment variables (docs/environment-variables.md), MCP servers (docs/mcp.md)");
			expect(prompt).toContain(
				"Before implementing harness changes, read the relevant docs and examples in full, following related cross-references.",
			);
		});
	});

	describe("custom tool snippets", () => {
		test("includes custom tools in available tools section when promptSnippet is provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				toolSnippets: {
					dynamic_tool: "Run dynamic test behavior",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- dynamic_tool: Run dynamic test behavior");
		});

		test("omits custom tools from available tools section when promptSnippet is not provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).not.toContain("dynamic_tool");
		});
	});

	describe("prompt guidelines", () => {
		test("appends promptGuidelines to default guidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for project summaries."],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- Use dynamic_tool for project summaries.");
		});

		test("deduplicates and trims promptGuidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for summaries.", "  Use dynamic_tool for summaries.  ", "   "],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt.match(/- Use dynamic_tool for summaries\./g)).toHaveLength(1);
		});
	});

	describe("skills", () => {
		test.each([
			{ name: "default prompt", customPrompt: undefined },
			{ name: "custom prompt", customPrompt: "Custom system prompt" },
		])("includes skills with only bash in the $name", ({ customPrompt }) => {
			const prompt = buildSystemPrompt({
				customPrompt,
				selectedTools: ["bash"],
				contextFiles: [],
				skills: [testSkill],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("<skills>");
			expect(prompt).toContain("<available_skills>");
			expect(prompt).toContain("<name>test-skill</name>");
			expect(prompt).toContain("Use bash to load a skill's file");
			expect(prompt).toContain(
				"Resolve relative paths against the skill's directory (parent of SKILL.md). Use absolute paths in tool calls.",
			);
		});

		test("omits skills without read or bash", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["write"],
				contextFiles: [],
				skills: [testSkill],
				cwd: process.cwd(),
			});

			expect(prompt).not.toContain("<available_skills>");
		});
	});

	// #10343
	describe("hidden tools", () => {
		const build = (hiddenTools: string[]) =>
			buildSystemPrompt({
				selectedTools: ["read", "bash", "run"],
				hiddenTools,
				toolSnippets: { read: "Read files", bash: "Run commands", run: "Run a task" },
				toolGuidelines: { read: ["Use read for files."], run: ["Prefer run."] },
				contextFiles: [],
				skills: [testSkill],
				cwd: process.cwd(),
			});

		test("leaves hidden tools out of the tool list and rules", () => {
			const prompt = build(["read", "bash"]);

			expect(prompt).toContain("<tools>\n- run: Run a task\n");
			expect(prompt).not.toContain("- read: ");
			expect(prompt).not.toContain("Use read for files.");
			expect(prompt).not.toContain("Use bash for file operations");
			expect(prompt).toContain("- Prefer run.");
		});

		test("keeps skills without naming a hidden reader", () => {
			expect(build(["read", "bash"])).toContain("\nLoad a skill's file when the task matches its description.");
			expect(build(["read"])).toContain("Use bash to load a skill's file");
			expect(build([])).toContain("Use the read tool to load a skill's file");
		});
	});

	describe("context file paths", () => {
		test("a file in the project is relative to the working directory; home files are ~/; others stay absolute", () => {
			const home = "/home/u";
			const root = "/home/u/code/app";
			expect(displayContextPath(`${root}/AGENTS.md`, root, root, home)).toBe("AGENTS.md");
			expect(displayContextPath(`${root}/AGENTS.md`, `${root}/packages/x`, root, home)).toBe("../../AGENTS.md");
			expect(displayContextPath(`${root}/packages/x/CLAUDE.md`, `${root}/packages/x`, root, home)).toBe("CLAUDE.md");
			// The global file and the project file are both named AGENTS.md and stay apart.
			expect(displayContextPath("/home/u/.pi/agent/AGENTS.md", root, root, home)).toBe("~/.pi/agent/AGENTS.md");
			// An ancestor above the project keeps one spelling however deep the working directory is.
			expect(displayContextPath("/home/u/code/AGENTS.md", root, root, home)).toBe("~/code/AGENTS.md");
			expect(
				displayContextPath("/home/u/code/AGENTS.md", `${root}/.pi/worktrees/w1`, `${root}/.pi/worktrees/w1`, home),
			).toBe("~/code/AGENTS.md");
			expect(displayContextPath("/etc/AGENTS.md", root, root, home)).toBe("/etc/AGENTS.md");
			// Without a project root the working directory is the project.
			expect(displayContextPath("/home/u/code/app/AGENTS.md", root, undefined, home)).toBe("AGENTS.md");
			expect(displayContextPath("/home/u/code/app-other/AGENTS.md", root, root, home)).toBe(
				"~/code/app-other/AGENTS.md",
			);
		});

		test("the main checkout and a worktree of it render the same project context", () => {
			const render = (root: string) =>
				buildSystemPromptSections({
					cwd: root,
					projectRoot: root,
					selectedTools: [],
					skills: [],
					contextFiles: [{ path: `${root}/AGENTS.md`, content: "Project instructions." }],
				}).project_context;
			expect(render("/work/app")).toBe(render("/work/app/.pi/worktrees/w1"));
			expect(render("/work/app")).not.toContain("/work/app");
		});
	});

	describe("tail (cache layout)", () => {
		const base = {
			customPrompt: "Shared head.",
			selectedTools: ["read"],
			contextFiles: [{ path: "/work/app/AGENTS.md", content: "Project instructions." }],
			skills: [testSkill],
			sections: { extra: "Extension text." },
		};
		const regions = (options: Parameters<typeof buildSystemPromptSections>[0]) =>
			getSystemMessageRegions({
				role: "system",
				content: "",
				sections: buildSystemPromptSections(options),
				cacheBreakpoints: buildSystemPromptCacheBreakpoints(options),
				timestamp: 0,
			});

		test("without a tail the sections, their order and the hints are as before", () => {
			const options = { ...base, cwd: "/work/app" };
			expect(Object.keys(buildSystemPromptSections(options))).toEqual([
				"preamble",
				"project_context",
				"skills",
				"cwd",
				"extra",
			]);
			expect(buildSystemPromptCacheBreakpoints(options)).toBeUndefined();
			expect(regions(options)).toHaveLength(1);
		});

		test("with a tail the head ends before cwd and the instructions come last, each with a hint", () => {
			const options = { ...base, cwd: "/work/app", tail: "You are agent A.\n\nDate: 2026-11-10" };
			const sections = buildSystemPromptSections(options);
			expect(Object.keys(sections)).toEqual([
				"preamble",
				"project_context",
				"skills",
				"extra",
				"cwd",
				"instructions",
			]);
			expect(sections.instructions).toBe("<instructions>\nYou are agent A.\n\nDate: 2026-11-10\n</instructions>");
			expect(buildSystemPromptCacheBreakpoints(options)).toEqual(["extra", "instructions"]);
			const [head, tail, ...rest] = regions(options);
			expect(rest).toEqual([]);
			expect(head.breakpoint && tail.breakpoint).toBe(true);
			expect(head.text.endsWith("</extra>")).toBe(true);
			expect(head.text).not.toContain("/work/app");
			expect(tail.text.startsWith("\n\n<cwd>\n/work/app\n</cwd>")).toBe(true);
			// The split changes no text: the regions concatenate to the prompt every other provider gets.
			expect(head.text + tail.text).toBe(buildSystemPrompt(options));
		});

		test("the head is the same for two tails and for a worktree; only the tail region differs", () => {
			const a = regions({ ...base, cwd: "/work/app", projectRoot: "/work/app", tail: "You are agent A." });
			const b = regions({ ...base, cwd: "/work/app", projectRoot: "/work/app", tail: "You are agent B. Memory: x" });
			const worktree = "/work/app/.pi/worktrees/w1";
			const w = regions({
				...base,
				cwd: worktree,
				projectRoot: worktree,
				contextFiles: [{ path: `${worktree}/AGENTS.md`, content: "Project instructions." }],
				tail: "You are agent A.",
			});
			expect(b[0].text).toBe(a[0].text);
			expect(w[0].text).toBe(a[0].text);
			expect(b[1].text).not.toBe(a[1].text);
			expect(w[1].text).toContain(worktree);
		});

		test("skills that live in the project follow cwd, because their absolute paths differ per worktree", () => {
			const projectSkill = (root: string): Skill => ({
				...testSkill,
				name: "project-skill",
				filePath: `${root}/.pi/skills/project-skill/SKILL.md`,
				baseDir: `${root}/.pi/skills/project-skill`,
			});
			const build = (root: string) => {
				const options = {
					...base,
					cwd: root,
					projectRoot: root,
					contextFiles: [{ path: `${root}/AGENTS.md`, content: "Project instructions." }],
					skills: [testSkill, projectSkill(root)],
					tail: "You are agent A.",
				};
				return { names: Object.keys(buildSystemPromptSections(options)), regions: regions(options) };
			};
			const main = build("/work/app");
			const worktree = build("/work/app/.pi/worktrees/w1");
			expect(main.names).toEqual(["preamble", "project_context", "extra", "cwd", "skills", "instructions"]);
			expect(worktree.regions[0].text).toBe(main.regions[0].text);
			expect(main.regions[1].text).toContain("/work/app/.pi/skills/project-skill/SKILL.md");
		});

		test("an empty tail still moves cwd out of the head; the instructions name is reserved only with a tail", () => {
			const options = { ...base, cwd: "/work/app", tail: "" };
			expect(Object.keys(buildSystemPromptSections(options))).toEqual([
				"preamble",
				"project_context",
				"skills",
				"extra",
				"cwd",
			]);
			expect(buildSystemPromptCacheBreakpoints(options)).toEqual(["extra", "cwd"]);
			expect(() =>
				buildSystemPromptSections({ cwd: "/tmp", tail: "x", sections: { instructions: "mine" } }),
			).toThrow(/Invalid system prompt section name: instructions/);
			expect(buildSystemPromptSections({ cwd: "/tmp", sections: { instructions: "mine" } }).instructions).toContain(
				"mine",
			);
		});
	});
});
