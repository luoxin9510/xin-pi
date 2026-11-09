// npm run test:subagent:cache -- [--words 1000] [--only types|worktree|memory]
//
// By hand, real haiku: what the provider's prompt cache does with the children's system prompt. Every scenario makes
// a fresh repository whose AGENTS.md starts with a random line, so nothing after the tools can hit an entry of an
// earlier run. Every child answers one word, so its usage is the usage of its first request.
// - types: four agent types with the same tools, one after the other. The first writes the shared head (tools,
//   preamble, project context); the others must read it. A fifth type with other tools shares nothing: tools come first.
// - worktree: one type in the main checkout, in a worktree of it, in the main checkout again.
// - memory: a memory agent twice, then again after a line is added to its MEMORY.md.
// The checks need a project context that is large next to the tail: keep --words at 1000 or more.
// A payload dump (an extension in the temp agent dir) counts the system blocks and the cache breakpoints of every
// request. Prints one line per child and exits 1 when a check fails.

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentResult } from "../../../src/extensions/subagent/agent-tool.ts";
import { directTool, flag, HAIKU, intFlag } from "../evals/harness.ts";

const words = intFlag("--words", 1000);
const only = flag("--only");
const OK = "Reply with the single word OK. Do not call any tool.";
const SHARE = 0.8; // a later child must read at least this part of what the first child sent

// ---- payload dump: one JSON line per provider request of every child ----
const dumpFile = join(mkdtempSync(join(tmpdir(), "subagent-cache-")), "payloads.jsonl");
writeFileSync(dumpFile, "");
process.env.SUBAGENT_CACHE_DUMP = dumpFile;
const extension = join(process.env.XPI_CODING_AGENT_DIR!, "extensions", "payload-dump.ts");
mkdirSync(dirname(extension), { recursive: true });
writeFileSync(
	extension,
	`import { appendFileSync } from "node:fs";
const marked = (blocks) => (Array.isArray(blocks) ? blocks.filter((b) => b && typeof b === "object" && "cache_control" in b).length : 0);
export default function (pi) {
	pi.on("before_provider_request", (event) => {
		const p = event.payload ?? {};
		const system = Array.isArray(p.system) ? p.system : [];
		const messages = (p.messages ?? []).reduce((n, m) => n + marked(m.content), 0);
		appendFileSync(process.env.SUBAGENT_CACHE_DUMP, JSON.stringify({
			system: system.map((b) => ({ chars: (b.text ?? "").length, marked: "cache_control" in b })),
			breakpoints: marked(system) + marked(p.tools) + messages,
		}) + "\\n");
	});
}
`,
);

interface Payload {
	system: { chars: number; marked: boolean }[];
	breakpoints: number;
}
let dumpRead = 0;
function newPayloads(): Payload[] {
	const lines = readFileSync(dumpFile, "utf8").split("\n").filter(Boolean);
	const fresh = lines.slice(dumpRead).map((l) => JSON.parse(l) as Payload);
	dumpRead = lines.length;
	return fresh;
}

// ---- fixtures ----
const VOCABULARY =
	"alpha beta gamma delta kernel buffer socket parser lexer token stream cache index shard queue ring mutex signal handler module bundle loader plugin schema record field vector matrix render layout theme pixel glyph cursor widget panel dialog prompt session branch commit merge rebase stash remote origin tag release deploy rollback metric tracer span probe sample gauge counter timer budget quota limit retry backoff jitter circuit breaker fallback timeout deadline cancel abort resume flush drain".split(
		" ",
	);
const pick = () => VOCABULARY[Math.floor(Math.random() * VOCABULARY.length)];
const nonce = () => Math.random().toString(36).slice(2, 12);

function projectRules(): string {
	const rules = Array.from(
		{ length: Math.ceil(words / 12) },
		(_, i) =>
			`- Rule ${i + 1}: when the ${pick()} ${pick()} meets the ${pick()} ${pick()}, prefer the ${pick()} ${pick()} over the ${pick()} ${pick()}; log ${pick()} ${pick()} and ${pick()} ${pick()}.`,
	);
	return `# Project rules (build ${nonce()})\n\n${rules.join("\n")}\n`;
}

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });

// A real repository with a committed AGENTS.md (a worktree has it too) and nothing uncommitted.
function repository(): string {
	const repo = mkdtempSync(join(tmpdir(), "subagent-cache-repo-"));
	git(repo, "init", "-q");
	writeFileSync(join(repo, "AGENTS.md"), projectRules());
	writeFileSync(join(repo, ".gitignore"), ".pi/\n.claude/\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-q", "-m", "first");
	return repo;
}

// User-level agent files: the temp HOME of the eval harness, so the repository stays clean.
function agent(name: string, body: string, fields = ""): string {
	const file = join(process.env.HOME!, ".claude", "agents", `${name}.md`);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `---\nname: ${name}\ndescription: ${name}\n${fields}---\n${body}\n`);
	return name;
}

