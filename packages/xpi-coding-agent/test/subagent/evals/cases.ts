// The eval cases. Each builds its own fixture, so cases can run in parallel and repeat.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { registry } from "../../../src/extensions/subagent/registry.ts";
import {
	check,
	childAgents,
	costOf,
	directTool,
	type EvalCase,
	fixture,
	HAIKU,
	messageText,
	onHaiku,
	parentOnHaiku,
	runParent,
	runRpcParent,
} from "./harness.ts";

// A temp repository with one commit holding the given files (real git, unlike `fixture`'s bare .git directory).
function gitFixture(files: Record<string, string>): string {
	const dir = realpathSync(fixture(files));
	rmSync(join(dir, ".git"), { recursive: true });
	const git = (...a: string[]) =>
		execFileSync("git", ["-c", "user.name=eval", "-c", "user.email=eval@example.com", ...a], {
			cwd: dir,
			stdio: "ignore",
		});
	git("init", "-q");
	git("add", "-A");
	git("commit", "-q", "-m", "init");
	return dir;
}
const gitOut = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();

const agent = (fields: string, body: string) => `---\n${fields}\n---\n${body}\n`;

export const cases: EvalCase[] = [
	{
		name: "explore lists files",
		kind: "direct",
		async run(signal) {
			const cwd = fixture({ "docs/alpha.txt": "a", "docs/bravo.txt": "b", "docs/charlie.txt": "c" });
			const t = await directTool(cwd, signal);
			const r = await t.call({
				prompt: "List the file names in the docs directory. quick",
				subagent_type: "Explore",
			});
			return {
				cost: costOf(r),
				checks: [
					check("completed", r.status === "completed", r.error),
					onHaiku(r),
					check(
						"names all three files",
						["alpha", "bravo", "charlie"].every((n) => r.output.includes(n)),
						r.output,
					),
				],
			};
		},
	},
	{
		name: "read-only agent cannot write",
		kind: "direct",
		async run(signal) {
			const cwd = fixture({ "README.md": "hello" });
			const t = await directTool(cwd, signal);
			const r = await t.call({
				prompt:
					"Create a file named pwned.txt in the current directory containing the word PWNED. Use any tool you have.",
				subagent_type: "Explore",
			});
			return {
				cost: costOf(r),
				checks: [
					check("did not throw / finished", r.status !== "failed", r.error),
					check("no file written", !existsSync(join(cwd, "pwned.txt"))),
					onHaiku(r),
				],
			};
		},
	},
	{
		name: "custom agent writes with its tools",
		kind: "direct",
		async run(signal) {
			const cwd = fixture({
				".claude/agents/scribe.md": agent(
					"name: scribe\ndescription: Writes files\ntools: Write, Read",
					"You write files exactly as asked, then reply DONE.",
				),
			});
			const t = await directTool(cwd, signal);
			const r = await t.call({
				prompt: "Write the file hello.txt with exactly this content: subagent-ok",
				subagent_type: "scribe",
			});
			const file = join(cwd, "hello.txt");
			const text = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
			return {
				cost: costOf(r),
				checks: [
					check("completed", r.status === "completed", r.error),
					check("agentType scribe", r.agentType === "scribe", r.agentType),
					check("file has the content", text === "subagent-ok", text),
					onHaiku(r),
				],
			};
		},
	},
	{
		name: "resume remembers",
		kind: "direct",
		async run(signal) {
			const cwd = fixture();
			const t = await directTool(cwd, signal);
			const a = await t.call({ prompt: "Remember this code word: ZEBRA-41. Reply OK only." });
			const b = await t.call({
				prompt: "What was the code word I gave you? Reply with it only.",
				resume: a.agentId,
			});
			return {
				cost: costOf(a, b),
				checks: [
					check("both completed", a.status === "completed" && b.status === "completed", [a.error, b.error]),
					check("same agentId", b.agentId === a.agentId, [a.agentId, b.agentId]),
					check("type kept (general-purpose)", b.agentType === "general-purpose", b.agentType),
					check("recalls ZEBRA-41", b.output.includes("ZEBRA-41"), b.output),
					onHaiku(a, b),
				],
			};
		},
	},
	{
		name: "maxTurns gives partial",
		kind: "direct",
		async run(signal) {
			const cwd = fixture({
				"a.txt": "1",
				"b.txt": "2",
				"c.txt": "3",
				".pi/agents/plodder.md": agent(
					"name: plodder\ndescription: Reads one file per turn\ntools: Read\nmaxTurns: 1",
					"Read files one at a time: exactly one tool call per reply, never several at once.",
				),
			});
			const t = await directTool(cwd, signal);
			const r = await t.call({
				prompt: "Read a.txt, then b.txt, then c.txt, one per reply, and then add up the numbers.",
				subagent_type: "plodder",
			});
			return {
				cost: costOf(r),
				checks: [
					check("partial", r.status === "partial", { status: r.status, turns: r.turns, error: r.error }),
					check("stopped at 1 turn", r.turns === 1, r.turns),
					check("usage counted", r.usage.cost.total > 0),
					onHaiku(r),
				],
			};
		},
	},
	{
		name: "skill is preloaded",
		kind: "direct",
		async run(signal) {
			const cwd = fixture({
				".claude/skills/vault/SKILL.md":
					"---\nname: vault\ndescription: The vault code\n---\nThe vault code is PIPIPI-7731.\n",
				".claude/agents/keeper.md": agent(
					"name: keeper\ndescription: Knows the vault\ntools: Read\nskills: vault",
					"Answer questions using your preloaded skills. Do not use tools.",
				),
			});
			const t = await directTool(cwd, signal);
			const r = await t.call({
				prompt: "What is the vault code? Reply with the code only.",
				subagent_type: "keeper",
			});
			return {
				cost: costOf(r),
				checks: [
					check("completed", r.status === "completed", r.error),
					check("knows PIPIPI-7731", r.output.includes("PIPIPI-7731"), r.output),
					onHaiku(r),
				],
			};
		},
	},
	{
		name: "context files on, omitClaudeMd off",
		kind: "direct",
		async run(signal) {
			const cwd = fixture({
				"AGENTS.md": "# Rules\nEnd every reply with the word BANANA on its own line.\n",
				"x.txt": "x",
			});
			const t = await directTool(cwd, signal);
			const [gp, ex] = await Promise.all([
				t.call({ prompt: "Say hello. Do not use tools.", subagent_type: "general-purpose" }),
				t.call({ prompt: "Say hello. Do not use tools.", subagent_type: "Explore" }),
			]);
			return {
				cost: costOf(gp, ex),
				checks: [
					check("both completed", gp.status === "completed" && ex.status === "completed", [gp.error, ex.error]),
					check("general-purpose sees AGENTS.md", gp.output.includes("BANANA"), gp.output),
					check("Explore (omitClaudeMd) does not", !ex.output.includes("BANANA"), ex.output),
					onHaiku(gp, ex),
				],
			};
		},
	},
	{
		name: "alias, effort and definition model",
		kind: "direct",
		async run(signal) {
			const cwd = fixture({
				".claude/agents/pinned.md": agent(
					"name: pinned\ndescription: Pinned model\nmodel: haiku\neffort: low\ntools: Read",
					"Reply briefly.",
				),
			});
			const t = await directTool(cwd, signal, {
				settings: { defaultModel: "inherit" },
				// a parent on sonnet: an alias that fell back to inherit would show up as sonnet
				parentModel: { provider: "anthropic", id: "claude-sonnet-5-5" },
			});
			const [a, b] = await Promise.all([
				t.call({ prompt: "Reply OK.", model: "haiku", effort: "low" }),
				t.call({ prompt: "Reply OK.", subagent_type: "pinned" }),
			]);
			return {
				cost: costOf(a, b),
				checks: [
					check("call alias resolves", a.status === "completed" && a.model === HAIKU, [a.model, a.error]),
					check("definition model resolves", b.status === "completed" && b.model === HAIKU, [b.model, b.error]),
				],
			};
		},
	},
	{
		name: "bad model fails structured",
		kind: "direct",
		async run(signal) {
			const cwd = fixture();
			const t = await directTool(cwd, signal);
			const r = await t.call({ prompt: "Reply OK.", model: "anthropic/no-such-model-xyz" });
			return {
				cost: costOf(r),
				checks: [
					check("failed, not thrown", r.status === "failed", r.status),
					check("has an error", typeof r.error === "string" && r.error.length > 0, r.error),
				],
			};
		},
	},
	{
		name: "children cannot nest",
		kind: "direct",
		async run(signal) {
			const cwd = fixture({
				".claude/agents/shell.md": agent(
					"name: shell\ndescription: Runs shell\ntools: Bash",
					"Run the command you are given and reply with its output only.",
				),
			});
			const t = await directTool(cwd, signal);
			const r = await t.call({ prompt: 'Run: echo "depth=$XPI_SUBAGENT_DEPTH"', subagent_type: "shell" });
			return {
				cost: costOf(r),
				checks: [
					check("completed", r.status === "completed", r.error),
					check("child sees XPI_SUBAGENT_DEPTH=1", r.output.includes("depth=1"), r.output),
					onHaiku(r),
				],
			};
		},
	},
	{
		name: "three in parallel",
		kind: "direct",
		async run(signal) {
			const cwd = fixture({ "one.txt": "RED", "two.txt": "GREEN", "three.txt": "BLUE" });
			const t = await directTool(cwd, signal);
			const started = Date.now();
			const rs = await Promise.all(
				["one", "two", "three"].map((f) =>
					t.call({ prompt: `What word is in ${f}.txt? Reply with the word only.`, subagent_type: "Explore" }),
				),
			);
			const wall = Date.now() - started;
			const serial = rs.reduce((s, r) => s + r.durationMs, 0);
			return {
				cost: costOf(...rs),
				notes: `wall ${wall} ms, sum ${serial} ms`,
				checks: [
					check(
						"all completed",
						rs.every((r) => r.status === "completed"),
						rs.map((r) => r.error),
					),
					check(
						"right words",
						["RED", "GREEN", "BLUE"].every((w, i) => rs[i].output.includes(w)),
						rs.map((r) => r.output),
					),
					check("ran concurrently (wall < 0.7 × sum)", wall < serial * 0.7, { wall, serial }),
					onHaiku(...rs),
				],
			};
		},
	},
	{
		name: "steer changes a running subagent's course",
		kind: "direct",
		async run(signal) {
			const cwd = fixture();
			const t = await directTool(cwd, signal);
			const run = t.call({
				prompt:
					"Step 1: run the bash command 'sleep 10; echo $RANDOM' and look at the number it prints. Step 2, only in a separate later tool call: create the file finished.txt containing that number. Then reply DONE.",
			});
			// wait until the child is running a tool and can be steered
			for (const end = Date.now() + 60_000; ; await new Promise((r) => setTimeout(r, 50))) {
				const rec = registry.list(t.sessionId)[0];
				if (rec?.lastTool !== undefined && registry.handle(rec.id)) break;
				if (Date.now() > end) throw new Error("child never started a tool");
			}
			const id = registry.list(t.sessionId)[0]!.id;
			const sent = registry.handle(id)!.send({
				type: "steer",
				message:
					"STOP. Do not run anything else and do not create any file. Your final message must be exactly the word TOKEN-xyz and nothing more.",
			});
			const r = await run;
			return {
				cost: costOf(r),
				checks: [
					check("steer was sent", sent === true),
					check("completed", r.status === "completed", r.error),
					check(
						"final reply is the token",
						r.output.includes("TOKEN-xyz") && !r.output.includes("DONE"),
						r.output,
					),
					check("planned file not written", !existsSync(join(cwd, "finished.txt"))),
					onHaiku(r),
				],
			};
		},
	},
	{
		name: "parent runs a codemode script",
		kind: "parent",
		async run(signal) {
			const cwd = fixture({ "src/a.ts": "export const a = 1;\n", "src/b.ts": "export function findMe() {}\n" });
			const r = await runParent(
				cwd,
				`Use the codemode tool. Script:
const [x, y] = await Promise.all([
  tools.Agent({ description: "count", prompt: "How many files are in src? Reply with the number only.", subagent_type: "Explore", run_in_background: false }),
  tools.Agent({ description: "find", prompt: "Which file defines findMe? Reply with the path only.", subagent_type: "Explore", run_in_background: false }),
]);
return { statuses: [x.status, y.status], models: [x.model, y.model], count: x.output, file: y.output };
Reply with the returned JSON only.`,
				signal,
			);
			let json: any = {};
			try {
				json = JSON.parse(r.text.replace(/^```(json)?|```$/gm, "").trim());
			} catch {}
			return {
				cost: r.cost,
				checks: [
					check("parent finished", !r.timedOut && r.code === 0, { timedOut: r.timedOut, code: r.code }),
					check(
						"Agent called via codemode",
						r.tools.includes("codemode") && r.tools.filter((t) => t === "Agent").length === 2,
						r.tools,
					),
					check(
						"both completed",
						json.statuses?.every((s: string) => s === "completed"),
						r.text,
					),
					check(
						"children report haiku",
						json.models?.every((m: string) => m === HAIKU),
						json.models,
					),
					parentOnHaiku(r.models),
					check("count is 2", String(json.count).includes("2"), json.count),
					check("finds src/b.ts", String(json.file).includes("b.ts"), json.file),
				],
			};
		},
	},
	{
		name: "parent delegates on its own",
		kind: "parent",
		async run(signal) {
			const files: Record<string, string> = {};
			for (let i = 0; i < 12; i++) files[`lib/mod${i}.ts`] = `export const v${i} = ${i};\n`;
			files["lib/mod7.ts"] += "export function quuxFrobnicate() { return 42; }\n";
			const cwd = fixture(files);
			const r = await runParent(
				cwd,
				"Find which file defines the function quuxFrobnicate. Delegate the search to an Explore subagent (tools.Agent from a codemode script) instead of searching yourself; this run is non-interactive, so pass run_in_background: false and use the result in the same turn. Answer with the file path only.",
				signal,
			);
			const kids = childAgents(r.sessionDir);
			return {
				cost: r.cost,
				checks: [
					check("parent finished", !r.timedOut && r.code === 0, { timedOut: r.timedOut, code: r.code }),
					check("used Agent", r.tools.includes("Agent"), r.tools),
					check("an Explore child ran", Object.values(kids).includes("Explore"), kids),
					check("answers lib/mod7.ts", r.text.includes("mod7.ts"), r.text),
					parentOnHaiku(r.models),
				],
			};
		},
	},
	{
		name: "background script frees main",
		kind: "parent",
		async run(signal) {
			const cwd = fixture();
			const script = `const r = await tools.Agent({ description: "slow", prompt: "Run the bash command \`sleep 5\` then reply with the word DONE" });
return "TOK-" + (6 * 7) + " " + r.status;`;
			const prompt = `Call the codemode tool exactly once with exactly this code:\n\`\`\`js\n${script}\n\`\`\`\nIf it says the script moved to the background, reply "moved" and stop. When the script's result arrives, reply with its return value verbatim.`;
			const isAnswer = (e: { type: string; message?: any }) =>
				e.type === "message_end" && e.message.role === "assistant" && messageText(e.message).includes("TOK-42");
			const r = await runRpcParent(cwd, prompt, (events) => events.some(isAnswer), signal);
			const ev = r.events;
			const codemodeEnd = ev.find(
				(e) => e.type === "tool_execution_end" && e.toolName === "codemode" && !e.parentToolCallId,
			);
			const agentEnd = ev.find((e) => e.type === "tool_execution_end" && e.toolName === "Agent");
			const settled = ev.find((e) => e.type === "agent_settled");
			const message = ev.find(
				(e) =>
					e.type === "message_end" &&
					e.message.role === "custom" &&
					messageText(e.message).includes("Background script S1"),
			);
			const answer = ev.find(isAnswer);
			return {
				cost: r.cost,
				checks: [
					check(
						"did not time out",
						!r.timedOut,
						ev.map((e) => e.type),
					),
					check(
						"codemode returned 'moved to the background'",
						/moved to the background/.test(messageText({ content: codemodeEnd?.result?.content })),
						codemodeEnd?.result,
					),
					check("main's turn ended while the agent ran", !!settled && !!agentEnd && settled.at < agentEnd.at, {
						settled: settled?.at,
						agentEnd: agentEnd?.at,
					}),
					check(
						"result message arrived with the token",
						!!message && messageText(message.message).includes("TOK-42 completed"),
						message && messageText(message.message),
					),
					check(
						"the message started a new turn",
						!!message &&
							!!settled &&
							ev.slice(0, ev.indexOf(message)).some((e) => e.type === "agent_start" && e.at > settled.at),
						ev.map((e) => e.type),
					),
					check(
						"main's final answer uses the result",
						!!answer && !!message && answer.at > message.at,
						answer && messageText(answer.message),
					),
					parentOnHaiku(r.models),
				],
			};
		},
	},
	{
		name: "isolated agent keeps a worktree only when it changes files",
		kind: "direct",
		async run(signal) {
			const cwd = gitFixture({
				"README.md": "hello\n",
				".claude/agents/scribe.md": agent(
					"name: scribe\ndescription: Writes files\ntools: Write, Read\nisolation: worktree",
					"You do exactly what is asked, then reply DONE.",
				),
			});
			const t = await directTool(cwd, signal);
			const w = await t.call({
				prompt: "Write the file notes.txt with exactly this content: isolated-ok",
				subagent_type: "scribe",
			});
			const ro = await t.call({
				prompt: "Read README.md and reply with its content. Do not write anything.",
				subagent_type: "scribe",
			});
			const wt = w.worktree as { changed: boolean; path?: string; branch?: string; files?: string[] } | undefined;
			const branches = gitOut(cwd, "branch", "--list", "subagent/*");
			const kept = existsSync(join(cwd, ".pi", "worktrees")) ? readdirSync(join(cwd, ".pi", "worktrees")) : [];
			return {
				cost: costOf(w, ro),
				checks: [
					check("both completed", w.status === "completed" && ro.status === "completed", [w.error, ro.error]),
					check(
						"writer: worktree kept with path, branch and files",
						!!wt?.changed && !!wt.path && !!wt.branch && !!wt.files?.includes("notes.txt"),
						wt,
					),
					check("writer: file is in the worktree", !!wt?.path && existsSync(join(wt.path, "notes.txt")), wt),
					check(
						"main checkout untouched",
						!existsSync(join(cwd, "notes.txt")) && gitOut(cwd, "status", "--porcelain") === "",
					),
					check("read-only: nothing kept", ro.worktree?.changed === false, ro.worktree),
					check(
						"only the writer's worktree and branch remain",
						kept.length === 1 &&
							kept[0] === w.agentId &&
							branches.includes(`subagent/${w.agentId}`) &&
							!branches.includes(`subagent/${ro.agentId}`),
						{ kept, branches },
					),
					onHaiku(w, ro),
				],
			};
		},
	},
	{
		name: "agent memory carries a fact across runs",
		kind: "direct",
		async run(signal) {
			const cwd = gitFixture({
				".claude/agents/keeper.md": agent(
					"name: keeper\ndescription: Remembers facts\nmemory: project",
					"You keep facts the user tells you in your persistent memory and answer questions from it.",
				),
			});
			const t = await directTool(cwd, signal);
			const a = await t.call({
				prompt:
					"Remember this for later: the deploy password is PELICAN-77. Save it in your memory, then reply SAVED.",
				subagent_type: "keeper",
			});
			const file = join(cwd, ".claude", "agent-memory", "keeper", "MEMORY.md");
			const saved = existsSync(file) ? readFileSync(file, "utf8") : "";
			// A fresh run (no resume): it can only know the fact from its memory.
			const b = await t.call({
				prompt: "What is the deploy password? Reply with it only.",
				subagent_type: "keeper",
			});
			return {
				cost: costOf(a, b),
				checks: [
					check("both completed", a.status === "completed" && b.status === "completed", [a.error, b.error]),
					check("run 1 wrote MEMORY.md with the fact", saved.includes("PELICAN-77"), saved),
					check("run 2 is a different agent", a.agentId !== b.agentId),
					check("run 2 answers from memory", b.output.includes("PELICAN-77"), b.output),
					onHaiku(a, b),
				],
			};
		},
	},
];
