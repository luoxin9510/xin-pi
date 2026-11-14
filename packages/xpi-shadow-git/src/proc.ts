import { spawnSync } from "node:child_process";

export interface RunResult {
	status: number;
	stdout: string;
	stderr: string;
	/** Set when the program could not be started. */
	spawnError?: NodeJS.ErrnoException;
}

export interface RunOptions {
	cwd: string;
	env: NodeJS.ProcessEnv;
	input?: string;
	/** `inherit` hands the terminal to the program; its output is then not captured. */
	stdio?: "pipe" | "inherit";
}

/** Run a program to the end. A signal or a spawn failure is a non-zero status. */
export function run(file: string, args: string[], options: RunOptions): RunResult {
	const result = spawnSync(file, args, {
		cwd: options.cwd,
		env: options.env,
		input: options.input,
		encoding: "utf8",
		maxBuffer: 512 * 1024 * 1024,
		stdio:
			options.stdio === "inherit" ? "inherit" : [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
	});
	return {
		status: result.status ?? 1,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		spawnError: result.error,
	};
}
