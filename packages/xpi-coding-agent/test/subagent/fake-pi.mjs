#!/usr/bin/env node
// Scripted stand-in for `pi --mode rpc`.
// FAKE_PI_SCENARIO: path to JSON { lines: string[] (raw stdout lines), exitCode?, stderr?, delayMs?, hang?, sessionFile?,
//   promptError?: string (answer the prompt command with success: false), abortSettles?: boolean (answer rpc abort with
//   agent_settled aborted: true, writeFile?: string (a file name to create in the child's cwd when the prompt arrives),
//   logFile?: string (append "start" when the process starts and "line <n>" before each line: the order of events
//   across several children), hold?: { line, starts } (before that line, wait until the log has that many "start"
//   entries, at most 4 s: siblings that should run at the same time are seen to, however slow the machine),
//   reply?: string[] (lines for a second prompt: the child stays up after `lines` and plays these when one comes),
//   takeSteers?: boolean (answer a steer command with a user message_end carrying its text),
//   byPrompt?: { [text]: string[] } (lines to play instead of `lines` when the prompt contains that text; first match) }
// Like pi, it waits for a `prompt` command on stdin, answers it with a response, then plays the lines. Without `hang` it
// exits after the lines; with `hang` it stays up and ignores stdin closing.
// FAKE_PI_RECORD: path where argv, XPI_SUBAGENT_DEPTH, the system prompt head and tail texts, the schema file's content
// (XPI_SUBAGENT_SCHEMA_FILE), the shadow-git variables (XPI_SG_SANDBOX, XPI_SG_BACKEND, XPI_SG_STORE, GIT_DIR, GIT_WORK_TREE)
// and the commands received are written as JSON.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const scenario = JSON.parse(readFileSync(process.env.FAKE_PI_SCENARIO, "utf8"));
const log = (text) => scenario.logFile && appendFileSync(scenario.logFile, `${text}\n`);
log("start");
const sp = argv.indexOf("--system-prompt");
const spTail = argv.indexOf("--system-prompt-tail");
const commands = [];
const record = () =>
  writeFileSync(
    process.env.FAKE_PI_RECORD,
    JSON.stringify({
      argv,
      depth: process.env.XPI_SUBAGENT_DEPTH,
      team: {
        XPI_TEAM: process.env.XPI_TEAM,
        XPI_TEAM_MEMBER: process.env.XPI_TEAM_MEMBER,
        XPI_TEAM_DIR: process.env.XPI_TEAM_DIR,
        XPI_TEAM_TOOLS: process.env.XPI_TEAM_TOOLS,
      },
      env: Object.fromEntries(
        ["XPI_SG_SANDBOX", "XPI_SG_BACKEND", "XPI_SG_STORE", "GIT_DIR", "GIT_WORK_TREE"].map((name) => [name, process.env[name]]),
      ),
      commands,
      cwd: process.cwd(),
      systemPrompt: sp === -1 ? undefined : readFileSync(argv[sp + 1], "utf8"),
      systemPromptTail: spTail === -1 ? undefined : readFileSync(argv[spTail + 1], "utf8"),
      schema: process.env.XPI_SUBAGENT_SCHEMA_FILE ? readFileSync(process.env.XPI_SUBAGENT_SCHEMA_FILE, "utf8") : undefined,
    }),
  );
record();
if (scenario.sessionFile) {
  mkdirSync(dirname(scenario.sessionFile), { recursive: true });
  writeFileSync(scenario.sessionFile, "");
}
if (scenario.stderr) process.stderr.write(scenario.stderr);

// Process-tree scenario knobs: grandchildPidFile (spawn `sleep 60`, write its pid there), pidFile (own pid),
// termDelayMs (on SIGTERM wait that long, write cleanFile, then exit; -1 = ignore SIGTERM for ever).
import { spawn } from "node:child_process";
if (scenario.pidFile) writeFileSync(scenario.pidFile, String(process.pid));
if (scenario.grandchildPidFile) {
  const gc = spawn("sleep", ["60"], { stdio: "ignore" });
  gc.unref();
  writeFileSync(scenario.grandchildPidFile, String(gc.pid));
}
if (scenario.termDelayMs !== undefined) {
  process.on("SIGTERM", () => {
    if (scenario.termDelayMs < 0) return;
    setTimeout(() => {
      if (scenario.cleanFile) writeFileSync(scenario.cleanFile, "clean\n");
      process.exit(0);
    }, scenario.termDelayMs);
  });
}

const out = (o) => process.stdout.write((typeof o === "string" ? o : JSON.stringify(o)) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let played = false;
let replied = false;

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", async (line) => {
  const cmd = JSON.parse(line);
  commands.push(cmd);
  record();
  if (cmd.type === "abort") {
    out({ id: cmd.id, type: "response", command: "abort", success: true });
    if (scenario.abortSettles) out({ type: "agent_settled", aborted: true });
    return;
  }
  if (cmd.type === "steer") {
    out({ id: cmd.id, type: "response", command: "steer", success: true, data: { disposition: "queued" } });
    // takeSteers: the child reads the steer at once, as a running pi does between steps
    if (scenario.takeSteers) out({ type: "message_end", message: { role: "user", content: cmd.message } });
    return;
  }
  if (cmd.type === "set_model") {
    out({ id: cmd.id, type: "response", command: "set_model", success: true, data: {} });
    return;
  }
  if (cmd.type === "prompt" && played && scenario.reply && !replied) {
    replied = true;
    out({ id: cmd.id, type: "response", command: "prompt", success: true, data: { disposition: "started" } });
    for (const l of scenario.reply) {
      out(l);
      if (scenario.delayMs) await sleep(scenario.delayMs);
    }
    process.exit(scenario.exitCode ?? 0);
  }
  if (cmd.type !== "prompt" || played) return;
  played = true;
  if (scenario.writeFile) writeFileSync(scenario.writeFile, "written by the fake child\n"); // relative to the child's cwd
  if (scenario.promptError) {
    out({ id: cmd.id, type: "response", command: "prompt", success: false, error: scenario.promptError });
  } else {
    out({ id: cmd.id, type: "response", command: "prompt", success: true, data: { disposition: "started" } });
  }
  const lines =
    Object.entries(scenario.byPrompt ?? {}).find(([text]) => String(cmd.message).includes(text))?.[1] ?? scenario.lines;
  const starts = () => readFileSync(scenario.logFile, "utf8").split("\n").filter((entry) => entry === "start").length;
  for (const [n, l] of lines.entries()) {
    if (scenario.hold?.line === n) {
      for (let waited = 0; starts() < scenario.hold.starts && waited < 4000; waited += 20) await sleep(20);
    }
    log(`line ${n}`);
    out(l);
    if (scenario.delayMs) await sleep(scenario.delayMs);
  }
  if (scenario.hang) setInterval(() => {}, 1000);
  else if (scenario.reply) setTimeout(() => process.exit(3), 10_000); // waits for the second prompt
  else process.exit(scenario.exitCode ?? 0);
});
