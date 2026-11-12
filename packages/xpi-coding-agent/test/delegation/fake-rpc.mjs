#!/usr/bin/env node
// Scripted stand-in for `xpi --mode rpc`, for the rpc driver's offline test (rpc-driver.test.ts).
// FAKE_RPC_SCENARIO: JSON { steps: Step[], exitCode? } played once the prompt command arrives. A step is
// { wait: ms } | { out: object } (one stdout line) | { meta: { path, status } } (write a child meta file)
// | { child: ms } (start a process with "--mode rpc" in its command line that lives that long) | { exit: code }.
// FAKE_RPC_RECORD: where the commands received are written, as JSON lines.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { createInterface } from "node:readline";

const scenario = JSON.parse(process.env.FAKE_RPC_SCENARIO);
const out = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const play = async () => {
	for (const step of scenario.steps) {
		if ("wait" in step) await new Promise((resolve) => setTimeout(resolve, step.wait));
		else if ("out" in step) out(step.out);
		else if ("meta" in step) {
			mkdirSync(dirname(step.meta.path), { recursive: true });
			writeFileSync(step.meta.path, JSON.stringify({ status: step.meta.status }));
		} else if ("child" in step)
			spawn(process.execPath, ["-e", `setTimeout(() => {}, ${step.child})`, "--", "--mode", "rpc"], { stdio: "ignore" });
		else if ("exit" in step) process.exit(step.exit);
	}
};
let started = false;
createInterface({ input: process.stdin }).on("line", (line) => {
	if (process.env.FAKE_RPC_RECORD) appendFileSync(process.env.FAKE_RPC_RECORD, `${line}\n`);
	const command = JSON.parse(line);
	if (command.type === "prompt" && !started) {
		started = true;
		out({ id: command.id, type: "response", command: "prompt", success: true });
		void play();
	}
});
setInterval(() => {}, 1 << 30); // stays up until it is stopped, like xpi in rpc mode