// ---- running and reporting ----
interface Row {
	label: string;
	result: AgentResult;
	payloads: Payload[];
}
const failures: string[] = [];
let cost = 0;
const sent = (r: AgentResult) => r.usage.input + r.usage.cacheRead + r.usage.cacheWrite;

async function run(
	tool: Awaited<ReturnType<typeof directTool>>,
	label: string,
	params: Record<string, unknown>,
): Promise<Row> {
	const result = await tool.call({ prompt: OK, ...params });
	const payloads = newPayloads();
	cost += result.usage.cost.total;
	const first = payloads[0];
	const blocks = first ? first.system.map((b) => `${b.chars}${b.marked ? "*" : ""}`).join(" ") : "no payload";
	console.log(
		`  ${label.padEnd(30)} read ${String(result.usage.cacheRead).padStart(6)}  write ${String(result.usage.cacheWrite).padStart(6)}  $${result.usage.cost.total.toFixed(5)}  system [${blocks}] breakpoints ${first?.breakpoints ?? "?"}`,
	);
	if (result.status !== "completed") failures.push(`${label}: status ${result.status} (${result.error ?? ""})`);
	if (result.model !== HAIKU) failures.push(`${label}: ran on ${result.model}`);
	if (result.turns !== 1) failures.push(`${label}: ${result.turns} requests, expected 1`);
	for (const p of payloads) {
		const hinted = p.system.filter((b) => b.marked).length;
		if (hinted !== 2) failures.push(`${label}: ${hinted} marked system blocks, expected 2 (head and tail)`);
		if (p.breakpoints > 4) failures.push(`${label}: ${p.breakpoints} cache breakpoints, the limit is 4`);
	}
	return { label, result, payloads };
}

// `later` must read most of what `first` sent.
function reads(later: Row, first: Row): void {
	const share = later.result.usage.cacheRead / sent(first.result);
	const ok = share >= SHARE;
	console.log(
		`    ${ok ? "ok  " : "FAIL"} ${later.label}: read ${(share * 100).toFixed(0)}% of the ${sent(first.result)} tokens ${first.label} sent`,
	);
	if (!ok) failures.push(`${later.label}: read only ${(share * 100).toFixed(0)}% of ${first.label}'s prompt`);
}

const controller = new AbortController();
const wanted = (name: string) => !only || only === name;

if (wanted("types")) {
	console.log("types: four agent types with the same tools, then one with other tools");
	const repo = repository();
	const tool = await directTool(repo, controller.signal);
	const names = [
		agent("cache-a", "You are a reviewer agent. Review code for defects and report them tersely."),
		agent("cache-b", "You are a test-writing agent. Propose tests for the code you are shown, tersely."),
		agent("cache-c", "You are a docs agent. Summarise modules in one paragraph each."),
		agent("cache-d", "You are a planning agent. Break a task into ordered steps."),
	];
	const rows: Row[] = [];
	for (const name of names) rows.push(await run(tool, name, { subagent_type: name }));
	for (const row of rows.slice(1)) reads(row, rows[0]);
	const other = agent("cache-e", "You are a read-only agent with a narrow tool set.", "tools: Read, Bash\n");
	await run(tool, `${other} (other tools)`, { subagent_type: other });
}

if (wanted("worktree")) {
	console.log("worktree: main checkout, a worktree of it, main checkout again");
	const repo = repository();
	const tool = await directTool(repo, controller.signal);
	const name = agent("cache-w", "You are a reviewer agent. Review code for defects.");
	const main = await run(tool, "main checkout", { subagent_type: name });
	const isolated = await run(tool, "worktree", { subagent_type: name, isolation: "worktree" });
	if (!isolated.result.worktree) failures.push("worktree: the child did not run in a worktree");
	reads(isolated, main);
	reads(await run(tool, "main checkout again", { subagent_type: name }), main);
}

if (wanted("memory")) {
	console.log("memory: a memory agent twice, then after a line is added to MEMORY.md");
	const repo = repository();
	const tool = await directTool(repo, controller.signal);
	const name = agent("cache-m", "You are a memory-keeping agent.", "memory: project\n");
	const memory = join(repo, ".claude", "agent-memory", name, "MEMORY.md");
	mkdirSync(dirname(memory), { recursive: true });
	writeFileSync(
		memory,
		Array.from({ length: 12 }, (_, i) => `- [topic ${i}](topic-${i}.md): note ${nonce()} about ${pick()}`).join("\n"),
	);
	const first = await run(tool, "memory, first run", { subagent_type: name });
	reads(await run(tool, "memory, unchanged", { subagent_type: name }), first);
	if (!existsSync(memory)) failures.push("memory: MEMORY.md is gone");
	appendFileSync(memory, `\n- [new](new.md): learned ${nonce()}\n`);
	reads(await run(tool, "memory, one line added", { subagent_type: name }), first);
}

console.log(`\ncost $${cost.toFixed(4)}`);
if (failures.length > 0) {
	console.log(`\n${failures.length} failed:`);
	for (const f of failures) console.log(`  ✗ ${f}`);
	process.exit(1);
}
console.log("all checks passed");
process.exit(0);
